// Cooperative protocol: ../PORT_RESERVATION.md. C# 5 / Windows PowerShell 5.1.
// This helper owns the mutex for the ENTIRE transaction, not just individual IO.
using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Collections.Generic;
using System.ComponentModel;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Threading;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

namespace FirefoxMcp {
    public sealed class PortFailure : Exception {
        public string Code;
        public PortFailure(string code, string message) : base(message) { Code = code; }
    }
    public static class PortReservation {
        const string App = "FirefoxMCP:http";
        const string MutexName = @"Global\h5uPortReservation.v1";
        const int MaxBytes = 4 * 1024 * 1024, MaxLines = 65536;
        const uint ReadControl = 0x20000, WriteDac = 0x40000, Read = 0x80000000, Write = 0x40000000;
        const uint OpenExisting = 3, CreateNew = 1, OpenReparse = 0x200000, BackupSemantics = 0x2000000;
        const uint Reparse = 0x400, DirectoryAttribute = 0x10;
        static readonly UTF8Encoding Utf8 = new UTF8Encoding(false, true);
        [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int Size; public IntPtr Descriptor; public int Inherit; }
        [StructLayout(LayoutKind.Sequential)] struct FileInfo {
            public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME Creation, Access, Written;
            public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
        }
        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint length);
        [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityInfo(SafeFileHandle handle, uint kind, uint information, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
        [DllImport("advapi32.dll", SetLastError = true)] static extern uint SetSecurityInfo(SafeFileHandle handle, uint kind, uint information, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
        [DllImport("advapi32.dll", SetLastError = true)] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
        [DllImport("advapi32.dll", SetLastError = true)] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
        [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateMutexExW(ref SecurityAttributes attributes, string name, uint flags, uint access);
        [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReleaseMutex(IntPtr handle);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, ref SecurityAttributes attributes, uint creation, uint flags, IntPtr template);
        [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateDirectoryW(string path, ref SecurityAttributes attributes);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileExW(string from, string to, uint flags);
        [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);

        static PortFailure Fail(string code, string message) { return new PortFailure(code, message); }
        static void WinError() { throw new Win32Exception(Marshal.GetLastWin32Error()); }
        static SecurityAttributes Security(string sddl) {
            IntPtr sd; uint length;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out length)) WinError();
            return new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = sd };
        }
        static string DefaultDirectory() {
            Guid id = new Guid("62AB5D82-FDC1-4DC3-A9DD-070D1D495D97"); IntPtr path;
            int error = SHGetKnownFolderPath(ref id, 0, IntPtr.Zero, out path);
            if (error != 0) Marshal.ThrowExceptionForHR(error);
            try { return Path.Combine(Marshal.PtrToStringUni(path), "h5uPortReservation"); }
            finally { Marshal.FreeCoTaskMem(path); }
        }
        static bool IsServer() {
            using (RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Control\ProductOptions")) {
                string type = key == null ? null : key.GetValue("ProductType") as string;
                if (type == null) throw Fail("WINDOWS_PRODUCT_UNKNOWN", "Windows product type could not be determined.");
                return !String.Equals(type, "WinNT", StringComparison.OrdinalIgnoreCase);
            }
        }
        // Hold ordinary directory entries open without DELETE sharing. This also
        // prevents a writable ancestor being swapped while paths are being used.
        static void HoldParents(string path, List<SafeFileHandle> handles) {
            string parent = Path.GetDirectoryName(path);
            if (parent != null && parent.Length > Path.GetPathRoot(path).Length) HoldParents(parent, handles);
            SafeFileHandle handle = CreateFileW(path, ReadControl, 3, IntPtr.Zero, OpenExisting, BackupSemantics | OpenReparse, IntPtr.Zero);
            if (handle.IsInvalid) { int error = Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
            try {
                FileInfo info;
                if (!GetFileInformationByHandle(handle, out info)) WinError();
                if ((info.Attributes & Reparse) != 0 || (info.Attributes & DirectoryAttribute) == 0) throw Fail("UNSAFE_PORT_PATH", "Port directory has a reparse point or unexpected type.");
                handles.Add(handle);
            } catch { handle.Dispose(); throw; }
        }
        sealed class Snapshot {
            public string Path, Owner, Text;
            public byte[] Bytes, Security;
            public FileInfo Info;
        }
        static Snapshot ReadFile(string path) {
            SafeFileHandle handle = CreateFileW(path, Read | ReadControl, 1, IntPtr.Zero, OpenExisting, OpenReparse, IntPtr.Zero);
            if (handle.IsInvalid) {
                int error = Marshal.GetLastWin32Error(); handle.Dispose();
                if (error == 2) return null;
                throw new Win32Exception(error);
            }
            using (handle) {
                FileInfo info;
                if (!GetFileInformationByHandle(handle, out info)) WinError();
                if ((info.Attributes & (Reparse | DirectoryAttribute)) != 0 || info.Links != 1 || info.SizeHigh != 0 || info.SizeLow > MaxBytes) throw Fail("UNSAFE_PORT_FILE", "Port file is linked, too large or not an ordinary file: " + Path.GetFileName(path));
                IntPtr owner, group, dacl, sacl, sd;
                uint error = GetSecurityInfo(handle, 1, 5, out owner, out group, out dacl, out sacl, out sd);
                if (error != 0) throw new Win32Exception((int)error);
                Snapshot file = new Snapshot { Path = path, Info = info };
                try {
                    file.Owner = new SecurityIdentifier(owner).Value;
                    file.Security = new byte[GetSecurityDescriptorLength(sd)];
                    Marshal.Copy(sd, file.Security, 0, file.Security.Length);
                } finally { LocalFree(sd); }
                using (FileStream stream = new FileStream(handle, FileAccess.Read)) {
                    file.Bytes = new byte[info.SizeLow]; int offset = 0;
                    while (offset < file.Bytes.Length) { int count = stream.Read(file.Bytes, offset, file.Bytes.Length - offset); if (count == 0) throw Fail("PORT_FILE_CHANGED", "Port file was truncated."); offset += count; }
                    if (stream.ReadByte() != -1) throw Fail("PORT_FILE_CHANGED", "Port file grew during reading.");
                }
                file.Text = Utf8.GetString(file.Bytes);
                return file;
            }
        }
        static string[] Lines(string text) {
            if (text.StartsWith("\uFEFF", StringComparison.Ordinal)) text = text.Substring(1);
            string[] lines = text.Replace("\r\n", "\n").Split('\n');
            if (lines.Length > MaxLines) throw Fail("INVALID_PORT_FILE", "Port file exceeds the line limit.");
            return lines;
        }
        sealed class Entry { public int Port; public string App, Sid; }
        sealed class Inventory {
            public List<Entry> Entries = new List<Entry>(); public Snapshot Own; public string OwnPath;
        }
        static Inventory ReadInventory(string root, string sid) {
            Inventory result = new Inventory(); HashSet<int> ports = new HashSet<int>(); HashSet<string> sids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (string path in Directory.GetFileSystemEntries(root)) {
                string name = Path.GetFileName(path);
                if (name.StartsWith(".", StringComparison.Ordinal)) continue;
                Match user = Regex.Match(name, @"^(S-1-\d+(?:-\d+)+)_.+$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                if (!user.Success) throw Fail("INVALID_PORT_FILE", "Unrecognized user file: " + name);
                string userSid = new SecurityIdentifier(user.Groups[1].Value).Value;
                if (!sids.Add(userSid)) throw Fail("DUPLICATE_PORT_USER", "Multiple port files exist for a SID.");
                Snapshot file = ReadFile(path);
                if (file == null) throw Fail("PORT_FILE_CHANGED", "User file disappeared during reading.");
                if (userSid == sid) {
                    if (file.Owner != sid) throw Fail("PORT_FILE_OWNER", "The current user's port file belongs to another Windows account.");
                    result.Own = file; result.OwnPath = path;
                }
                foreach (string line in Lines(file.Text)) {
                    if (String.IsNullOrWhiteSpace(line) || line.TrimStart().StartsWith("#", StringComparison.Ordinal)) continue;
                    Match match = Regex.Match(line, @"^([0-9]{1,5})\t([A-Za-z0-9_.:\-]+)$", RegexOptions.CultureInvariant);
                    int port;
                    if (!match.Success || !Int32.TryParse(match.Groups[1].Value, out port) || port < 1 || port > 65535) throw Fail("INVALID_PORT_FILE", "Invalid port entry in " + name);
                    if (!ports.Add(port)) throw Fail("DUPLICATE_PORT", "A port occurs more than once in the shared inventory: " + port);
                    result.Entries.Add(new Entry { Port = port, App = match.Groups[2].Value, Sid = userSid });
                }
            }
            return result;
        }
        static bool Equal(byte[] first, byte[] second) {
            if (first.Length != second.Length) return false;
            for (int i = 0; i < first.Length; i++) if (first[i] != second[i]) return false;
            return true;
        }
        static void Unchanged(string target, Snapshot before) {
            Snapshot current = ReadFile(target);
            if (before == null ? current != null : current == null || current.Owner != before.Owner || current.Info.Volume != before.Info.Volume || current.Info.IndexHigh != before.Info.IndexHigh || current.Info.IndexLow != before.Info.IndexLow || !Equal(current.Bytes, before.Bytes) || !Equal(current.Security, before.Security)) throw Fail("PORT_FILE_CHANGED", "Port file changed before it could be replaced.");
        }
        static void Publish(string root, string target, Snapshot before, string text, string sid) {
            byte[] bytes = Utf8.GetBytes(text);
            if (bytes.Length > MaxBytes || Lines(text).Length > MaxLines) throw Fail("INVALID_PORT_FILE", "Updated port file exceeds its limits.");
            string temp = Path.Combine(root, ".tmp-" + Guid.NewGuid().ToString("D"));
            SecurityAttributes security = Security("O:" + sid + "D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;" + sid + ")(A;;FR;;;AU)S:(ML;;NW;;;ME)");
            bool created = false;
            try {
                SafeFileHandle handle = CreateFileW(temp, Read | Write | ReadControl | WriteDac, 0, ref security, CreateNew, OpenReparse, IntPtr.Zero);
                if (handle.IsInvalid) { handle.Dispose(); WinError(); }
                created = true;
                using (handle) {
                    if (before != null) {
                        GCHandle pinned = GCHandle.Alloc(before.Security, GCHandleType.Pinned);
                        try {
                            bool present, defaulted; IntPtr dacl;
                            if (!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(), out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero) throw Fail("UNSAFE_PORT_ACL", "Existing file has no usable DACL.");
                            RawSecurityDescriptor previous = new RawSecurityDescriptor(before.Security, 0);
                            uint protection = (previous.ControlFlags & ControlFlags.DiscretionaryAclProtected) != 0 ? 0x80000000u : 0x20000000u;
                            uint error = SetSecurityInfo(handle, 1, 4 | protection, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero);
                            if (error != 0) throw new Win32Exception((int)error);
                        } finally { pinned.Free(); }
                    }
                    using (FileStream stream = new FileStream(handle, FileAccess.Write)) { stream.Write(bytes, 0, bytes.Length); stream.Flush(true); }
                }
                for (int attempt = 0; ; attempt++) {
                    Unchanged(target, before);
                    if (MoveFileExW(temp, target, before == null ? 8u : 9u)) { created = false; break; }
                    int error = Marshal.GetLastWin32Error();
                    if (attempt >= 4 || (error != 5 && error != 32 && error != 33)) throw new Win32Exception(error);
                    Thread.Sleep(50 * (attempt + 1));
                }
            } finally { LocalFree(security.Descriptor); if (created) File.Delete(temp); }
        }
        static void CreateRoot(string root) {
            // AU: read/list/traverse + create files; no DELETE_CHILD/create subdirs.
            SecurityAttributes security = Security("O:" + WindowsIdentity.GetCurrent().User.Value + "D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x001200ab;;;AU)(A;OICIIO;FA;;;CO)S:(ML;;NW;;;ME)");
            try { if (!CreateDirectoryW(root, ref security) && Marshal.GetLastWin32Error() != 183) WinError(); }
            finally { LocalFree(security.Descriptor); }
        }
        static bool Available(int port) {
            using (Socket socket = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp)) {
                socket.ExclusiveAddressUse = true;
                try { socket.Bind(new IPEndPoint(IPAddress.Loopback, port)); return true; }
                catch (SocketException error) {
                    if (error.SocketErrorCode == SocketError.AddressAlreadyInUse || error.SocketErrorCode == SocketError.AccessDenied) return false;
                    throw;
                }
            }
        }
        static int[] OwnPorts(Inventory inventory, string sid) {
            List<int> ports = new List<int>(); foreach (Entry entry in inventory.Entries) if (entry.Sid == sid && entry.App == App) ports.Add(entry.Port);
            ports.Sort(); return ports.ToArray();
        }
        static void AssertPort(Inventory inventory, string sid, int port) {
            foreach (Entry entry in inventory.Entries) if (entry.Port == port && (entry.Sid != sid || entry.App != App)) throw Fail("PORT_RESERVED", "Port " + port + " is reserved by another user or application (" + entry.App + "). Select another port explicitly.");
        }
        static int[] Range(string root) {
            Snapshot description = ReadFile(Path.Combine(root, ".FirefoxMCP"));
            if (description == null) return new int[] { 38477, 100 };
            Dictionary<string, string> fields = new Dictionary<string, string>(StringComparer.Ordinal);
            string[] lines = Lines(description.Text);
            for (int i = 1; i < lines.Length; i++) {
                if (String.IsNullOrWhiteSpace(lines[i]) || lines[i].TrimStart().StartsWith("#", StringComparison.Ordinal)) continue;
                int equals = lines[i].IndexOf('=');
                if (equals < 1 || fields.ContainsKey(lines[i].Substring(0, equals))) throw Fail("INVALID_PORT_DESCRIPTION", "Invalid .FirefoxMCP description.");
                fields.Add(lines[i].Substring(0, equals), lines[i].Substring(equals + 1));
            }
            string schema, start, count; int first, length;
            if (!fields.TryGetValue("Schema", out schema) || schema != "1" || !fields.TryGetValue("StartPort", out start) || !fields.TryGetValue("MaxAnzahl", out count) || !Int32.TryParse(start, out first) || !Int32.TryParse(count, out length) || first < 1024 || length < 1 || (long)first + length - 1 > 65535) throw Fail("INVALID_PORT_DESCRIPTION", "Unsupported .FirefoxMCP schema or range.");
            return new int[] { first, length };
        }
        public static Dictionary<string, object> Run(string action, int port, string directory) {
            if (!new List<string> { "status", "init", "check", "prepare", "suggest", "reserve", "release" }.Contains(action)) throw Fail("INVALID_PORT_ACTION", "Unknown port action.");
            if (new List<string> { "check", "prepare", "reserve", "release" }.Contains(action) && (port < 1024 || port > 65535)) throw Fail("INVALID_PORT", "Port must be between 1024 and 65535.");
            string root = String.IsNullOrEmpty(directory) ? DefaultDirectory() : directory;
            if (!Path.IsPathRooted(root) || root.StartsWith(@"\\", StringComparison.Ordinal) || Path.GetFullPath(root).TrimEnd('\\') == Path.GetPathRoot(root).TrimEnd('\\')) throw Fail("INVALID_PORT_DIRECTORY", "Port directory must be an absolute local directory below a drive root.");
            root = Path.GetFullPath(root).TrimEnd('\\');
            string sid = WindowsIdentity.GetCurrent().User.Value;
            Dictionary<string, object> result = new Dictionary<string, object> { { "supported", true }, { "directory", root }, { "windowsServer", IsServer() }, { "changed", false }, { "ownPorts", new int[0] }, { "port", port } };
            SecurityAttributes security = Security("D:P(A;;0x00100001;;;AU)(A;;GA;;;SY)(A;;GA;;;BA)S:(ML;;NW;;;ME)");
            IntPtr mutex = IntPtr.Zero; bool locked = false; List<SafeFileHandle> parents = new List<SafeFileHandle>();
            try {
                mutex = CreateMutexExW(ref security, MutexName, 0, 0x00100001);
                if (mutex == IntPtr.Zero) WinError();
                uint wait = WaitForSingleObject(mutex, 10000);
                if (wait == 258) throw Fail("PORT_RESERVATION_BUSY", "Shared port management is busy (10 second timeout).");
                if (wait != 0 && wait != 0x80) WinError();
                locked = true; // WAIT_ABANDONED also requires a fresh, full read below.
                HoldParents(Path.GetDirectoryName(root), parents);
                uint attributes;
                try { attributes = (uint)File.GetAttributes(root); }
                catch (FileNotFoundException) { attributes = UInt32.MaxValue; }
                catch (DirectoryNotFoundException) { attributes = UInt32.MaxValue; }
                bool exists = attributes != UInt32.MaxValue;
                if (!exists && (action == "init" || action == "reserve")) { CreateRoot(root); exists = true; result["changed"] = true; }
                result["exists"] = exists;
                if (!exists) {
                    if (action == "suggest") {
                        for (int candidate = port >= 1024 ? port : 38477; candidate <= 65535; candidate++) if (Available(candidate)) { result["port"] = candidate; return result; }
                        throw Fail("NO_FREE_PORT", "No free port was found.");
                    }
                    return result;
                }
                HoldParents(root, parents);
                Inventory inventory = ReadInventory(root, sid);
                result["ownPorts"] = OwnPorts(inventory, sid); result["entries"] = inventory.Entries.Count;
                int[] range = Range(root);
                if (action == "init" || action == "reserve") {
                    string descriptionPath = Path.Combine(root, ".FirefoxMCP");
                    if (ReadFile(descriptionPath) == null) { Publish(root, descriptionPath, null, "Firefox MCP\r\nSchema=1\r\nStartPort=38477\r\nMaxAnzahl=100\r\nProtokoll=TCP\r\nBindAdresse=127.0.0.1\r\n", sid); result["changed"] = true; }
                }
                if (action == "status" || action == "init") return result;
                if (action == "suggest") {
                    bool described = ReadFile(Path.Combine(root, ".FirefoxMCP")) != null;
                    int start = described ? range[0] : (port >= 1024 ? port : 38477), end = described ? range[0] + range[1] - 1 : 65535;
                    HashSet<int> reserved = new HashSet<int>(); foreach (Entry entry in inventory.Entries) reserved.Add(entry.Port);
                    for (int candidate = start; candidate <= end; candidate++) if (!reserved.Contains(candidate) && Available(candidate)) { result["port"] = candidate; return result; }
                    throw Fail("NO_FREE_PORT", "No free port in the preferred range.");
                }
                if (action != "release") AssertPort(inventory, sid, port);
                if (action == "check") return result;
                bool ownPort = false; foreach (Entry entry in inventory.Entries) if (entry.Port == port && entry.Sid == sid && entry.App == App) ownPort = true;
                bool reserve = action == "reserve" || action == "prepare" && ((int[])result["ownPorts"]).Length > 0;
                if (action == "release" ? !ownPort : !reserve || ownPort) return result;
                if (reserve && !Available(port)) throw Fail("PORT_IN_USE", "Port " + port + " cannot be bound exclusively. Select another port or stop the conflicting program before the first reservation.");
                string target = inventory.OwnPath;
                if (target == null) {
                    string name = WindowsIdentity.GetCurrent().Name; int slash = name.LastIndexOf('\\'); if (slash >= 0) name = name.Substring(slash + 1);
                    foreach (char invalid in Path.GetInvalidFileNameChars()) name = name.Replace(invalid, '_');
                    target = Path.Combine(root, sid + "_" + (name.Length == 0 ? "User" : name));
                }
                string text = inventory.Own == null ? "# Benutzer: " + WindowsIdentity.GetCurrent().Name + "\r\n" : inventory.Own.Text;
                if (action == "release") {
                    // Preserve every other line and its original line endings/BOM.
                    bool bom = text.StartsWith("\uFEFF", StringComparison.Ordinal);
                    text = (bom ? "\uFEFF" : "") + Regex.Replace(bom ? text.Substring(1) : text, @"(?m)^0*" + port + "\tFirefoxMCP:http\r?(?:\n|$)", "");
                } else {
                    if (text.Length > 0 && !text.EndsWith("\n", StringComparison.Ordinal)) text += "\r\n";
                    text += port + "\t" + App + "\r\n";
                }
                Publish(root, target, inventory.Own, text, sid);
                result["changed"] = true; result["ownPorts"] = OwnPorts(ReadInventory(root, sid), sid);
                return result;
            } finally {
                for (int i = parents.Count - 1; i >= 0; i--) parents[i].Dispose();
                if (locked) ReleaseMutex(mutex);
                if (mutex != IntPtr.Zero) CloseHandle(mutex);
                LocalFree(security.Descriptor);
            }
        }
    }
}
