# Internal bridge protocol

Extension ID: `firefox-codex-mcp@local.invalid`. Native application: `de.codex.firefox_bridge`.

Firefox extension <-> Node native host: length-prefixed UTF-8 JSON (4-byte native-endian length, Firefox Native Messaging). Extension sends `{type:"ready",version:"0.1.1"}` after handlers are ready. Host sends `{type:"connected"}` when its HTTP listener is ready. Requests: `{id:string,method:string,params:object,expiresAt:number}`; expiry is epoch milliseconds and prevents a queued request from starting after its caller timed out. Responses: `{id,result}` or `{id,error:{code,message,details?}}`. No arbitrary JavaScript evaluation or command execution. Native packets capped at 900,000 bytes.

Codex <-> MCP process uses SDK stdio. MCP -> native host uses authenticated HTTP POST `/rpc` on `127.0.0.1` only, with JSON `{method,params}`. Native host replies `{result}` or `{error:{code,message,details?}}`. GET `/health` is authenticated too. Config JSON contains `{port:38477,token:"<64 hex chars>"}`. Both processes accept `--config <absolute path>`. Host dies on Firefox stdin EOF. No automatic retry of mutations.

Method contract (MCP tool names have `firefox_` prefix):

| Method | Parameters |
| --- | --- |
| status | {} |
| get_current | {} |
| list_windows | {populate?:boolean} |
| list_extensions | {enabled?:boolean,type?:"extension"\|"theme"\|"all",limit?:integer,offset?:integer} |
| list_tabs | {windowId?:integer,active?:boolean,audible?:boolean,muted?:boolean,discarded?:boolean,groupId?:integer,limit?:integer,offset?:integer} |
| get_tabs | {tabIds:integer[]} |
| create_tab | {url?:string,windowId?:integer,active?:boolean,pinned?:boolean,index?:integer} |
| update_tab | {tabId:integer,url?:string,active?:boolean,pinned?:boolean,muted?:boolean} |
| set_muted | {tabIds:integer[],muted:boolean} |
| close_tabs | {tabIds:integer[]} |
| move_tabs | {tabIds:integer[],windowId?:integer,index:integer} |
| discard_tabs | {tabIds:integer[]} |
| reload_tabs | {tabIds:integer[],bypassCache?:boolean} |
| create_window | {url?:string[],tabId?:integer,focused?:boolean,incognito?:boolean} |
| update_window | {windowId:integer,focused?:boolean,state?:"normal"|"minimized"|"maximized"|"fullscreen"} |
| close_window | {windowId:integer} |
| list_groups | {windowId?:integer} |
| group_tabs | {tabIds:integer[],groupId?:integer,windowId?:integer,title?:string,color?:string,collapsed?:boolean} |
| ungroup_tabs | {tabIds:integer[]} |
| update_group | {groupId:integer,title?:string,color?:string,collapsed?:boolean} |
| move_group | {groupId:integer,windowId?:integer,index:integer} |
| read_content | {tabId:integer,format?:"text"|"html",selector?:string,maxChars?:integer,includeLinks?:boolean} |

List tabs returns `{tabs,total,offset,limit}` (default 100, max 500). Lists and content must keep packet size below cap with explicit truncation reporting. read_content default 30,000 / max 100,000 chars, main frame only; content is untrusted page data. Does not wake discarded tabs implicitly. Batch mutation result `{results:[{tabId,result}|{tabId,error}],partialFailure:boolean}`; IDs validated before execution. URLs HTTP(S) or `about:blank` only for navigation. Unknown fields/methods rejected at MCP layer; extension validates mutations defensively.

Content settings retain `contentMode:"deny"|"allow"|"ask-every-time"|"ask-session"` and `contentScope:"active"|"all"`; defaults are `ask-session` and `active`. With active scope, the selected mode applies to the active tab of the last-focused normal window. Reading another loaded tab requests approval directly, without activating it. The internal popup request identifies `{id,tabId,url,title,mode,scope,expiresAt}` with `scope:"tab"` for this case. In session mode that approval grants only the exact tab ID and URL for a fixed 12 hours from acceptance, independently from the active-tab session. In allow/every-time modes the tab request uses `mode:"ask-every-time"` and grants only that read. Deny mode blocks every read. All scope retains its existing global mode/session behavior. Every approval has a two-minute response deadline; settings changes and extension/Firefox restart revoke session grants. URL-change, discard and tab-removal events revoke that tab's grants and invalidate authorization still in progress, even if the tab returns to its original URL. Target URL and applicable authorization are checked again after approval and after reading; a changed URL cannot inherit a grant.

The toolbar button for resetting temporary approvals sends the internal extension-only message `{type:"bridge_reset_approvals"}`. It clears every active/all session and exact-tab grant, denies a pending approval, invalidates authorization of reads still in progress, and returns the updated popup state without changing content settings. This message is accepted only from the extension's exact popup sender, like settings and approval answers.

Tab metadata: retain Firefox id/windowId/index/groupId/url/title/active/pinned/status/discarded/audible/mutedInfo/incognito/hidden/lastAccessed fields, plus createdAt (ISO|null), createdAtSource, firstSeenAt, lastActiveAt, lastActiveSource, discardSource (`this-extension`|`unknown`|null). Firefox cannot generally reveal which actor discarded a tab. Session values preserve tracker metadata across restores, not global storage keyed by reusable IDs. ATD uses the same discarded state; never infer ATD/native origin without evidence.

Extension inventory returns `{extensions,total,offset,limit,returned,nextOffset}`. Default type is `extension`; `all` includes extensions and themes exposed by `management.getAll`. `enabled:true` filters enabled add-ons, `false` disabled add-ons; omission includes both. Enabled describes the Firefox setting, not whether extension code is running at that moment. Entries contain `id,name,version,type,enabled` and available `description,installType,disabledReason`, sorted by name and ID. Default page size100, maximum500. This read-only method requires the manifest `management` permission and optional `technicalAndInteraction` data consent, checked before and after enumeration. The latter is controlled by the toolbar checkbox; missing consent returns `INVENTORY_PERMISSION_REQUIRED`. Inventory text is untrusted data. No extension enabling/disabling/uninstalling methods are exposed.
