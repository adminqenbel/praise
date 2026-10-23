# Praise: AI-assisted parental web protection

A Chrome extension on the child's browser enforces rules. A separate dashboard lets a parent set
those rules and review activity. A Flask backend, backed by PostgreSQL, makes the
decisions. Gemini classifies sites nobody has seen before, and a deterministic policy engine, not
the AI, makes the final ALLOW or BLOCK call.

```
 Parent / admin dashboard (HTML, CSS, JS, Chart.js)  --REST/JSON-->  Flask backend  --> PostgreSQL (everything, incl. events and AI evidence)
 Child browser extension (Manifest V3)               --REST/JSON-->                 --> Gemini (classifier only)
```

## Quick start (Windows)

Needs PostgreSQL and Python 3.11+. Create an empty database called `praise` first.

```
.\praise.bat            start backend (5000) and dashboard (5500), open the browser
.\praise.bat mock       use the offline keyword classifier instead of Gemini
.\praise.bat demo       also create demo data
.\praise.bat stop       stop both servers
```

The first run creates `backend\.env`. Set `DATABASE_URL` (your PostgreSQL password) and
`GEMINI_API_KEY`, then run it again. It also sets up the Python environment, applies migrations,
and loads the well-known-sites list.

Load the extension: `chrome://extensions` -> Developer mode -> Load unpacked -> `extension\`. There is **one** extension for
everyone: it stays neutral until you enter a pairing code, and the code decides what it becomes (see below).

Create an admin (needed for the review queue):
`cd backend` then `.venv\Scripts\flask --app app create-admin`.

## Using it

1. Dashboard -> create an account -> **Children** -> add a child -> **Get a pairing code**.
2. Extension popup -> enter the 8-character code. The code works once and expires in 15 minutes.
3. **Rules** -> create a rule set (Child safe, Teen, Education or Empty) and assign it to the child.
4. Browse. Unknown sites are checked by AI, decided by the policy and logged. Closed pages show a
   plain explanation and an "Ask a parent for access" button.

## Three faces

The product has one backend and three deliberately different looks, so nobody uses an interface built
for someone else:

- **Neutral** (landing page `index.html`, sign-in): plain white, one typeface, no mascot. It asks who
  you're protecting: "For my family" or "For me".
- **Praise, for families**: warm and friendly. Doors with porch lamps, lilac glass, a floating top bar.
  Includes the child's block page and the extension's family popup.
- **Praise Shield, for adults**: calm and composed. Porcelain and pine with one signal teal, flat
  panels, a sidebar, and a protection ring whose four arcs show which layers are on. Includes the
  warning page, popup and dialogs of the extension when it is paired to an adult's own account.

## One extension, two versions

There is a single extension, `extension/`. Before a pairing code it is neutral: its popup shows only a pairing form (plain
white, the Praise wordmark), it has no buddy, and it registers and blocks nothing. The server tells it what it has joined when
the code is accepted, and it adapts (and re-checks on every sync):

| | Family (a parent's code) | Personal, "Praise Shield" (an adult's own code) |
|---|---|---|
| Looks and buddy | violet glass, the door icon, **Dori** | porcelain and teal, the ring icon, **Ringo** |
| A new site | held on a "checking" page until judged; blocked sites get the door page, and a child can ask a parent | the page loads while it is judged alongside; a risky one gets a warning page |
| What leaves the browser | the address, so a parent's rules can be exact | only the site's origin (`https://example.com/`) |
| Also watches | downloads, installers for other browsers, "open in another browser" links, the extensions page | trackers (blocked), tracking links (cleaned), the sensitive-data guard and password checks on pages |
| Pause | not available | for an hour or until tomorrow |
| Disconnect | needs a one-time code from the parent's dashboard (or the parent's password), checked by the server | two clicks |

A browser whose mode is missing is treated as family, the stricter side. Each side refuses the other's messages, so a child's
browser cannot be told to pause itself. Disconnecting removes everything (mode, rules, buddy, scripts) and the extension is neutral
again.

For the personal version, sign up on the dashboard and choose **Just me** (or follow "Create an account for yourself" on the
landing page). You get one profile, a "My protection" rule set, and a pairing code under **My browsers**. Enter it in the
extension.

