// Switches the sensitive-data guard on and off. The guard (content.js) is only for the personal "Shield" side of Praise, so
// it is registered for a browser that is paired to an adult's own account and nowhere else: not before a pairing code has
// been accepted, and not in a child's browser. It runs at document_start, so it is in place before the page's own scripts.
// Pages that were already open when the code was accepted get it the next time they load. Shared by the service worker
// (importScripts) and tested in common/tests/guard.test.js.
(function (root) {
  "use strict";

  // The sensitive-data guard is registered as a content script only for an adult's own browser (never for a child's).
  const ID = "praise-guard";
  const FILES = ["protections.js", "sensitive.js", "passwords.js", "content.js"];
  const MATCHES = ["http://*/*", "https://*/*"];

  // Register or remove the guard so it matches the pairing.
  async function apply(api) {
    const { token, mode } = await api.storage.local.get({ token: null, mode: null });
    const on = !!token && mode === "adult";
    let registered = [];
    try { registered = await api.scripting.getRegisteredContentScripts({ ids: [ID] }); } catch (e) { registered = []; }
    if (on && !registered.length) {
      await api.scripting.registerContentScripts([{
        id: ID, js: FILES, matches: MATCHES, runAt: "document_start", allFrames: false, persistAcrossSessions: true,
      }]);
    } else if (!on && registered.length) {
      await api.scripting.unregisterContentScripts({ ids: [ID] });
    }
    return on;
  }

  // Re-check whenever pairing changes, and at install and start-up.
  function install(api) {
    const run = () => apply(api).catch(() => { /* try again on the next change */ });
    api.storage.onChanged.addListener((changes, area) => { if (area === "local" && (changes.token || changes.mode)) run(); });
    api.runtime.onInstalled.addListener(run);
    api.runtime.onStartup.addListener(run);
  }

  const control = { ID, FILES, MATCHES, apply, install };
  if (typeof module !== "undefined" && module.exports) module.exports = control;
  else root.PraiseGuardControl = control;
})(typeof self !== "undefined" ? self : this);
