// Switches the on-page buddy on and off. Before a pairing code has been accepted the extension is neutral: no buddy, no
// script registered, nothing injected. Once the browser is paired the buddy is on, until the person turns it off in the
// popup (and it stays off). While it is on, one content script is registered (and put into tabs that are already open);
// when it goes off, or the browser disconnects, the registration is removed and any open buddy hides itself.
// Also records which buddy it is (`petWho`: Dori for a family account, Ringo for an adult's own): the account type
// the pairing code came from. Shared by the service worker (importScripts) and tested in common/tests/pet.test.js.
(function (root) {
  "use strict";

  // The buddy is a content script registered by the service worker. It is registered only while paired and switched on, and runs at document_start so a page cannot see what is typed into its chat.
  const ID = "praise-pet";
  const FILES = ["companion.js", "companion-css.js", "companion-ui.js", "chat-ui.js", "pet.js", "pet-boot.js"];
  const RUN_AT = "document_start";                                 // before the page's own scripts, so typed chat text can be kept from them
  const MATCHES = ["http://*/*", "https://*/*"];
  const EXCLUDE = ["http://localhost/*", "http://127.0.0.1/*"];    // our own dashboard has its own buddy

  // A newly registered script only runs on future page loads; also inject it into tabs that are already open.
  async function injectIntoOpenTabs(api) {
    let tabs = [];
    try { tabs = await api.tabs.query({ url: MATCHES }); } catch (e) { return; }
    for (const t of tabs) {
      if (t.id == null) continue;
      try { await api.scripting.executeScript({ target: { tabId: t.id }, files: FILES }); } catch (e) { /* store pages, PDFs: skip */ }
    }
  }

  // Make the registration match the setting. Returns whether the buddy is on. `petActive` is the answer the page
  // script follows, so it never needs to see the pairing token itself.
  async function apply(api) {
    const { pet, token, mode, petActive, petWho, petChat, snapshot } = await api.storage.local.get({ pet: null, token: null, mode: null, petActive: false, petWho: null, petChat: true, snapshot: null });
    const on = !!token && !(pet && pet.on === false);
    const who = mode === "adult" ? "adult" : "family";
    let registered = [];
    try { registered = await api.scripting.getRegisteredContentScripts({ ids: [ID] }); } catch (e) { registered = []; }
    // A registration left by an older version of the extension (different files or timing) is replaced, so an update
    // never leaves pages running half of the old buddy.
    const current = registered[0];
    const stale = !!current && (current.runAt !== RUN_AT || JSON.stringify(current.js) !== JSON.stringify(FILES));
    if (on && stale) await api.scripting.unregisterContentScripts({ ids: [ID] });
    if (on && (!registered.length || stale)) {
      await api.scripting.registerContentScripts([{
        id: ID, js: FILES, matches: MATCHES, excludeMatches: EXCLUDE,
        runAt: RUN_AT, allFrames: false, persistAcrossSessions: true,
      }]);
      await injectIntoOpenTabs(api);
    } else if (!on && registered.length) {
      await api.scripting.unregisterContentScripts({ ids: [ID] });
    }
    // Chatting with the buddy is on unless a parent switched it off for a child's browser (adults always have it).
    const chat = who === "adult" || !(snapshot && snapshot.settings && snapshot.settings.companion && snapshot.settings.companion.chat === false);
    const next = {};
    if (on !== !!petActive) next.petActive = on;
    if (on && who !== petWho) next.petWho = who;
    if (on && chat !== petChat) next.petChat = chat;
    if (Object.keys(next).length) await api.storage.local.set(next);
    return on;
  }

  // Keep the registration in step with pairing and the popup switch.
  function install(api) {
    const run = () => apply(api).catch(() => { /* try again on the next change */ });
    api.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.pet || changes.token || changes.mode || changes.snapshot)) run(); });
    api.runtime.onInstalled.addListener(run);
    api.runtime.onStartup.addListener(run);
  }

  const control = { ID, FILES, MATCHES, EXCLUDE, apply, install };
  if (typeof module !== "undefined" && module.exports) module.exports = control;
  else root.PraisePetControl = control;
})(typeof self !== "undefined" ? self : this);