### One login, both versions

The same email can have both a family space and a personal space. Every dashboard has a switch at the top (**Family | Just
me**). A space the login doesn't have yet reads "+ Just me" or "+ Family" and asks before adding it, so a stray click creates
nothing. Each space shows only its own profiles, rule sets and activity, and signing in again opens the space you were last in.

Under the hood the account says which spaces exist (`users.has_family`, `users.has_adult`) and which one is showing
(`users.account_type`); profiles are told apart by `children.kind` (`child` or `self`) and rule sets by `policies.space`. A
browser becomes the version of the profile it was paired to, so one login can run a child's browser and its own at once, and
leaving a child's browser still needs a parent's disconnect code. See `backend/services/space_service.py`.

Built so far: warnings for scams, look-alike bank and payment pages, and known threats, with the
reason shown and the real site offered; "Continue anyway" for warnings (not for known malware),
remembered for an hour; pause for an hour or until tomorrow; unknown sites open normally. Only a
site's address (never the path or query string) is sent to the server.

Privacy protection: third-party trackers and cross-site ID scripts are blocked at the network level
(the badge counts what was blocked on the current page), tracking parameters such as `fbclid` and
`utm_source` are removed from links, tracking cookies are removed, and the popup shows what the
current page and your browser hold, with one-click "Clear this site's cookies" and "Remove tracking
cookies". An optional setting sweeps tracking cookies shortly after a tab closes. The tracker lists
are our own short curated lists in `common/protections.js`; after editing them run
`node scripts/build_rules.js`.

Sensitive-data guard: before a form sends card details, an ID number (Aadhaar, US SSN, PAN, IBAN),
a one-time code or a password to an untrustworthy page, Praise Shield holds the submit and asks.
"Untrustworthy" means a site we warned about (including one you chose to continue to), an
unencrypted page, or a form that posts to a different site than the one you're on. Ordinary
logins and checkouts on trustworthy sites are never interrupted. Detection runs inside the page on
your device: what you typed is never sent anywhere, and the server only learns that a warning was
shown and which kinds of data it concerned. Limits: a page that submits with scripts (`fetch`, or
`form.submit()`) can't be intercepted, forms inside iframes aren't watched, and this needs access to every
page you visit. The guard runs before any page script so a page can't switch it off. Every permission and
everything that leaves your device is listed in `docs/PRAISE_SHIELD_PERMISSIONS.md`.

Password safety: when you type a password, Praise Shield checks whether it appears in known data
breaches and shows a banner if it does. **How the check works, and the one third-party call:** the
page computes a SHA-1 hash of the password on your device and sends only its first 5 characters to
the Have I Been Pwned "Pwned Passwords" range service (`api.pwnedpasswords.com`, padded so the reply
size reveals nothing). The service returns every breached hash that starts with those 5 characters,
and the comparison happens on your device. Your password and its full hash never leave the page, and
no cookies, account details or page addresses are sent with the request. You can turn the check off
under `passwords.breach_check`. Optional **reuse detection** (`passwords.reuse_check`, off by
default) warns when the same password is used on several sites. It remembers only slow, salted
fingerprints (PBKDF2, 150,000 rounds) and the site names they were seen on, on this device; the
popup shows how many are remembered and can erase them. Reuse detection needs a secure (https)
page. Breach data courtesy of Have I Been Pwned (haveibeenpwned.com), by Troy Hunt.

An adult account's dashboard is different from a family one: **Home** shows your browser's status, a
plain-language week summary, "Needs your attention" (exposed or reused passwords, warnings you chose to
ignore), warnings per day and recent warnings; **My protection** edits what to warn about or block,
trackers and cookies, sensitive-data checks and password safety; **Activity** lists warnings and data
checks; **Cookies** and **Sites** work as in the family version; **My browsers** gives pairing codes.
See `docs/ADULT_VERSION_PLAN.md`.

## How a decision is made

First match wins:

1. Parent rule: exception, then block list, then allow list
2. Admin-verified site classification (includes the built-in well-known sites)
3. Trusted reputation data
4. Category policy for seeded sites
5. Domain-ending (TLD) policy
6. AI classification, if its confidence meets the rule set's minimum
7. Unknown-site default (Child safe: closed; Teen and Education: wait for a parent)

