// Is a typed prompt a durable correction? (plan L4a step 3; gate: precision
// >= 0.85 and recall >= 0.6 on the held-out extractor corpus.)
//
// Durable: an instruction, preference or stable project fact that should
// change what the agent does in a later, unrelated task, statable in one line
// from the prompt alone. Not durable, even when worded like a rule: one-off
// requests about this turn's artifact, scoped or temporary instructions,
// questions and hypotheticals, approvals, task requests, pasted machine
// output, quoted comments the user doesn't adopt, corrections of the current
// bug or output, status reports.
//
// Deterministic and offline: the prompt is cleaned (private spans, code
// fences, quoted lines and machine output removed), split into clauses, and a
// clause counts when it carries a rule marker and no disqualifier. Markers are
// evidence, not proof: "we never got the email" is a status report, "for now,
// skip the tests" is scoped. Weak markers (an "X, not Y", a bare "always") don't
// count in a prompt that is otherwise about this turn's work.
//
// Tuned on a development set written apart from the held-out corpus
// (test/fixtures/mistakes/dev-prompts.jsonl); the held-out corpus is only ever
// scored, never read item by item (plan D29).

import { stripPrivate } from "../digest/sanitize.mjs";

// ---- cleaning -------------------------------------------------------------

const MACHINE_LINE = [
  /^\s*at\s+(?:async\s+)?[\w.$<>[\]]+\s*\(.*\)\s*$/, // JS stack frame
  /^\s*at\s+\S+:\d+:\d+\s*$/,
  /^\s*File "[^"]+", line \d+/, // Python traceback
  /^\s*Traceback \(most recent call last\)/,
  /^\s*(?:error|warning|warn|fatal|hint|note|remote|npm err!|npm warn|err!|caused by|exception|panic|info|debug|trace)\b\s*[:!\]]/i,
  /^\s*\[(?:info|warn|warning|error|debug|trace|fatal)\]/i,
  /^\s*(?:npm|yarn|pnpm|pip|cargo|go|git|docker|kubectl)\s+(?:err|warn|error|warning)\b/i,
  /\berror\s+TS\d{3,5}\b/i,
  /^\s*[\w./\\@-]+\.[a-z]{1,5}:\d+(?::\d+)?\b/i, // file:line(:col)
  /^\s*\d+:\d+\s+(?:error|warning|warn)\b/i, // eslint body line
  /\s(?:@typescript-eslint|eslint|react-hooks|import|prettier|jsx-a11y)\/[a-z-]+\s*$/i,
  /\s{2,}(?:no|prefer|max|require)-[a-z-]+\s*$/, // eslint rule id at the end
  /^\s*(?:\$|PS [A-Z]:\\[^>]*>|>>>|#)\s+\S/, // shell prompts
  /^\s*[│├└┌┐┘┬┴┼─╭╮╰╯]+/,
  /^\s*\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/, // log timestamps
  /^\s*(?:✖|✔|✓|×|⚠|❯|›|»|●|○)\s/,
  /^\s*(?:To|From)\s+(?:https?:\/\/|git@|ssh:\/\/)/,
  /^\s*!\s+\[(?:rejected|remote rejected)\]/,
  /^\s*(?:\+\+\+|---|@@)\s/,
  /^\s*(?:modified|deleted|new file|renamed):\s+\S/,
  /^\s*(?:Usage|usage|Options|Commands|Arguments|Flags):(?:\s|$)/,
  /^\s*-{1,2}[\w-]+(?:[ =]<?[\w-]+>?)?(?:,\s*-{1,2}[\w-]+)?\s{2,}\S/, // CLI help option rows
];

const looksMachine = (line) => MACHINE_LINE.some((re) => re.test(line));

/** The user's own words: private spans, fenced code, quoted lines and machine output removed. */
export function ownWords(text) {
  let t = stripPrivate(String(text ?? ""));
  t = t.replace(/```[\s\S]*?(?:```|$)/g, "\n").replace(/~~~[\s\S]*?(?:~~~|$)/g, "\n");
  // A 200-character word is pasted data (base64, minified code, a hash), never a rule.
  t = t.replace(/\S{200,}/g, " ");
  return t
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l) && !looksMachine(l))
    .join("\n")
    .trim();
}

/** Lines quoted with ">" (a review comment, a message from someone else). */
function quotedLines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter((l) => /^\s*>\s*\S/.test(l))
    .map((l) => l.replace(/^\s*>\s*/, "").trim());
}

