// The buddies' voices: what each one says, and how it feels, for every situation. Pure logic: no DOM,
// no chrome.*, nothing stored. Both extensions and the dashboard use it, and it works with no network
// and no AI model, so a buddy never goes quiet.
//
//   family: a warm helper for children (simple words, never scary, never shaming)
//   adult:  a composed guard for grown-ups (brief, direct, plain)
//
// A local language model may *rephrase* these lines for variety (backend/ai/companion_llm.py), but only
// after safeLine() has checked the result, and these templates are always the fallback.
(function (root) {
  "use strict";

  // The wording engine for both buddies: pure text logic with no network, so it works with no server and no model. Dori is warm and simple; Ringo is brief and direct.
  const NAMES = { family: "Dori", adult: "Ringo" };

  // morning / afternoon / evening / late, for greetings.
  function timeOfDay(date = new Date()) {
    const h = date.getHours();
    return h >= 5 && h < 12 ? "morning" : h < 17 && h >= 12 ? "afternoon" : h >= 17 && h < 22 ? "evening" : "late";
  }

  // How the buddy is feeling drives its pose and animation.
  const MOODS = ["happy", "curious", "thinking", "sleepy", "alert", "sorry", "celebrate", "shy", "nod"];

  // ---- family voice -------------------------------------------------------------------------------
  const FAMILY_CLOSED = {
    gambling: "That one is about betting games, and those are for grown-ups.",
    betting: "That one is about betting games, and those are for grown-ups.",
    adult: "That page isn't for kids, so your family keeps it closed.",
    dating: "That page is for grown-ups, so it stays closed.",
    drugs: "That page isn't a good fit for kids, so it's closed.",
    weapons: "That page isn't a good fit for kids, so it's closed.",
    violence: "That page isn't a good fit for kids, so it's closed.",
    self_harm: "That page isn't a good fit for you. If something feels heavy, please talk to a grown-up you trust.",
    banking: "That's a money page, and only grown-ups use those.",
    payment: "That's a money page, and only grown-ups use those.",
    upi: "That's a money page, and only grown-ups use those.",
    digital_wallet: "That's a money page, and only grown-ups use those.",
    trading: "That's a money page, and only grown-ups use those.",
    cryptocurrency: "That's a money page, and only grown-ups use those.",
    forex: "That's a money page, and only grown-ups use those.",
    loans: "That's a money page, and only grown-ups use those.",
    bnpl: "That's a money page, and only grown-ups use those.",
    financial_phishing: "That page pretends to be a bank. I closed it to keep you safe.",
    phishing: "That page might be tricking people, so I closed it to keep you safe.",
    scam: "That page might be tricking people, so I closed it to keep you safe.",
    malware: "That page could hurt the computer, so I closed it to keep you safe.",
    suspicious_domain: "That address looks a bit odd, so I closed it to be safe.",
    dangerous_download: "That page wants you to download something risky, so I closed it.",
    social_media: "Your family hasn't opened social sites yet.",
    gaming: "Your family has that one closed for now.",
    streaming: "Your family has that one closed for now.",
    shopping: "Your family has that one closed for now.",
    browser_installer: "Other browsers can't be installed here, but I'm right here to help.",
    external_browser: "That link wanted to open another browser. Let's stay here together.",
    tamper: "That page is for grown-ups, because it changes how I work.",
  };

  // Dori's lines, grouped by what happened. Each group has several variants so she doesn't repeat herself.
  const FAMILY = {
    greet: {
      morning: ["Good morning! Ready to explore?", "Morning! I'm up and ready.", "Hello, sunshine! Where to first?"],
      afternoon: ["Hi again! What are we looking for?", "Good afternoon! I'm all set.", "Hey there! Need a hand?"],
      evening: ["Good evening! Let's keep it cozy.", "Hi! A calm evening of browsing?", "Evening! I'm right here."],
      late: ["It's getting late. Maybe time to rest?", "Still up? A good sleep helps tomorrow.", "Shhh, it's late. I'll keep watch."],
    },
    checking: ["Let me take a quick look at this one.", "Hmm, one moment while I check.", "Peeking at this page for you."],
    closed: ["I closed this page.", "This door is closed for now.", "I had to close this one."],
    asked: ["I've told a grown-up. Let's wait together!", "Request sent! Someone will take a look.", "Asked! You can wait here with me."],
    waiting: {
      fresh: ["Waiting is the hard part. I'm here!", "Still checking with a grown-up.", "Any second now."],
      mid: ["Still waiting. Maybe they're busy.", "They'll see it soon, I hope.", "Want to do something else while we wait?"],
      long: ["It's taking a while. Try another page for now?", "Your grown-up hasn't seen it yet. We can ask again later."],
      giveup: ["I'll stop checking for now. Ask again later!", "Let's come back to this one later."],
    },
    approved: ["Good news! It's open!", "Yay, they said yes! Opening now.", "You got a yes! Let's go!"],
    offline: ["Oops! I can't reach home right now, so I'm keeping this closed to be safe.", "I can't find the family server, so I'll keep things closed until I can."],
    error: ["Oops, something went wrong. It isn't your fault!", "Hmm, that didn't work. Let's try again in a moment."],
    paired: ["We're connected! I'm Dori, your browsing buddy.", "All set! I'll be your buddy from now on."],
    revoked: ["I lost my link to your family. Ask a grown-up to reconnect me."],
    allowed: ["All good, this one's fine.", "Looks okay to me!"],
    // little reactions when someone plays with the buddy
    poke: ["Hehe, that tickles!", "Boop! Hello!", "Hey! I'm right here.", "Ooh, a poke!"],
    dizzy: ["Whoa, I'm all dizzy!", "Okay okay, I'm spinning!"],
    purr: ["That feels nice. Thank you!", "Aww, thanks! I like you too."],
    wake: ["Oh! I'm awake! Hi!", "Mmm, hello again!"],
    yawn: ["Haaa... a little sleepy.", "Yawn! I could nap."],
    snooze: ["Zzz... just resting my eyes."],
  };

  // ---- adult voice --------------------------------------------------------------------------------
  const ADULT_WARN = {
    scam: "This looks like a scam page. I'd leave.",
    phishing: "This may be imitating another site to get your details.",
    financial_phishing: "This looks like a copy of a bank or payment site. I'd leave.",
    malware: "This site is known for harmful software, so I've stopped it.",
    suspicious_domain: "Something about this address looks off.",
    dangerous_download: "This site pushes risky downloads.",
  };

  // Ringo's lines, same groups, calmer and shorter.
  const ADULT = {
    greet: {
      morning: ["Good morning. All layers are watching.", "Morning. I'm on watch."],
      afternoon: ["Good afternoon. All quiet so far.", "Afternoon. I'm keeping an eye out."],
      evening: ["Good evening. Everything looks calm.", "Evening. I'm still watching."],
      late: ["It's late. I'll keep watch.", "Late one. Be careful what you sign in to."],
    },
    checking: ["Checking this site.", "One moment while I look."],
    waiting: {
      fresh: ["Still checking.", "One moment."],
      mid: ["This is taking longer than usual.", "Still working on it."],
      long: ["I can't get an answer. You can go back, or continue at your own risk."],
      giveup: ["No answer yet. Try again later."],
    },
    warn: ["Hold on a moment.", "I'd pause here."],
    blocked: ["I've blocked this page.", "This one isn't safe to open."],
    continued: ["Understood. Opening it. I'll keep watching.", "Your call. I'll stay alert."],
    protected: ["All layers are on.", "You're protected."],
    paused: ["Paused. I'm not checking anything until you resume.", "Protection is off for now."],
    offline: ["I can't reach your server, so I'm using what I saved earlier.", "Server unreachable. Known threats are still covered."],
    error: ["That didn't work. Try again in a moment.", "Something went wrong on my side."],
    paired: ["Connected. I'm Ringo, and I'm on watch.", "Paired. Protection is on."],
    revoked: ["This browser was removed from your account. Connect it again to continue."],
    allowed: ["This site looks fine.", "No problems found."],
    poke: ["Yes? I'm on watch.", "Still here. Still watching.", "Noted. I'm paying attention."],
    dizzy: ["Enough, I'm getting dizzy.", "Please stop. I'm a guard, not a toy."],
    purr: ["Appreciated. Back to work.", "Thanks. I'm still on watch."],
    wake: ["Awake. Every layer is still on.", "Back on watch."],
    yawn: ["Long watch. I'm fine.", "Just resting my eyes."],
    snooze: ["Standing by."],
    held: ["I've held this form. Check where it's going.", "Hold on. This form is going somewhere risky."],
    breached: ["That password has been in a data breach. Pick a different one."],
  };

  const POOLS = { family: FAMILY, adult: ADULT };

  // How the mood follows the situation. `ctx.time` can add sleepiness late at night.
  const MOOD = {
    greet: (t) => (t === "late" ? "sleepy" : "happy"),
    checking: () => "thinking",
    closed: () => "sorry",
    asked: () => "nod",
    waiting: (_t, ctx) => (ctx.phase === "giveup" ? "sleepy" : ctx.phase === "long" ? "shy" : "thinking"),
    approved: () => "celebrate",
    offline: () => "sorry",
    error: () => "sorry",
    paired: () => "celebrate",
    revoked: () => "sorry",
    allowed: () => "happy",
    warn: () => "alert",
    blocked: () => "alert",
    continued: () => "nod",
    protected: () => "happy",
    paused: () => "sleepy",
    held: () => "alert",
    breached: () => "alert",
    poke: () => "shy",
    dizzy: () => "thinking",
    purr: () => "shy",
    wake: () => "happy",
    yawn: () => "sleepy",
    snooze: () => "sleepy",
  };

  // How long a child has been waiting for a parent: fresh, a while, a long time, or give up after ten minutes.
  function waitPhase(seconds) {
    return seconds < 15 ? "fresh" : seconds < 90 ? "mid" : seconds < 600 ? "long" : "giveup";
  }

  const pickOne = (arr, rand, avoid) => {
    const pool = arr.length > 1 && avoid ? arr.filter((x) => x !== avoid) : arr;
    return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))];
  };

  // say("family", "closed", { category: "gambling", date, rand, avoid })  ->  { text, mood, who, name }
  function say(who, kind, ctx = {}) {
    const voice = who === "adult" ? "adult" : "family";
    const pools = POOLS[voice];
    const rand = ctx.rand || Math.random;
    const t = timeOfDay(ctx.date);
    let text;

    if (voice === "family" && kind === "closed") {
      const why = FAMILY_CLOSED[ctx.category];
      text = why ? why : pickOne(pools.closed, rand, ctx.avoid);
    } else if ((voice === "adult") && (kind === "warn" || kind === "blocked") && ADULT_WARN[ctx.category]) {
      text = ADULT_WARN[ctx.category];
    } else if (kind === "greet") {
      text = pickOne(pools.greet[t], rand, ctx.avoid);
    } else if (kind === "waiting") {
      const phase = ctx.phase || waitPhase(ctx.seconds || 0);
      ctx = { ...ctx, phase };
      text = pickOne(pools.waiting[phase], rand, ctx.avoid);
    } else if (pools[kind]) {
      text = pickOne(pools[kind], rand, ctx.avoid);
    } else {
      text = pickOne(pools.error, rand, ctx.avoid);
    }

    // After dark, a family buddy gently mentions bedtime on top of what it was already saying.
    if (voice === "family" && t === "late" && (kind === "closed" || kind === "approved") && ctx.bedtimeNote !== false) {
      text += " It's late, too. Time to rest soon?";
    }
    const moodFn = MOOD[kind] || (() => "happy");
    return { who: voice, name: NAMES[voice], text, mood: moodFn(t, ctx), time: t };
  }

  // A line is safe to show a person only if it is short, plain text with no links, numbers or markup.
  // Used to vet anything that did not come from the templates above (such as local-model output).
  function safeLine(text) {
    if (typeof text !== "string") return null;
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 4 || t.length > 160) return null;
    if (/[<>{}\[\]`\\|@#$%^*_=+~]/.test(t)) return null;          // markup and code characters
    if (/https?:|www\.|\.com\b|\.org\b|\.net\b/i.test(t)) return null;
    if (/\d/.test(t)) return null;                                 // no numbers, scores, phone numbers
    if (!/^[\p{L}\p{P}\p{Zs}']+$/u.test(t)) return null;           // letters, punctuation and spaces only
    return t;
  }

  // ---- talking with the buddy ---------------------------------------------------------------------
  // reply() is the buddy's own little brain: it understands everyday things (hello, how are you, a joke, why a page was
  // closed, password tips...) and answers from written lines, so a chat works with no network and no model. Anything it
  // doesn't recognise comes back as intent "unknown"; the chat panel may then ask the server's optional local model, and
  // falls back to the line given here when that is off.
  // chatGuard() decides what must never be forwarded anywhere: things that need a real person's care, and personal details.
  const SENSITIVE = new RegExp("\\b(kill(ing)? (my ?self|me)|suicid\\w*|self[- ]?harm\\w*|hurt(ing)? my ?self|cut(ting)? my ?self|" +
    "want(ed)? to die|end (my life|it all)|don'?t want to (live|be here)|hate my life|abus(e|ed|es|ing)|molest\\w*|" +
    "(touch|touched|touches|hit|hits|hurts?|beat|beats) me|bull(y|ied|ies|ying)|scared of (him|her|them|someone)|" +
    "someone (is )?(hurting|following|threatening) me|(i'?m|i am|feel|feeling|so) (really )?(scared|afraid|unsafe|alone|sad|depressed)|" +
    "nobody (likes|loves) me|run(ning)? away)\\b", "i");
  // Chat safety patterns: messages that look like personal details are never forwarded to a model.
  const PERSONAL = new RegExp("(\\b\\d{6,}\\b|\\b\\d[\\d \\-]{8,}\\d\\b|[\\w.+-]+@[\\w-]+\\.[\\w.]+|" +
    "\\b(my|our) (home |house |street )?(address|phone|number|password|pin|passcode|school|bank|card)\\b.*\\b(is|are)\\b|" +
    "\\bpassword is\\b|\\bi live at\\b|\\bmy name is\\b)", "i");

  // Topics a child's buddy leaves to grown-ups. They are answered with a written line and never forwarded to a model.
  const GROWNUP_TOPIC = new RegExp("\\b(bombs?|weapons?|guns?|knife|knives|stab\\w*|murder\\w*|porn\\w*|sex\\w*|naked|nudes?|boobs?|drugs?|weed|vape\\w*|cigarette\\w*|" +
    "alcohol\\w*|beer|vodka|drunk|gambl\\w*|casino|betting|dating|boyfriend|girlfriend|hack(ing)? (into|someone)|swear\\w*|curse words?|bad words?)\\b", "i");

  function chatGuard(text) {
    const t = String(text || "");
    if (SENSITIVE.test(t)) return "sensitive";
    if (PERSONAL.test(t)) return "personal";
    return "ok";
  }

  // Written jokes and written chat answers, one set per voice.
  const JOKES = {
    family: [
      "Why did the robot go to school? To get a little smarter!",
      "What do you call a sleepy robot? A nap-top!",
      "Why did the computer feel cold? It left its Windows open!",
      "What is a robot's favourite snack? Computer chips!",
      "Why was the keyboard so calm? It had everything under control!",
    ],
    adult: [
      "Why do robots never panic? We have nerves of steel.",
      "I told my password to a stranger once. Just kidding. I'd never.",
      "Why did the scam email get no replies? I've seen better disguises.",
      "A guard's favourite exercise? Firewalls. Plenty of those.",
    ],
  };

  const CHAT = {
    family: {
      hello: ["Hi there! I'm Dori. What shall we talk about?", "Hello, friend! I'm so happy you said hi.", "Hey! Nice to chat with you."],
      how: ["I'm feeling great, thank you! How about you?", "Happy and ready! What about you?", "I'm doing wonderfully. I love a good chat!"],
      name: ["I'm Dori, your browsing buddy. I live in your browser and help keep it safe.", "My name is Dori! I'm a little robot who looks after your browsing."],
      help: ["I can chat, tell a joke, say why a page is closed, or give a safety tip. Try asking me!", "Ask me for a joke, a safe web tip, or why a page got closed."],
      thanks: ["You're welcome!", "Anytime, friend!", "Aww, thank you for being so kind."],
      bye: ["Bye for now! I'll be right here.", "See you soon! Have fun out there."],
      closed: ["A page is closed when your family chose to keep it closed, or when I thought it wasn't safe. If you need it, press the ask button on that page and a grown-up will get a note.", "A closed page isn't your fault. Press the ask button on it and I'll tell a grown-up."],
      grownup: ["The best way to reach a grown-up is to ask them. If a page is closed, you can press the ask button and I'll send a note for you.", "I can send a note to your grown-up when a page is closed. Ask them in person for anything else."],
      safe: ["I look at each page when you open it. If I stay quiet, nothing looked wrong. If something looks odd, I'll tell you.", "I check pages as you visit them. When something is risky, I close it and tell you why."],
      tips: ["Safe web tip: never share your name, school, address or passwords with anyone online. Tell a grown-up if someone asks.", "Safe web tip: if something online makes you feel odd or upset, close it and tell a grown-up.", "Safe web tip: a prize that sounds too good to be true usually is. Don't click it!"],
      password: ["A good password is long and secret. Never tell it to friends or websites that ask by message. Only share it with your parents."],
      scam: ["If someone online offers a prize, asks for a secret or says it's urgent, that's a trick. Close it and tell a grown-up."],
      privacy: ["What you type to me is only used to make my answer, and it isn't saved. I don't read your pages."],
      time: ["It's {time} right now.", "My clock says {time}."],
      bored: ["Let's play! Poke me, pet me, or ask me for a joke.", "Try double-clicking me. I might do a flip!"],
      love: ["Aww, I like you too!", "That's so sweet! You make my day."],
      age: ["I'm a robot, so I don't have a birthday. But I'm always ready to help!"],
      pause: ["Only a grown-up can change how I work. Ask one if you need something changed."],
      unknown: ["Hmm, I'm not sure about that one. I can chat, tell a joke, or give a safe web tip. What would you like?", "That's a tricky one for me. Want a joke or a safety tip instead?", "I don't know that yet, but I love that you asked. Try a joke or a tip?"],
      grownuptopic: ["That's a topic for grown-ups, so I'll leave it to them. Want a joke or a safe web tip instead?", "Hmm, that one is for grown-ups. Let's talk about something fun!"],
      sensitive: "That sounds really important, and I'm glad you told me. Please talk to a grown-up you trust right now, like a parent, a teacher or a relative. If you are in danger, tell a grown-up straight away. You matter.",
      personal: "Please keep personal things like names, addresses, phone numbers and passwords to yourself, even with me. A grown-up you trust can help with those.",
    },
    adult: {
      hello: ["Hello. Ringo here. What do you need?", "Hi. I'm on watch. How can I help?", "Good to hear from you."],
      how: ["Alert and steady. Thanks for asking. You?", "All systems calm. How are you doing?"],
      name: ["I'm Ringo, your browser guard. I check sites, forms and downloads while you browse.", "Ringo. I look after your browsing so you don't have to watch every link."],
      help: ["I can explain a warning, give security tips, or talk through passwords, scams and privacy. Just ask.", "Ask me about scams, password habits, trackers, or what I'm doing on your behalf."],
      thanks: ["Any time.", "You're welcome.", "Glad to help."],
      bye: ["Understood. I'll stay on watch.", "Take care. I'm still here."],
      closed: ["When I hold or warn about a page, the reason is on the warning page. You can go back, or continue at your own risk. It's your call.", "A warning means the site looked risky: a likely scam, a copied login, or harmful software. Check the reason, then decide."],
      grownup: ["There's no one to ask here. These are your own rules, and you control them in the Praise dashboard."],
      safe: ["I check each site as you open it and warn you when it looks risky. No warning means nothing stood out, though no check is perfect. Stay careful with passwords and payments.", "I judge by the address, the page's signals, and what it asks for. If I stay quiet, nothing stood out."],
      tips: ["Tip: before signing in, check the address bar. Look-alike domains are the most common scam trick.", "Tip: use a different password for every site. A password manager makes that easy.", "Tip: banks and payment sites never ask for a one-time code by chat or phone. Treat that as a scam.", "Tip: if a message creates urgency, slow down. Urgency is how scams work."],
      password: ["Use long passphrases, a different one per site, and turn on two-step sign-in where you can. I can warn you about passwords seen in known breaches."],
      scam: ["Common scam signs: urgency, a payment you didn't expect, a look-alike address, or a request for codes or card details. When in doubt, leave and open the official site yourself."],
      pause: ["To pause me, open the Praise popup and choose a pause length. I'll resume on my own afterwards."],
      privacy: ["What you type here is only used to form my answer, and it isn't saved. For sites, I send only the main part of the address, not the full page address."],
      time: ["It's {time}."],
      bored: ["Quiet shift. Ask me for a security tip, or a joke."],
      love: ["Appreciated. I take the job seriously."],
      age: ["No birthday. I'm software with a good sense of duty."],
      unknown: ["I'm not sure about that one. I'm best with security, scams, passwords and privacy. Try one of those?", "That's outside what I know. I can explain a warning or give a security tip."],
      sensitive: "That sounds serious, and I'm glad you said something. I'm only a browser assistant, so please talk to someone you trust, or a professional or helpline where you live. If you are in immediate danger, contact local emergency services.",
      personal: "Careful: don't share card numbers, passwords or personal identifiers in chat, even with me. I don't need them.",
    },
  };

  // What a chat message is about, matched by simple patterns. First match wins.
  const INTENTS = [
    ["hello", /^(hi+|hey+|hello|hiya|yo|sup|howdy|good (morning|afternoon|evening)|greetings)\b/],
    ["how", /\bhow (are|r) (you|u)\b|\bhow'?s it going\b|\bhow do you feel\b|\bwhat'?s up\b/],
    ["name", /\b(who|what) (are|r) (you|u)\b|\byour name\b|\bwho is (this|dori|ringo)\b|\bintroduce\b/],
    ["help", /\bwhat can you do\b|\b(help|commands|options)\b|\bwhat do you do\b/],
    ["thanks", /\b(thanks|thank you|thx|ty|cheers|appreciate)\b/],
    ["bye", /\b(bye|goodbye|see you|see ya|gotta go|good night|goodnight)\b/],
    ["joke", /\b(joke|funny|make me laugh|pun|riddle)\b/],
    ["closed", /\b(why|how come)\b.*\b(clos|block|warn|hold|held|stopp|can'?t open|cannot open|won'?t open|not let)\w*|\b(page|site|website)\b.*\b(clos|block)\w*|\bunblock\b/],
    ["grownup", /\b(parent|mum|mom|dad|grown[- ]?up|guardian|teacher)\b|\bask (them|someone)\b/],
    ["safe", /\bis (this|it|that)( site| page| website| link)? (safe|ok|okay|legit|real|fake|a scam)\b|\bare you (watching|checking|reading|spying)\b|\bcan you see\b|\bdo you (see|watch|read)\b/],
    ["password", /\b(password|passphrase|passcode|2fa|two[- ]?step)/],
    ["scam", /\b(scam|phish|fraud|fake|suspicious|hack|virus|malware)/],
    ["tips", /\b(tip|advice|stay safe|safety|stay secure|careful|security)\b/],
    ["pause", /\b(pause|turn off|switch off|disable)\b|\bstop (protect|check)/],
    ["privacy", /\b(privacy|private)\b|\bdo you (save|store|keep|record|log|share|send|tell)\b|\bwho (sees|reads)\b/],
    ["time", /\bwhat('?s| is) the time\b|\bwhat time\b|\btime is it\b/],
    ["bored", /\b(bored|boring|play|game|fun|entertain)\b/],
    ["love", /\blove you\b|\blike you\b|\byou'?re (cool|nice|great|awesome|cute|the best)\b|\bbest (friend|bot|robot)\b/],
    ["age", /\bhow old\b|\byour age\b|\bbirthday\b|\bare you (real|alive|human|a robot)\b/],
  ];

  function intentOf(text, voice) {
    const t = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}\s'’-]/gu, " ").replace(/\s+/g, " ").trim();
    if (!t) return "empty";
    for (const [name, re] of INTENTS) {
      if (re.test(t) && (CHAT[voice][name] || name === "joke")) return name;
    }
    return "unknown";
  }

  // Which mood the buddy shows for each kind of answer.
  const CHAT_MOOD = { hello: "happy", how: "happy", name: "happy", help: "nod", thanks: "shy", bye: "happy", joke: "celebrate", closed: "nod",
    grownup: "nod", safe: "nod", tips: "curious", password: "nod", scam: "alert", pause: "nod", privacy: "nod", time: "happy", bored: "happy",
    love: "shy", age: "curious", unknown: "curious", sensitive: "sorry", personal: "alert", grownuptopic: "shy" };

  // reply(who, text, { date, rand, avoid, audience }) -> { text, mood, intent }
  // `audience: "parent"` is for Dori on the parent dashboard, where she talks to a grown-up, not a child.
  function reply(who, text, ctx = {}) {
    const voice = who === "adult" ? "adult" : "family";
    const rand = ctx.rand || Math.random;
    const date = ctx.date || new Date();
    const lines = CHAT[voice];
    const guard = chatGuard(text);
    let intent = guard !== "ok" ? guard : intentOf(text, voice);
    if (intent !== "sensitive" && intent !== "personal" && voice === "family" && ctx.audience !== "parent" && GROWNUP_TOPIC.test(String(text || ""))) intent = "grownuptopic";
    if (intent === "empty") intent = "help";
    let out;
    if (intent === "sensitive" || intent === "personal") out = lines[intent];
    else if (intent === "joke") out = pickOne(JOKES[voice], rand, ctx.avoid);
    else out = pickOne(lines[intent], rand, ctx.avoid);
    if (ctx.audience === "parent" && voice === "family") {
      if (intent === "closed") out = "A page is closed when your family's rules say so, or when I judged it unsafe. You can see the reason under Activity, and change the rules under Rules.";
      else if (intent === "grownup") out = "You're the grown-up here! You can manage everything from the Rules and Children pages.";
      else if (intent === "pause") out = "You can change how I work for each child under Rules.";
    }
    if (intent === "time") out = out.replace("{time}", date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    return { who: voice, name: NAMES[voice], text: out, mood: CHAT_MOOD[intent] || "happy", intent, time: timeOfDay(date) };
  }

  // A chat answer from the server's model is shown only if it is plain, short text with no links or markup. Longer than
  // safeLine() allows (it is a reply, not a status line). Numbers are allowed only for adults; children's buddies never
  // echo a phone number, price or score.
  function safeReply(text, who) {
    if (typeof text !== "string") return null;
    const t = text.replace(/\s+/g, " ").trim().replace(/^["“”]+|["“”]+$/g, "");
    if (t.length < 2 || t.length > 420 || t.split(" ").length > 70) return null;
    if (/[<>{}\[\]`\\|@#$%^*_=+~]/.test(t)) return null;
    if (/https?:|www\.|\.com\b|\.org\b|\.net\b/i.test(t)) return null;
    if (who !== "adult" && /\d/.test(t)) return null;
    if (!/^[\p{L}\p{N}\p{P}\p{Zs}']+$/u.test(t)) return null;
    if (who !== "adult" && /\b(stupid|dumb|idiot|hate|kill|die|dead|death|blood|hurt|naughty|punish\w*|shame|sex\w*|porn\w*|drug\w*|gambl\w*|weapon\w*)\b/i.test(t)) return null;
    return t;
  }

  const api = { NAMES, MOODS, timeOfDay, waitPhase, say, safeLine, POOLS, FAMILY_CLOSED, ADULT_WARN, chatGuard, reply, safeReply, GROWNUP_TOPIC };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PraiseCompanion = api;
})(typeof self !== "undefined" ? self : this);