AI results are stored. A site is classified once and then served from the database, with no repeat
Gemini call. Admins review AI results and verify them, which makes them final for every family.

## What the extension does

- Holds each new page on a "Checking this site" screen until a decision arrives, so the page never
  renders before it is judged
- Blocks programs, scripts, installers and Chrome-flagged downloads, and browser-installer pages
- Stops links that hand the page to another browser
- Blocks the browser's extensions and settings pages (best effort)
- Watches cookies (name, site and lifetime only, never values) and removes known trackers
- Counts what each site stores in the browser
- Keeps enforcing the last policy it received if the backend is unreachable, and keeps well-known
  verified sites working offline

## The buddies: Dori and Ringo

Each version has a companion robot, built from the two mascot illustrations.

| | Dori (family) | Ringo (Shield, adult) |
|---|---|---|
| Voice | warm, simple words, never scary or shaming | brief, calm, direct |
| Shows up on | the child's block page, the child popup, the parent dashboard home, the landing hub | the warning page, the Shield popup, the Shield dialogs and banners, the adult dashboard home, the landing hub |

What it does:

- **Blocked page (family).** A screen of two panels closes over the page and Dori comes in and explains in plain words, with
  a reason that fits the category. If a parent has been asked, Dori waits with the child, checks again every few seconds
  while the tab is visible, and changes what it says the longer it takes (fresh, a while, a long time, giving up after ten
  minutes). When the parent approves it, Dori celebrates, the panels slide apart and the site opens by itself.
- **Warning page (Shield).** A shutter lifts as Ringo steps in with the warning; pressing "Continue anyway" brings the
  shutter down as the page opens.
- **Time of day.** Greetings change for morning, afternoon, evening and late night. Late at night the family buddy gently
  mentions bedtime when it closes or opens a site.
- **A browser companion.** When something goes wrong (server unreachable, browser removed, pairing failed), the buddy says
  so in plain words and never blames the person.
- **It lives on the page.** Beyond the story moments, the buddy acts like a small pet: it breathes and blinks, its eyes follow
  your pointer and it turns a little toward you, and now and then it hops, wiggles, stretches, hums or yawns. Poke it and it
  squishes and answers; poke it five times fast and it spins dizzy; double-click for a backflip; rest the pointer on it and it
  purrs. On the hub and dashboard it falls asleep when left alone (sooner late at night) and wakes with a stretch when you
  come back. On the block and warning pages it also paces about, but it never talks over the explanation, and it stays calm
  (no hopping) while it is showing a warning or an apology. Under "reduce motion" all of this is off.
- **Moods.** happy, curious, thinking, sleepy, alert, sorry, shy, nod and celebrate each have their own expression (drawn
  on its screen) and motion. Motion stops when the system asks for reduced motion.

