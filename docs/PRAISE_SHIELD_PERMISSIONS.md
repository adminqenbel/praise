# Praise: what each permission is for, and what leaves your device

Praise is one extension for every account. It does nothing until a pairing code is accepted, and then it becomes the **family**
version (a parent's code, for a child's browser) or the **personal** version, Praise Shield (an adult's own code). It asks for
broad access because it protects every page you visit, and Chrome shows one permission list for both. Rows marked *personal* or
*family* are used only on that side. This is the reason for each permission, and the data it can see. Nothing here is sent
anywhere except as listed in the last table.

| Permission | Why it is needed | What it can see |
|---|---|---|
| `webNavigation` | Notices when you open a site, so it can be checked. | The address of each top-level page you open. |
| `tabs` | Confirms you are still on the page that was checked, moves a risky page to the warning screen (family: the door page), and lists open tabs so a cookie can be called first- or third-party. | Tab addresses. |
| `downloads` | *Family only.* Notices downloads in a child's browser so blocked kinds (programs, installers) can be cancelled and logged. A personal browser never uses it. | The name, type and source site of each download. |
| `storage` | Keeps your settings, recent site decisions, the pause state, a short queue of events, and (only if you turn reuse detection on) password fingerprints. | Only what Praise Shield saves itself. |
| `alarms` | Refreshes your settings every 5 minutes, ends a pause on time, and sweeps tracking cookies after a tab closes. | Nothing. |
| `cookies` | Tells tracking cookies from sign-in cookies, removes trackers, and powers "Clear this site's cookies". | Cookie names, sites and lifetimes. The browser's cookie API also hands over values; the code never reads, stores or sends them. |
| `scripting` | Registers the page scripts, and only after pairing: the optional page buddy (while the popup switch is on; it starts on) shows Dori or Ringo in the corner of pages and is added to tabs that are already open, and, in a *personal* browser only, the sensitive-data guard. Nothing is registered before pairing, or while the buddy switch is off. A *family* browser also counts a site's stored items (how many, never what) once an hour. | Nothing, except those counts. |
| `declarativeNetRequest` | *Personal only.* Blocks requests to known trackers and removes tracking codes from links, using rules shipped inside the extension. The rulesets stay off in a family or unpaired browser. | Nothing: the browser applies the rules; Praise does not see your requests. |
| `declarativeNetRequestFeedback` | *Personal only.* Counts how many requests were blocked on the current page, for the badge and the popup. | A count per page, not addresses. |
| Access to all websites (`http://*/*`, `https://*/*`) | (1) Reads a new site's public front page, without your cookies, so it can be classified; (2) talks to your Praise server; (3) the cookie and content-script features work on any site. | Pages you visit (see the content script row). |
| Sensitive-data guard script (*personal* only, `document_start`) | The sensitive-data guard and password checks need to see the forms on the page. It is registered only once a browser is paired to an adult's own account (never before pairing, never in a child's browser), and it runs first so a page cannot switch it off. Pages already open when you pair get it the next time they load. | Form fields on the page, inside the page only. |
| Page buddy script (only after pairing; switch in the popup) | Shows Dori (family) or Ringo (personal) in the corner of web pages once the browser is paired, until you turn it off in the popup. It does not read the page, its address or its title. It sends nothing, except a message you type into its chat panel after opening it (see the next row). It keeps its side, height and last-greeting day in browser storage. | Nothing on the page. |
| Chat with the buddy (only when you open the chat panel and press send) | The buddy answers everyday questions itself, in the browser. For anything else, the message you typed (at most 300 characters) and up to the last six turns of that chat go to your own Praise server, whose local model may answer. Messages about feeling sad, scared or unsafe, and messages holding personal details, are answered in the browser and never sent. Nothing is saved: the server uses the message to make one answer and does not log or store it, and the chat is forgotten when the panel closes. What you type is kept from the page's own scripts. On a family account a parent can switch the chat off. | Nothing on the page. |
| `web_accessible_resources: block/block.html`, `warn/warn.html` and `companion/*.png` | Lets a tab be moved to the door page (family) or the warning page (personal), and lets the page buddy and the dialogs show the buddy pictures. The picture addresses change each browser session, but the warning page's does not, so a website can still tell the extension is installed. | Nothing. |

## What leaves your device

| What | Where to | When |
|---|---|---|
| The **site address only** (`https://example.com/`, never the path or query) of sites not already known. In a *family* browser the full address is sent, so a parent's rules can be exact. | Your Praise server, and from there the AI model | When you open a site that has no saved verdict |
| The visible text of that site's front page (first 1,500 characters) | Your Praise server, and from there the AI model | Same, only if the server asks for it |
| That a warning was shown, continued, or a form stopped, with the site and the **kinds** of data ("card", "password"), never the data | Your Praise server | After each such event |
| Cookie **names, sites, lifetimes and a guessed purpose** for removed or new cookies | Your Praise server | As cookies are set |
| The **first 5 characters** of a scrambled copy of a password you type | Have I Been Pwned (`api.pwnedpasswords.com`) | When breach checking is on and you finish typing a password |

## What never leaves your device

What you type (card numbers, IDs, one-time codes, passwords), the full scrambled copy of a password,
cookie values, page paths and query strings, and the password fingerprints used for reuse detection.

## Known limits (security)

- Forms inside iframes are not watched; a card number split across several fields is not recognised;
  a page that sends data with a script instead of a normal form submit cannot be intercepted.
- The page snippet fetch could be pointed at an address on your own network by a hostile site using
  DNS tricks. Only the first 1,500 characters of text are read, and they go to your own server.
- "Clear this site's cookies" matches sites by an approximate registrable domain, so on shared
  hosting (for example `*.github.io`) it can clear cookies for other sites on the same host.
- A hostile page can show our own dialog repeatedly or cover it, but it cannot click the buttons, and
  the held form stays held.
- Anyone using your browser profile can pause or change a personal Praise. It protects you; it is not
  a lock against someone with access to your computer. A family browser cannot pause itself and can only be disconnected with a
  parent's one-time code, but a child who can open `chrome://extensions` can still remove the extension unless it is force-installed by
  a managed browser policy.
- The mode (family or personal) is stored in the extension's own storage and refreshed from the server on every sync. Someone
  with developer tools on the extension could change it locally, which is the same limit as removing the extension.