const normalise = (s) =>
  s
    .replace(/[’‘`´]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\bnever ?mind\b/gi, "nm") // an idiom, not a rule
    .replace(/\b(?:alwyas|allways|alway|awlays|alwasy)\b/gi, "always")
    .replace(/\b(?:nver|nevr|neve)\b/gi, "never")
    .replace(/\s+/g, " ")
    .trim();

// Words in double quotes (three or more) are someone else's: a review comment,
// a message, an error. They only count when the user adopts them.
const QUOTED_SPAN = /"[^"\n]*\b\w+\s+\w+\s+\w+[^"\n]*"/g;

// Bounds that keep the regexes linear on a pasted wall of text: rules sit in
// short clauses, and a prompt's rule is rarely past its 80th clause.
const MAX_CLAUSES = 80;
const MAX_CLAUSE = 600;

/** Split into clauses that can each carry one rule. */
export function clauses(text) {
  return text
    .slice(0, MAX_CLAUSES * MAX_CLAUSE)
    .split(/(?<=[.!?])\s+|\n+|;\s+|\s+[–—]\s+|,\s*(?:and|but|also|plus)\s+(?=(?:remember|always|never|don'?t|do not|dont|we|please|stop|use|keep|make sure|from now on|going forward|when you|whenever)\b)|\s+(?:and|but|also)\s+(?=(?:remember|always|never|don'?t|do not|dont|please|stop|from now on|going forward|make sure|when you|whenever)\b)/i)
    .slice(0, MAX_CLAUSES)
    .map((c) => normalise((c ?? "").slice(0, MAX_CLAUSE)))
    .filter((c) => c.length >= 3);
}

// ---- markers --------------------------------------------------------------

// Each alternative is one word, so the repeat can't split a word two ways
// ("ok so" next to "ok" and "so" made this exponential).
const LEAD = String.raw`^(?:(?:no|nope|nah|ugh|argh|hey|ok|okay|please|pls|plz|and|also|but|so|again|seriously|look|listen|guys|bro|dude|man|yaar|bhai|wrong|actually|btw|oh|hmm|uh|nm|fyi)[,.!:]*\s+)*`;
const PROHIBIT = new RegExp(LEAD + String.raw`(?:please\s+|pls\s+)?(don'?t|dont|do not|never|stop|quit|avoid|no more|enough with|cut it out with)\b\s*(?:ever\s+)?([a-z']+)?`, "i");

// After "stop"/"don't": words that make it about this turn only.
const ONE_OFF_NEXT = new Set(["it", "that", "this", "now", "here", "there", "yet", "for", "please", "right", "the", "doing", "worrying", "bothering", "wait", "waiting", "mind", "and", "worry", "forget", "bother", "overthink", "overcomplicate", "hesitate", "panic", "stress", "rush", "gonna", "be"]);

const DURABLE = /\b(?:from now on|going forward|moving forward|henceforth|hereafter|in (?:the )?future|next time|whenever (?!you (?:get|can|have|are|'re)\b)|any ?time (?:you|we)|from here on(?: out)?|every ?(?:single )?time|each time|all the time|in (?:all|every) (?:file|component|test|module|project|repo|case|place|function|commit|pr|branch|service|package)s?|everywhere|across the (?:repo|project|codebase|board|app)|project[- ]wide|repo[- ]wide|by default|as a (?:general )?rule|standing rule|make (?:it|this|that) a rule|in general|ever again|any ?more|again and again|at all times|for all (?:future )?(?:tasks|work|changes|code)|ab se|abhi se|aaj se|aage se)\b/i;
const ALWAYS_NEVER = /\b(?:always|never)\b/i;
const OBJ = String.raw`[^\s,;!?]+(?:\s+[^\s,;!?]+){0,3}?`;
const USE_INSTEAD = new RegExp(String.raw`\b(?:use|using|prefer|switch to|go with|stick (?:to|with)|run|write|call|import)\s+(${OBJ})\s*,?\s+(?:not|instead of|rather than|over|and not|never|in place of)\s+[^\s,;!?]+`, "i");
const INSTEAD_USE = /\b(?:instead of|rather than)\s+[^\s,;!?]+(?:\s+[^\s,;!?]+){0,2}\s*,?\s+(?:use|prefer|we use|run|call)\s+[^\s,;!?]+/i;
const X_NOT_Y = /(?:^|\s)([\w.@/:+#'-]{0,64}[a-z0-9][\w.@/:+#'-]{0,64})\s*,?\s*not\s+((?:plain\s+|just\s+)?[\w.@/:+#-]{1,64}(?:\s+[\w.@/:+#-]{1,64}){0,2})\s*[.!]*$/;
const WE_RULE = /\b(?:we|our team|our codebase|our convention|in this (?:project|repo|codebase|team|house)|this (?:project|repo|codebase|team)|humare yahan|hamare yahan|humare project|hamare project)\s+(?:(?:always|usually|only|generally|strictly|do|all|don'?t ever)\s+)?(?:use|uses|prefer|prefers|don'?t|dont|do not|never|always|stick|standardi[sz]e|write|name|keep|put|store|run|deploy|follow|avoid|require|target|support|ship|squash|rebase|lint|format|pin|vendor|mock|log|tag|version|indent|document|moved to|switched to|migrated to|dropped|banned)\b/i;
const OUR_FACT = /\b(?:our|the project'?s|this project'?s|this repo'?s)\s+[\w -]{2,30}\s+(?:is|are|lives|runs|uses|goes|sits)\b/i;
const PREFER = /\b(?:i|we)(?:'d| would) (?:really |much )?(?:prefer|rather)\b|\b(?:i|we) (?:really |strongly |much |always |generally )?(?:prefer|like it when|like to|hate (?:it )?when|don'?t like (?:it )?when|dislike|can'?t stand|want (?:all|every|each|you to always|you to never|you to stop))\b|\bmujhe\b.*\b(?:pasand nahi|pasand hai|nahi chahiye|accha nahi lagta)\b/i;
const REMEMBER = /\b(?:remember(?: that| to)?|keep in mind|note that|for the record|make sure (?:you |to )?(?:always|never)|important:|rule:|reminder:)/i;
const FRUSTRATED = /\b(?:how many times|for the (?:second|third|fourth|fifth|nth|\d+(?:st|nd|rd|th)) time|i (?:already |just |literally )?(?:told|said|asked|mentioned)|i'?ve (?:already )?(?:told|said|asked|mentioned)|as i (?:said|mentioned)|like i said|you keep|you always|you never|stop doing (?:that|this)|kitni (?:baar|bar|dafa)|bola tha|kaha tha|bataya tha|who told you to)\b|\b(?:phir se|fir se|dobara)\b(?=.*\b(?:kar diya|kiya|diya|likha|lagaya|daala|daal diya|use)\b)/i;
const RHETORICAL = /\bwhy (?:are|do|did|is|would|does) you\b.*\b(?:again|still|keep|keeps)\b|\bhow many times\b|\bkitni (?:baar|bar)\b|\bkyu?n?\b.*\b(?:phir se|fir se|baar baar|dobara|har baar|har bar)\b|\b(?:har baar|har bar|baar baar)\b.*\bkyu?n?\b|\bwho told you to\b/i;
const AGAIN_YOU = /\byou(?:'ve| have)?\s+(?:\w+ed|did|wrote|made|put|went|broke|forgot|ignored|used)\b.*\bagain\b/i;
const SCOPE_IMPERATIVE = new RegExp(LEAD + String.raw`(?:please\s+)?(?:always\s+)?(?:only\s+)?(?:use|prefer|stick to|follow|format|name|indent|import|store|keep|put|target|pin|install(?: with)?|run (?:everything|all|tests|commands) (?:with|through|via))\b.*\b(?:here|in this (?:project|repo|codebase|app|package|service|monorepo|workspace)|for this (?:project|repo|codebase)|in (?:our|the) (?:repo|project|codebase)|everywhere|across)\b`, "i");
const UNIVERSAL = /\b(?:every|each|all|any|saari|saare|sab) [\w-]+(?: [\w-]+)? (?:needs?|must|should|has to|have to|goes|go|lives?|belongs?|comes?|gets?|requires?|uses?|hain|hai)\b|\b(?:nothing|no one|nobody|no code|no file|no module|no component) (?:else )?(?:should|may|can|reads|writes|calls|imports|touches|uses)\b/i;
const PLURAL_MODAL = /^(?:all |our |new )?[a-z][\w-]*s (?:must|must not|mustn'?t|should always|should never|should not|shouldn'?t|have to|need to|always|never)\b|\b[a-z]+ (?:must|should) (?:always|never) /i;
const NO_NOUN = /(?:^|,\s*)(?:no|zero) (?!rush|worries|problem|need|thanks|idea|way|wait|change|luck)[\w().'"/-]+(?: [\w().'"/-]+){0,3} (?:in|inside|anywhere|outside|on|at|for)\b|\bno [\w().'"/-]+(?: [\w-]+){0,3} (?:ever|anywhere|at all)\b/i;
const ONLY_RULE = /^(?:[\w/+.#-]+(?:\s+[\w/+.#-]+)?) only\s*[.!]*$|\bonly (?:ever )?use\b|\b(?:only|sirf) (?:allowed|permitted)\b|\b(?:allowed|permitted) only\b|\bsirf\b.*\ballowed\b/i;
const CASE_STYLE = /\b(?:pascal ?case|camel ?case|snake_case|snake case|kebab-case|kebab case|screaming_snake|upper ?case|lower ?case|title case|conventional commits)\b/i;
const NAMING = /^(?:please\s+)?(?:name|prefix|suffix|call)\s+(?:all |new |every |our )?[\w -]*?s\s+(?:in|with|as|using|after|like)\b/i;
const KEEP_RULE = /^(?:please\s+)?keep (?:all |every |each |our |the |your )?[\w-]+s (?:under|below|short|small|less than|within|to at most)\b/i;
// Praise and thanks: "you always do great work" is not a rule.
const PRAISE = /\b(?:great|good|nice|awesome|amazing|excellent|perfect|solid) (?:work|job|stuff|catch)\b|\bthank(?:s| you)\b|\blgtm\b|\blooks good\b|\bwell done\b/i;
const PLACE_RULE =/^(?:please\s+)?(?:put|place|keep|store|save|add|write)\s+(?:all |new |every |any |our )?[\w-]+(?: [\w-]+)?s\s+(?:in|under|into|inside)\s+[\w./\\@-]*[/\\]/i;
const TOPIC_RULE = /^(?:commit messages?|branch names?|naming|formatting|imports|logging|errors?|error handling|docs|comments|prs?|pull requests?|tests?|style|code style|migrations?|env vars?|secrets|dates?|timestamps?)\s*:\s*\S/i;
const COMMUNICATION = /^(?:please\s+)?(?:talk|speak|reply|respond|answer|write|explain|summari[sz]e|keep (?:your )?(?:answers|replies|responses|messages))\b.*\b(?:to me|in (?:plain|simple|short|english|hindi|bullet)|bullets?|short|brief|concise|shorter)\b/i;
const CONDITIONAL = /\b(?:when|whenever|after|before|once) you (?:finish|change|add|touch|edit|create|write|commit|push|open|make|modify|update|start|are done|'re done|do a|install|bump)\b/i;
const FACT_NOUN = /\b(?:port|version|node|python3?|py|java|jdk|golang|ruby|php|rust|postgres(?:ql)?|mysql|mongo(?:db)?|redis|sqlite|host|hostname|base url|url|endpoint|domain|default branch|main branch|branch|deploy(?:s|ed)?|staging|production|prod|shell|terminal|machine|windows|macos|mac|linux|ubuntu|powershell|bash|zsh|ids?|uuids?|timezone|region|bucket|database|db|registry|package manager|runtime|framework|api|server|backend|frontend|cluster|namespace|env file|config file|lockfile|docs)\b/i;
const FACT_SHAPE = /\b(?:is|are|runs|run|lives|live|sits|uses|use|goes|listens|deploys|'s|hain|hai)\b[^?!]*?\b(?:not|never|instead|nahi)\b|\b(?:runs|lives|listens|sits|is|are)\s+(?:on|at|in)\s+(?:port\s+)?[\w.:/-]*\d|\b(?:is|are)\s+(?:called|named)\b|\bnot\s+[\w.:/-]*\d|\b(?:runs|is deployed|deploys|is hosted|lives|goes) (?:on|to|in|at|via) (?:the )?[\w./-]+|\b(?:this machine|this box|this laptop) (?:is|has|runs)\b|\b(?:we'?re|we are|i'?m|i am) on (?:windows|mac|macos|linux|ubuntu|node|python|powershell|bash|zsh)\b/i;
const NO_PREFIX = /^(?:no|nope|nah|wrong|incorrect|actually|nahi|galat)\b[,.!:]?\s+(?:it'?s|its|we|use|you should|that'?s not how we|the|our|this is|this project)\b|^(?:no|nope|wrong|actually|nahi|galat)\b[,.!:]?\s+.*\bnot\b/i;
const HINGLISH = /\bmat [a-z]+(?:na|o|iye|ein)\b|\bmat (?:use|kar)\b|\bkabhi\b.*\b(?:mat|nahi|nahin)\b|\bhamesha\b|\bhumesha\b|\bhar (?:baar|bar|jagah|time|ek|[a-z]+ (?:pe|par|mein|me|ke))\b|\byaad rakh(?:na|o|iye|ein)\b|\bis (?:project|repo|codebase) (?:mein|me|mai|ke liye)\b|\bnahi chahiye\b|\bband karo\b|\b(?:likha|lagaya|banaya|kiya|chalaya) karo\b|\b(?:aage se|ab se|abhi se|aaj se)\b/i;

// ---- disqualifiers --------------------------------------------------------

const QUESTION_START = /^(?:(?:so|ok|okay|hey|and|but|also|btw|quick question)[,.!:]*\s+)*(?:should|could|can|would|will|shall|is|are|am|do(?!\s+not\b)(?!n'?t)|does(?!n'?t)|did(?!n'?t)|was|were|what|why|how|which|where|when(?! you\b)|who|whose|any idea|have you|has|kya|kyu|kyun|kaise|kahan|kab|kaun)\b/i;
// "can you please always …" is a request, not a question: judged without its opening.
const POLITE = /^(?:(?:so|ok|okay|hey|and|but|also|btw)[,.!:]*\s+)*(?:can|could|would|will) you (?:please |pls |kindly )?(?=(?:always|never|stop|not|remember|use|make sure|keep|avoid|don'?t|start|prefer|stick)\b)/i;
const HYPOTHETICAL = /\b(?:what if|if (?:we|i) (?:were|was|did|had|could|switched|moved|used|went|changed|migrated|ever)\b|maybe|perhaps|might|could we|should we|would it|i wonder|wondering|thinking (?:of|about)|considering|not sure|do you think|is it (?:better|worth|possible|ok|okay)|shall we|any chance|agar|kya hum|socho)\b/i;
const SCOPE_WORDS = String.raw`for now|for the moment|for the time being|right now|at the moment|this time|just this once|just once|this once|only this time|for today|temporar(?:y|ily)|until (?:we|i|the|it|further|next|tomorrow|monday|friday|later)|yet|for this (?:pr|pull request|feature|ticket|task|test|one|file|function|component|commit|change|branch|release|sprint|run|session|bug|fix|endpoint|page|module|story|issue|case|script|migration|demo|step|class|method|screen|query|patch|spike|prototype|poc|experiment|chat|conversation|thread)|in this (?:pr|pull request|commit|branch|test|function|file|component|method|class|module|script|migration|step|session|chat|conversation|thread)|on this (?:pr|branch|ticket|one)|abhi ke liye|abhi(?! se| tak)|filhal|is baar|sirf is (?:baar|pr|file|test|function)|sirf abhi|ruko`;
// "not just in this module" widens the rule; it doesn't scope it.
const SCOPED = new RegExp(String.raw`(?<!not just |not only |beyond |outside (?:of )?|and not )\b(?:${SCOPE_WORDS})\b`, "i");
const STATE_VERB = String.raw`(?:seems|seemed|fails|failed|failing|happens|happened|crash(?:es|ed)|works|worked|breaks|broke|times out|timed out|hangs|hung|returns|returned|shows|showed|gets|got|receives|received|saw|sees|loads|loaded|came|comes|ends up|ended up|errors|errored|flakes|flaked|passes|passed|throws|threw|takes|took|runs out|ran out|ran|loses|lost|stuck|freezes|froze|reached|reaches|fired|fires|triggered|started|finished|completed|showed up|arrived|synced|executed|picks up|picked up|even (?:reached|called|runs|ran|gets|hit))`;
const STATUS = new RegExp(
  String.raw`\b(?:always|never|keeps?|kept|every ?(?:single )?time)\s+${STATE_VERB}\b` +
    String.raw`|\bwe (?:never|always) (?:got|get|received|receive|saw|see|heard|hear|had|found|find|managed|could|knew|figured)\b` +
    String.raw`|\b(?:it|this|that|the (?:build|test|tests|ci|pipeline|deploy|deploys|app|server|job|cron|page|request|query))\s+(?:always|never)\b` +
    String.raw`|\b(?:was|were|is) never (?:even )?\w+ed\b` +
    String.raw`|\bi (?:always|never)\b(?! (?:want|need|use|prefer|run|write|do|work|like))` +
    String.raw`|\b(?:is|are|was|went|seems) (?:down|offline|unreachable|slow|flaky|failing|broken|red)\b|\balways the same\b|\bsame (?:error|thing|issue|problem) again\b|\bnever (?:gonna|going to)\b|\bnever (?:seen|heard|had|been|noticed|happened|knew)\b` +
    String.raw`|\bevery ?(?:single )?time (?:i|we)\b.*\b(?:hangs|fails|crash(?:es)?|breaks|freezes|times out|errors|throws|dies|stalls|shows|gets stuck|goes)\b` +
    String.raw`|\b(?:last night|yesterday|this morning|earlier today|last week|since (?:last|yesterday|monday|tuesday|wednesday|thursday|friday|the (?:last|latest) (?:deploy|release|update|upgrade|merge))|an? (?:hour|day|week|few minutes) ago)\b` +
    String.raw`|\b(?:hota hai|hoti hai|hote hain|ho jata|ho jati|aata hai|aati hai|aa raha|aa rahi|aa gaya|aa gayi|ho raha|ho rahi|ho gaya|ho gayi|nahi dekha|nahi chal raha|nahi chala|fail ho|raha hai|rahi hai|rahe hain)\b`,
  "i",
);
const CODE_STATE = /\b(?:the|this|that) (?:bug|issue|problem|error|crash|failure|regression|leak|culprit) (?:is|was|comes|happens|lives|seems)\b|\b(?:should|must) (?:return|equal|output|print|show|give|yield)\b|\b(?:should|must) be\s+(?:[-\d"']|true|false|null|none|an? empty|zero|undefined)|\b(?:the )?(?:output|result|total|value|answer|count|sum|response|status code|return value) (?:should|must|is supposed to) be\b|\bis (?:wrong|broken|incorrect|off by)\b|\bexpected\s+[-\d"']|\bthat'?s (?:wrong|not right|incorrect)\b|\bthat'?s (?:the|your|our) (?:bug|issue|problem|cause|mistake)\b/i;
const EXPLAINS_BUG = /\b(?:that'?s why|which is why|that'?s what'?s (?:causing|breaking)|that'?s the (?:cause|reason|bug)|is causing (?:the|this|it))\b/i;
const ONE_OFF_VERB = /\b(?:do|did|change|touch|revert|undo|remove|delete|move|rename|keep|add|write|fix|redo|rewrite|try|push|commit|merge|open|close|use|apply|ship|drop|restore|copy|paste|edit|modify|replace|reset|need|want)\s+(?:that|this|it|these|those)\b(?!\s+(?:again|ever|anymore|any more|everywhere|in (?:every|all)))/i;
const ONE_OFF_REF = /\b(?:the (?:first|second|third|last|other|previous|earlier|original|new|old|latest|top|bottom) (?:one|option|approach|version|suggestion|solution|way|file|function|change|attempt|idea|answer|draft|commit|method|class|component|test)|that one|this one|the other one|option (?:a|b|c|1|2|3|one|two)|approach (?:a|b|1|2)|that (?:file|function|line|change|commit|test|method|class)|this (?:file|function|line|change|commit|test|method|class)|you just (?:added|wrote|made|created|changed|did|put|removed)|(?:ye|yeh|isko|usko|wo|woh) (?:mat|nahi)|(?:ye|yeh|is|iss|wo|woh|us) (?:file|function|line|wala|wali|component|test|change|commit)|leave (?:it|that|this|the \w+) (?:as|alone)|as it is|anything else|the other \w+|(?:the|that|this) \w+ one|just (?:fix|do|answer|finish|try) (?:it|this|that|the)|(?:don'?t|dont|do not) \w+ anything(?! (?:else )?(?:in|under|inside|within|below|from|on|at|without|unless|that|until|outside))|one more time)\b/i;
const REVIEW_ATTRIBUTION = /\b(?:reviewer|review comment|code review|pr comment|comment (?:says|said|on line)|on (?:my|the|this) pr|left a comment|(?:he|she|they|my lead|our lead|tech lead|the lead|manager|teammate|colleague|someone|qa|copilot|the linter|the bot|coderabbit|sonar) (?:said|says|wrote|mentioned|commented|suggested|asked|left|flagged|wants))\b/i;
const ADOPTED = /\b(?:follow (?:that|this|it|them)|from now on|going forward|let'?s do that|we'?ll do that|adopt|make (?:it|that|this) a rule|standing rule|treat (?:it|this|that) as a rule|do that everywhere|agree(?:d)?[,.]? (?:let'?s|so|always|never)|that'?s our rule now|apply (?:that|this) everywhere|(?:that|this|the) (?:comment|review|suggestion)(?: from the review)? is right)\b/i;
const TASK_START = /^(?:please\s+)?(?:refactor|convert|rewrite|update|migrate|change|modify|fix|move|rename|port|switch|make|edit|clean up|redo|implement|create|build|add|write)\b/i;

// Markers that only count when the rest of the prompt isn't about this turn's work.
const WEAK = new Set(["x-not-y", "always-never", "hinglish", "remember", "style"]);

/**
 * Judge one clause.
 * @param {string} clause  as written (case kept: camelCase names are code, not tools)
 * @returns {{rule:boolean, why:string, weak?:boolean}}
 */
export function judgeClause(clause) {
  const lower = clause.toLowerCase();
  const s = POLITE.test(lower) ? lower.replace(POLITE, "").replace(/\?+\s*$/, "") : lower;
  const rhetorical = RHETORICAL.test(s);
  const question = /\?\s*(?:[^\w\s]{0,4})?\s*$/.test(s) || QUESTION_START.test(s);
  if (question && !rhetorical) return { rule: false, why: "question" };
  if (HYPOTHETICAL.test(s) && !FRUSTRATED.test(s)) return { rule: false, why: "hypothetical" };
  if (SCOPED.test(s)) return { rule: false, why: "scoped" };
  if (PRAISE.test(s) && !PROHIBIT.test(s)) return { rule: false, why: "approval" };
  if (STATUS.test(s) && !/\byou (?:always|never|keep)\b/i.test(s)) return { rule: false, why: "status" };
  const task = TASK_START.test(s);
  const fact = !task && FACT_NOUN.test(s) && (FACT_SHAPE.test(s) || NO_PREFIX.test(s));
  if (CODE_STATE.test(s) && !fact) return { rule: false, why: "code-state" };
  const durable = DURABLE.test(s) || /\b(?:again|ever|anymore)\b/i.test(s) || /^\W*(?:always|never)\b/.test(s);
  if ((ONE_OFF_VERB.test(s) || ONE_OFF_REF.test(s)) && !durable) return { rule: false, why: "one-off" };

  const p = PROHIBIT.exec(s);
  if (p) {
    const next = p[2] ?? "";
    // "don't push" names no object: this turn's push. "never push" or "don't push to main" is a rule.
    const bare = /^(?:don'?t|dont|do not)$/.test(p[1]) && !s.slice(p.index + p[0].length).replace(/[\s.!,;:?]+/g, "");
    if (next && !ONE_OFF_NEXT.has(next) && !bare) return { rule: true, why: "prohibition" };
    // A leading "never" alone doesn't rescue "never gonna …" or "stop it".
    if (DURABLE.test(s) || /\b(?:again|ever|anymore)\b/i.test(s)) return { rule: true, why: "prohibition" };
  }
  if (DURABLE.test(s)) return { rule: true, why: "durable" };
  if (FRUSTRATED.test(s) || AGAIN_YOU.test(s) || rhetorical) return { rule: true, why: "repeat" };
  if (!task) {
    const ui = USE_INSTEAD.exec(s);
    const iu = ui ? null : INSTEAD_USE.exec(s);
    if (ui || iu) {
      const obj = ui ? ui[1] : iu[0].replace(/^\w+(?: of| than)?\s+/, "");
      // "call it fetchUsers, not getUsers": naming this turn's code. "use a drawer instead of a modal": one design choice.
      // "use 4, not 3": a value for this task.
      const numbers = /^[\d.,]+\s*,?\s*(?:not|instead of|rather than|over)\s+[\d.,]+\b/.test((ui ?? iu)[0].replace(/^\w+\s+/, ""));
      // "we use logInfo, not console.log" states the team's convention: a rule, code name or not (teamConvention).
      if (/^(?:it|this|that|these|those|them)\b/.test(obj) || (hasCodeName(clause, (ui ?? iu)[0]) && !teamConvention(s, ui)) || numbers) return { rule: false, why: "one-off" };
      // "a drawer instead of a modal" is one design choice; "the logger, not console.log" may be a rule.
      if (/^(?:a|an)\s/.test(obj) || /\b(?:instead of|rather than) (?:a|an)\s/.test(s)) return { rule: false, why: "one-off" };
      return /^the\s/.test(obj) || /\b(?:instead of|rather than) the\s/.test(s) ? { rule: true, why: "use-instead", weak: true } : { rule: true, why: "use-instead" };
    }
  }
  if (WE_RULE.test(s) || OUR_FACT.test(s)) return { rule: true, why: "we" };
  if (PREFER.test(s)) return { rule: true, why: "preference" };
  if (COMMUNICATION.test(s)) return { rule: true, why: "communication" };
  if (CONDITIONAL.test(s) && !task) return { rule: true, why: "conditional" };
  if (UNIVERSAL.test(s) || PLURAL_MODAL.test(s) || NO_NOUN.test(s) || ONLY_RULE.test(s)) return { rule: true, why: "universal" };
  if (TOPIC_RULE.test(s) || NAMING.test(s) || PLACE_RULE.test(s) || KEEP_RULE.test(s)) return { rule: true, why: "convention" };
  if (SCOPE_IMPERATIVE.test(s)) return { rule: true, why: "project-scope" };
  if (fact) return { rule: true, why: "fact" };
  if (ALWAYS_NEVER.test(s)) return { rule: true, why: "always-never", weak: true };
  if (REMEMBER.test(s)) return { rule: true, why: "remember", weak: true };
  if (HINGLISH.test(s)) return { rule: true, why: "hinglish", weak: true };
  if (CASE_STYLE.test(s) && !task) return { rule: true, why: "style", weak: true };
  const xy = X_NOT_Y.exec(s);
  if (xy && !task) {
    const [x, y] = [xy[1], xy[2].replace(/^(?:plain|just)\s+/, "")];
    const aux = /^(?:is|are|was|were|do|does|did|can|could|should|would|will|has|have|had|may|might|must|why|or|if|and|but|it'?s|that'?s|i'?m|its|me|sure|yes|ok|okay|and)$/;
    const vague = /^(?:sure|yet|now|working|really|a|an|the|quite|that|this|it|so|too|very|bad|good|needed|necessary|required|done|me|you|us|them|there|exactly|always|only|even|much|enough|bad)$/;
    // "4, not 3" is a value for this task; a port or a version is a fact (handled above).
    const numbers = /^[\d.,]+$/.test(x) && /^[\d.,]+$/.test(y);
    if (!hasCodeName(clause, xy[0]) && !numbers && !aux.test(x) && !vague.test(y.split(/\s+/)[0])) return { rule: true, why: "x-not-y", weak: true };
  }
  return { rule: false, why: "no marker" };
}

// The team's convention, not this turn's code: "we" (our team, in this repo) is the subject of
// the use itself ("actually we use logInfo, not console.log"), and nothing ties it to this turn
// ("now we use …", "we use fooBar here", "in that call", "after your refactor").
const TEAM_SUBJECT = /\b(?:we|our team|our codebase|in this (?:project|repo|codebase|team))\s+(?:(?:always|usually|only|generally|strictly|all)\s+)?$/i;
const TURN_ADJUNCT = /\b(?:now|here|in (?:that|this|the) (?!(?:project|repo|codebase|team|house)\b)\w+|after (?:your|the|this) \w+|for (?:this|that) (?:one|call|file|function))\b/i;
function teamConvention(s, ui) {
  return Boolean(ui) && /^(?:use|using|prefer|stick)\b/i.test(ui[0]) && TEAM_SUBJECT.test(s.slice(0, ui.index)) && !TURN_ADJUNCT.test(s);
}

/** Does this part of the clause name code (an internal capital: parseHeaders, fetchUsers)? */
function hasCodeName(clause, part) {
  const names = clause.match(/\b[a-z]+[A-Z]\w*\b/g);
  if (!names) return false;
  const lowerPart = part.toLowerCase();
  return names.some((n) => new RegExp(String.raw`(?:^|[^\w])${n.toLowerCase()}(?:[^\w]|$)`).test(lowerPart));
}

// A positive clause that is only frustration ("every single time") names no rule.
const CONTENTLESS = /^(?:\W*(?:ugh|argh|seriously|again|bro|yaar|come on)\W*)*(?:every ?(?:single )?time|how many times|again|seriously|kitni baar|for the \w+ time)\W*$/i;

/**
 * Classify a typed prompt.
 * @param {string} prompt
 * @returns {{correction:boolean, sentence:string|null, why:string}}
 */
export function classifyPrompt(prompt) {
  const raw = String(prompt ?? "");
  const quoted = quotedLines(raw);
  const words = ownWords(raw);
  const adopted = ADOPTED.test(words);
  // The user adopts a quoted comment: the comment is the rule.
  if (adopted && quoted.length) return { correction: true, sentence: tidy(normalise(quoted[0])), why: "adopted" };
  if (!words) return { correction: false, sentence: null, why: "no own words" };
  if (REVIEW_ATTRIBUTION.test(words) && !adopted) return { correction: false, sentence: null, why: "quoted review" };
  const own = adopted ? words : words.replace(QUOTED_SPAN, '""');
  const list = clauses(own);
  const judged = list.map((c) => ({ c, j: judgeClause(c) }));
  const turnBound = judged.some(({ j }) => j.why === "one-off") || EXPLAINS_BUG.test(own);
  let last = "no marker";
  for (let i = 0; i < judged.length; i++) {
    const { c, j } = judged[i];
    if (!j.rule) {
      last = j.why;
      continue;
    }
    if (j.weak && turnBound) {
      last = "weak in a turn-bound prompt";
      continue;
    }
    const sentence = CONTENTLESS.test(c) && judged[i + 1] ? judged[i + 1].c : c;
    return { correction: true, sentence: tidy(sentence), why: j.why };
  }
  return { correction: false, sentence: null, why: last };
}

// The clause as a reusable sentence: leading fillers and trailing punctuation off.
function tidy(c) {
  return c
    .replace(new RegExp(LEAD + String.raw`(?!more\b)`, "i"), "")
    .replace(POLITE, "")
    .replace(/^[-*•]\s+/, "")
    .replace(/[\s,;:.!?]+$/, "")
    .trim();
}