How it is built: the wording lives in `common/companion.js` (pure logic, no network, works with no model),
the buddy (drawn as inline SVG, so no picture files and nothing a page's content rules can block) and its bubble in
`common/companion-ui.js` and `common/companion.css`. All three are copied into the extension and the dashboard by
`scripts/sync_common.py`. Dori is violet with an amber lamp, Ringo white and black with red; both take their colours from
`--b-*` variables in `common/companion.css`.

**The buddy on web pages (only after pairing).** Until a pairing code has been accepted the extension is neutral: no robot in
the popup, no buddy on pages, nothing injected. Once the browser is paired, Dori (a family account) or Ringo (an adult's own) lives in the corner of
the pages you browse, with all the pet behaviour above, and disappears again if the browser is disconnected. The switch
"Show Dori on web pages" is at the top of the paired popup; if you turn it off, it stays off. Drag it to move it, and it
snaps to the nearest side. Right-click it for Quiet mode (it animates but never speaks), Move to the other side, or Hide.
It says hello once a day and, late at night, a gentle bedtime word at most once an hour. Ringo falls asleep while the
protection is paused. It skips fullscreen video, printing, frames, `localhost` and non-web pages. Nothing is injected
while the switch is off: turning it on registers one script, turning it off removes it. The script never reads the page,
its address or title, and sends nothing (except a message you type into its chat, below). (Under `scripts/sync_common.py`, `pet.js`, `pet-control.js` and a generated
`companion-css.js` are copied into the extension.) The service worker records which buddy it is (`petWho`) and whether it is on
(`petActive`), so the page script never sees the pairing token.

### Talking to the buddies

You can chat with Dori and Ringo. On a page, hover over the buddy and press the small chat button (or right-click it and
choose "Talk to Dori"); in the extension popup and on the dashboard's home page there is a "Talk to ..." button. Press Escape
or the cross to close it. The same panel (`common/chat-ui.js`) is used in all three places.

- **It always works.** The buddy's own little brain (`PraiseCompanion.reply`, in `common/companion.js`) answers everyday things
  from written lines: hello, how are you, a joke, why a page was closed, a safe-web or security tip, passwords, scams, whether
  the chat is private, the time. No network and no model are needed.
- **A local model for the rest.** Anything the brain doesn't recognise goes to the server, whose local model (Ollama) answers
  with a short, in-character reply. Set `COMPANION_LLM=ollama` in `backend/.env` (the same switch as the line rewording below).
  If the model is off, slow (25 seconds), or its answer fails the plain-text check, the buddy says its written fallback line.
  Replies are cut to three sentences, with no links, markup or code; for a child, also no numbers and nothing from a
  short list of words a child's buddy never says.
- **Some things are never sent to a model.** A message about being sad, scared, hurt, bullied or unsafe is answered by the
  buddy itself with a caring nudge to talk to a grown-up you trust (a helpline for adults). A message holding personal details
  (a phone number, an email address, "my password is...") gets a reminder to keep it private. A child's buddy also leaves
  topics such as weapons, sex, drugs, gambling and swearing to grown-ups, in writing. The same checks run in the browser and on
  the server (`chat_guard` in `backend/ai/companion_llm.py`), so a changed client can't skip them.
- **Nothing is saved.** The server uses a message to make one answer and does not log or store it; the conversation lives in
  memory until the panel closes. A page's scripts can't read what you type: the chat's text box lives in a closed shadow root
  and the page script registers its keyboard listeners first (`document_start`), so what is typed is kept from the page's own
  listeners (`scripts/e2e_chat.js` checks this against a page that tries to read every key).
- **A parent decides for a child's browser.** **Rules > Dori, the browsing buddy > Let your child chat with Dori**
  (`settings.companion.chat`) switches it off: the chat button disappears and the server refuses to answer. An adult's own
  browser always has it.
- **Endpoints:** `POST /api/ext/chat` (browser, device token) and `POST /api/auth/chat` (dashboard, signed-in). Both answer
  `{"reply": null}` when the buddy should use its own words.

To check the extension in a real browser there are three scripts, all launching a throwaway headless Chrome with the unpacked
extension:

- `node scripts/e2e_pair.js shots\` is the full flow against your running backend (`praise.bat mock nobrowser`, plus
  `python -m http.server 8791 --bind 127.0.0.2` for a test page). It signs up a family account and an adult account
  (`@demo.test`, removed by `flask purge-demo`), types each pairing code into the popup, and checks what the extension became:
  popup look and buddy, page buddy, the guard, how a new site is treated, a wrong disconnect code, and that disconnecting makes
  it neutral again. Screenshots of each state are saved.
- `node scripts/e2e_chat.js extension shots\` opens the chat like a person would (hover, click, type, send, Escape) on a page
  whose scripts try to read every keystroke, and checks the answers, the caring reply, and that the page saw nothing typed to
  the buddy (`MODE=adult` for Ringo, `CHATOFF=1` for a parent's switch). It needs no server beyond its own.
- `MODE=adult node scripts/e2e_pet.js extension http://127.0.0.2:8000/ shot.png` is the quicker page-buddy check, with the
  pairing faked in storage (`MODE=family` is the default). `FRESH=1` leaves the switch alone (a freshly paired browser shows the
  buddy on its own); `UNPAIRED=1` pairs nothing and expects no buddy and no scripts at all.

**Optional local model.** Set `COMPANION_LLM=ollama` in `backend/.env` (defaults: `OLLAMA_URL=http://localhost:11434`,
`COMPANION_MODEL=qwen2.5:3b-instruct`; it also powers the chat above) and chatty lines (greetings, waiting, approvals) are reworded for variety by the
local model. Only the template sentence is sent, never a site name or anything about the child. The result must pass the
same plain-text check as everything else, or the template is shown. Lines that explain a block or warning are never
reworded: in testing, the small model changed the meaning of one, so those stay exactly as written.

## Layout

```
backend/    Flask app: routes/, policy/ (pure engine), ai/, services/, database/, tests/, migrations/
extension/  the one Praise extension (Manifest V3): background.js (family and adult behaviour, chosen by the pairing
            code), popup/ (neutral, family and adult looks), block/ (family door page), warn/ (adult warning page),
            content.js (adult sensitive-data guard), rules/ (tracker rulesets), tests/
common/     shared logic (lib.js, protections.js, companion*.js/css, pet and guard control) and its Node tests; copied
            into the extension and the dashboard by scripts/sync_common.py (praise.bat runs it)
assets/     the buddies' source cut-outs and expression images (companions/)
dashboard/  index.html = neutral landing hub (routes to the two versions); family.html = Praise for families;
            shield.html = Praise Shield; home.html and the other pages = the dashboard, which takes the family
            or adult look from the account type after sign-in; js/ (api.js, app.js, ring.js, one script per
            page); css/ (dashboard.css family, shield.css adult, neutral.css hub and sign-in); serve.py = no-cache
            static server
praise.bat  one-file launcher
```

The extension's background worker is tested in `extension/tests/background.test.js` (family and adult behaviour, mode switching, disconnect); the guard's detectors are tested in `common/tests/sensitive.test.js`.
Dashboard logic: `cd dashboard` then `node --test tests/ring.test.js`.
Tests: `cd backend` then `.venv\Scripts\python -m pytest tests`, and `cd common` then
`node --test tests/lib.test.js tests/protections.test.js` in `common`.
To run the backend tests on PostgreSQL, set `TEST_DATABASE_URL` to a throwaway database.

## Security model

- Dashboard: Flask session cookie (HttpOnly, SameSite=Lax) plus a CSRF token on every change. CORS
  allows only the dashboard origin. Parents see only their own children's data; verifying shared
  site data is admin-only.
- Extension: a long-lived device token (stored hashed) obtained with a one-time pairing code; the pairing reply also says
  whether the account is a family or an adult's own. **Disconnect** is in the popup: a personal browser asks for two clicks
  (it is your own browser); a family one asks for a one-time disconnect code from the parent's Children page (or the parent's password), checked by the server, so
  a child can't switch protection off. Either way the device is revoked on the server and disappears from the dashboard's
  active list. A browser a parent removed can be paired again with a new code.
  Parents can remove a device; its token stops working immediately.
- Rate limits on login (per account and per IP), registration, pairing and the extension's
  check/events endpoints. The AI budget is capped per day and per family.
- **Untrusted inputs:** page text sent to Gemini and everything a device reports is treated as
  untrusted. The model's reply is parsed against a strict schema, with unknown categories dropped and
  numbers clamped. A low-risk (permissive) AI verdict is trusted only by the family whose device
  produced it, until an admin verifies the site. Stricter verdicts are shared. Disputing a verified
  site never changes it; it only queues it for an admin.
- Events (browsing history) are kept 90 days. Cookie values are never collected. The global site
  list holds no child data.

## Known limits

- The extension protects **this browser only**. It cannot control other browsers or apps. A child
  who can open `chrome://extensions` can disable it unless you force-install it with a managed
  browser policy (`ExtensionInstallForcelist`).
- The rate limiter and AI budget are per process. Several workers would need a shared store such as Redis.
- Cookie purposes are best guesses from names and domains and are labelled that way.
- The Gemini model name is set in `backend\.env` (`GEMINI_MODEL`). Models are retired over time.
  The free tier has a tight rate limit, and when the AI is unavailable, unknown sites get the rule
  set's default.
- Dashboard pages load Chart.js from a CDN and expect the API at `http://localhost:5000`.
  Change `connect-src` in each page's CSP meta tag if you move it.
- Use HTTPS and set `SESSION_COOKIE_SECURE=1` and a random `SECRET_KEY` before exposing this
  beyond your own machine. **Delete the demo accounts first:** `flask --app app purge-demo`.
