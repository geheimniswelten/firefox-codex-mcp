/* global browser */
"use strict";
const el = id => document.getElementById(id);
async function answer(allowed) {
  el("allow").disabled = true; el("deny").disabled = true;
  try { await browser.runtime.sendMessage({ type: "approval_answer", allowed }); window.close(); }
  catch (error) { el("error").hidden = false; el("error").textContent = String(error.message || error); }
}
el("deny").addEventListener("click", () => answer(false));
el("allow").addEventListener("click", () => answer(true));
browser.runtime.sendMessage({ type: "approval_details" }).then(request => {
  if (!request) throw new Error("Diese Freigabe ist abgelaufen.");
  el("title").textContent = request.title || "Ohne Titel";
  el("url").textContent = request.url;
  const scope = request.scope === "active" ? "jeweils den aktiven Tab im zuletzt aktiven Firefox-Fenster" : "alle Tabs";
  el("description").textContent = request.mode === "ask-session" ? `Für ${scope} freigeben: bis zu 12 Stunden ab Freigabe, spätestens bis Firefox neu startet. Diese Frist verlängert sich nicht durch Zugriffe.` : `Nur diese Anfrage für ${scope} freigeben. Bei der nächsten Inhaltsanfrage wird erneut gefragt.`;
  el("allow").disabled = false;
}).catch(error => { el("error").hidden = false; el("error").textContent = String(error.message || error); });
