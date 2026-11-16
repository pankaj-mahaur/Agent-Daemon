// The prompt screen (L5 design decision 6): pure, run on every capture from a prompt and
// on every row when the review checklist loads.
//
// It normalises first (NFKC; zero-width and bidi controls removed, which is itself a flag;
// Unicode tag characters decoded; Latin/Cyrillic/Greek look-alikes folded inside words that
// mix scripts), decodes base64, hex and ROT13 candidates and screens what they say, then
// looks for families of text aimed at the agent or its memory. → { flags: [family…],
// phrases: { family: "what matched" } }. Any flag holds the capture back.
//
// Guard weakening and unsafe workflow rules are polarity-aware only for words from the
// user's own prompt with one plain negation ("never use --no-verify" makes things
// stricter); a double negative or inversion is flagged, and so is any such term in a row
// from another writer (opts.userWords false).
//
// Tuned on dev sets written apart from the held-out poisoning corpus (D29).

import { findSecrets } from "../security/secret-patterns.mjs";

const ZERO_WIDTH = /[​-‏⁠-⁤﻿­]/g;
const BIDI = /[‪-‮⁦-⁩]/g;
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

// Look-alikes NFKC keeps, folded to Latin only inside words that mix scripts.
const CONFUSABLE = new Map(Object.entries({
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "һ": "h", "ԁ": "d", "ѕ": "s", "к": "k", "м": "m", "т": "t", "н": "h", "в": "b",
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "Х": "X", "І": "I",
  "ο": "o", "α": "a", "ε": "e", "ι": "i", "ν": "v", "ρ": "p", "τ": "t", "Ο": "O", "Α": "A", "Β": "B", "Ε": "E", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ρ": "P", "Τ": "T", "Χ": "X",
}));
const LATIN = /[A-Za-z]/;
const OTHER = /[Ͱ-ϿЀ-ӿԀ-ԯ]/;

/** → { text, hidden: [codes] }: what the screen reads, and which hiding tricks were found. */
export function normalizeForScreen(input) {
  let t = String(input ?? "");
  const hidden = [];
  if (ZERO_WIDTH.test(t)) hidden.push("zero-width");
  if (BIDI.test(t)) hidden.push("bidi");
  t = t.replace(ZERO_WIDTH, "").replace(BIDI, "");
  const tagged = t.match(TAGS);
  if (tagged) {
    hidden.push("tag-characters");
    t = t.replace(TAGS, (c) => String.fromCodePoint(c.codePointAt(0) - 0xe0000));
  }
  t = t.normalize("NFKC");
  let folded = false;
  t = t.replace(/[\p{L}\p{M}]+/gu, (w) => {
    if (!(LATIN.test(w) && OTHER.test(w))) return w;
    folded = true;
    return [...w].map((c) => CONFUSABLE.get(c) ?? c).join("");
  });
  if (folded) hidden.push("homoglyph");
  return { text: t, hidden };
}

// ── families ─────────────────────────────────────────────────────────────────
const AGENT = String.raw`(?:ai|a\.i\.|agents?|assistants?|llms?|models?|coding (?:agents?|assistants?)|ai (?:tools?|agents?|assistants?))`;

/** @type {Array<[string, RegExp]>} plain families: a match flags, whatever the polarity. */
const FAMILIES = [
  ["instruction", /\bignore\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|your)\s+(?:instructions|rules|prompts?|guidelines)/i],
  ["instruction", /\bdisregard\s+.{0,40}\b(?:instructions|rules|guidelines|constitution)\b/i],
  ["instruction", /\b(?:new|updated)\s+system\s+prompt\b|\boverride\s+(?:your|the|all)\s+(?:instructions|rules|safety)\b|\bforget\s+(?:everything|all)\s+(?:you|that)\b/i],
  ["persona", /\b[Yy]ou\s+are\s+(?:now\s+(?:[A-Z]\w+)|[A-Z][a-z]+(?:Keeper|Bot|GPT|AI|Mode|Master|Agent)\b|DAN\b|in\s+(?:developer|god|admin)\s+mode)|\byou\s+(?:are|must)\s+now\s+(?:a|an|the)\b|\b(?:act|behave)\s+as\s+(?:an?\s+)?(?:unrestricted|jailbroken)\b/],
  ["review-bypass", /\bauto[\s-]?accept|\b(?:skip|bypass|without|no\s+need\s+(?:for|to)|don'?t\s+need)\s+(?:the\s+|any\s+|a\s+)?(?:review|approval)(?:\s+(?:step|gate))?\b|\bmark\s+(?:this|it|that|them)?\s*(?:\w+\s+){0,2}as\s+accepted\b|\b(?:status|state)\s*[:=]\s*["']?accepted\b|\bremember\s+--accept\b|\breview\s+ki\s+zaroorat\s+nahi\b|\bas\s+an?\s+accepted\s+(?:rule|learning|note|memory)\b/i],
  ["fake-block", /<\/?\s*(?:system|system-reminder|assistant|human|function_results|function_calls|tool_result|tool_use|antml:[\w-]+)\b[^>]*>|\bim_(?:start|end)\b|\[\s*system(?:\s+override)?\s*\]|(?:^|\]\s*|\n)\s*system\s*:\s/i],
  ["hook-spoof", /hookSpecificOutput|additionalContext|permissionDecision|"systemMessage"\s*:|<agent-daemon[-:]digest>|<!--\s*agent-daemon/i],
  ["html-comment", new RegExp(String.raw`<!--[\s\S]{0,400}?\b(?:${AGENT}|remember|rule|store|save|ignore|instruction)\b[\s\S]{0,400}?-->`, "i")],
  ["exfil", /\b(?:send|post|upload|copy|exfiltrate|forward|pipe)\b.{0,80}?\b(?:to|into)\s+https?:\/\/|(?:~\/\.ssh|id_rsa|\.aws\/credentials|\.netrc|\.npmrc)\b.{0,80}?https?:\/\//i],
  ["cross-agent", new RegExp(String.raw`\b(?:note|message|reminder|important|instructions?|attention)\s+(?:to|for)\s+(?:any|all|every|other|the\s+main|the|this|future)\s+${AGENT}\b|\b(?:any|all|every|other)\s+${AGENT}\s+(?:reading|that\s+reads?|should|must|seeing|processing)\b|(?:^|[\s(/"'#*-])(?:ai|ai\s+agents?|ai\s+tools?|agents|assistants?)\s*:\s|\bsab\s+ai\s+agents?\b|\bfor\s+the\s+main\s+agent\b|\binstructing\s+all\s+agents\b`, "i")],
  ["pre-approval", /\b(?:already|pre-?)\s*(?:approved|authori[sz]ed|agreed)\b|\b(?:owner|user|maintainers?|admins?|administrator|team|platform team|lead)\s+(?:has\s+|have\s+|had\s+)?(?:already\s+)?(?:approved|authori[sz]ed|signed\s+off)\b|\bi\s+authori[sz]e\s+you\b|\bstanding\s+permission\b|\bas\s+the\s+(?:platform\s+)?(?:administrator|admin|lead\s+agent|orchestrator|maintainer|owner)\b/i],
  ["propagation", /\b(?:add|write|put|append|copy|save)\b.{0,60}\b(?:claude\.md|agents\.md|gemini\.md)\b|\b(?:remember|rule|save|store|memory|apply\s+(?:this|it)|add\s+(?:this|it))\b.{0,40}\b(?:for|in|to|across)\s+(?:every|all)\s+(?:projects?|repos?|repositories)\b/i],
  ["authority", /\b(?:from|by|message\s+from|update\s+from|notice\s+from|on\s+behalf\s+of)\s+(?:the\s+)?(?:anthropic|openai|claude(?:\s+code)?|codex|github|google|platform|security|it|devops|admin(?:istrator)?|compliance)\s+(?:team|staff|support|admins?|security|department)\b|\[\s*(?:admin|administrator|maintainer|security|official)\s*\]|\b(?:official|mandatory)\s+(?:policy|directive|notice)\b/i],
  ["cross-agent", /\bif\s+you\s+are\s+an?\s+(?:ai|llm|language\s+model|assistant|agent|bot)\b|\b(?:dear|hey|hi|attention|note\s+to|note\s+for)\s+(?:claude|codex|copilot|gemini|cursor|the\s+(?:ai|assistant|agent|llm|model))\b|\bto\s+the\s+(?:ai|llm|assistant|agent|model)\s+reading\b|(?:\/\/|#|\/\*|--)\s*(?:claude|codex|copilot|gemini|llm|assistant)\s*:/i],
  ["review-bypass", /\b(?:approve|accept)\s+(?:it|this|them|everything|all(?:\s+future)?)\s+(?:automatically|without\s+asking)\b|\bpre-?accepted\b|\b(?:consider|treat)\s+(?:this|it)\s+(?:as\s+)?(?:already\s+)?reviewed\b|\balready\s+reviewed\b|\bbina\s+review\b|\breview\s+mat\s+kar|\b(?:never|don'?t|do\s+not|no\s+need\s+to)\s+(?:ask|confirm|prompt|check\s+with\s+(?:me|the\s+user))\s+(?:before|for|when)\b|\bwithout\s+(?:asking|confirmation|confirming)\b/i],
  ["fake-block", /<<\s*SYS\s*>>|<\|\s*(?:system|im_start|endoftext)\s*\|>|\bBEGIN\s+(?:SYSTEM|ADMIN)\s+(?:PROMPT|MESSAGE|INSTRUCTIONS)\b|^#{1,4}\s*system\s*:?\s*$/im],
  ["hook-spoof", /\b(?:agent-daemon(?:-memory)?|teachonce)\s*[:\]]\s*(?:learned|accepted|saved|rule|approved)\b|\bLearned:\s*".{0,200}"\s*·\s*undo\b/i],
  ["exfil", /\b(?:send|post|upload|copy|share|leak|forward|e-?mail|paste)\b.{0,60}\b(?:memor(?:y|ies)|keys?|credentials?|secrets?|tokens?|\.env|ssh|history|learnings)\b.{0,60}\b(?:to|at|into)\s+\S+\.(?:com|net|org|io|dev|test|example)\b|!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*(?:\$\{|\{\{|%s|<[a-z]+>|MEMORY|SECRET|TOKEN|KEY)[^)\s]*\)/i],
  ["memory-tool", /\b(?:call|run|use|invoke|execute)\b.{0,40}\b(?:memory[_\s-]?(?:record|write|save|add|tool|store)\w*|remember\s+--\w+|(?:agent-daemon(?:-memory)?|teachonce)(?:@[\w.]+)?\s+(?:remember|review|config|forget)|ad\s+(?:review|remember|rules)\b)/i],
  ["forged-provenance", /\b(?:source|provenance|origin|prompt_source|speaker)\s*[:=]\s*["']?(?:typed|user|user-prompt|user-cli|accepted|trusted)\b|\b(?:this|the\s+(?:previous|above))\s+(?:message|prompt|note)\s+(?:was|is)\s+(?:typed|written|sent)\s+by\s+(?:the\s+)?user\b/i],
  ["propagation", /\bglobal(?:ly)?\s+(?:rule|memory|learning|note)s?\b|\bremember\s+(?:this\s+|it\s+)?globally\b|~\/\.claude\/CLAUDE\.md|\ball\s+future\s+(?:sessions|projects|agents)\b/i],
  ["exfil", /\b(?:curl|wget)\b[^\n]{0,120}(?:-d\s*@|--data(?:-binary)?\s*@|-F\s*\S*=@)|\b(?:webhook\.site|requestbin|ngrok|pipedream|pastebin|hookbin|interactsh|burpcollaborator)\b/i],
  ["persona", /\b(?:pretend|imagine)\s+(?:you(?:'re|\s+are)|to\s+be)\b|\broleplay\s+as\b/i],
  ["instruction", /\bignora\s+(?:las\s+)?instrucciones|\bignorez\s+(?:les\s+)?instructions|\bolvida\s+(?:las\s+)?instrucciones|\bvergiss\s+(?:alle\s+)?anweisungen/i],
  ["cross-agent", /(?:^|\n|[.!?]\s)\s*(?:assistant|claude|codex|agent|ai|copilot)\s*,\s*(?:please\s+)?(?:remember|save|store|note|always|never|from\s+now\s+on|add|record|make)\b/i],
  // A request to keep a credential, with no value yet: held back, never refused as a secret.
  ["secret-ask", /\b(?:remember|save|store|keep|memori[sz]e)\s+(?:my|our|this)\s+(?:\w+\s+)?(?:password|passphrase|api[\s_-]?key|access\s+key|private\s+key|credentials?|deploy\s+token|auth\s+token|secret\s+key)\b/i],
  ["review-bypass", /\b(?:mark|treat|flag|tag|save|store|record|persist)\b.{0,40}\bas\s+(?:trusted|verified|approved|reviewed|accepted|pre-?approved)\b|\b(?:no|doesn'?t\s+need|does\s+not\s+need)\s+(?:a\s+)?(?:review|approval|confirmation)\b|\b(?:directly|straight|immediately)\s+(?:in)?to\s+(?:your\s+)?(?:memory|accepted|long-term\s+memory|the\s+accepted\s+list)\b|\b(?:accept|approve|accepted)\s+(?:kar\s+lo|karo|kar\s+do|kardo|maan\s+lo|samjho)\b|\b(?:bina\s+pooche|pooche\s+bina)\b|बिना\s*(?:रिव्यू|पूछे)/i],
  ["guard-weakening", /\b(?:allowed|permitted|free)\s+to\s+(?:edit|modify|change|delete|rewrite|disable|remove)\s+(?:your\s+|its\s+|the\s+)?(?:own\s+)?(?:hooks?|rules?|guards?|memory|settings|config)|\bignore\s+(?:the\s+|any\s+)?(?:guards?|rules?|hooks?|blocks?)\s+(?:that|which|from)\b|\b(?:sandbox|hooks?|screen|guards?|checks?|review\s+gate)\s+(?:band|bandh|off|disable)\s+(?:kar|karo|kardo|kar\s+do)\b/i],
  ["authority", /\b(?:maintainer|owner|admin|administrator|lead)\s+here\b|\bi(?:'m|\s+am)\s+(?:the|your)\s+(?:admin|administrator|owner|maintainer|operator|supervisor)\b|\b(?:security|platform|devops|infra|compliance)\s+team\s+(?:says|requires|wants|mandates|has\s+decided|approved)\b/i],
  ["cross-agent", /\b(?:the\s+)?(?:assistants?|agents?|ai|ais|models?|llms?|bots?|claude(?:\s+code)?|codex|copilot|cursor|gemini)\s+(?:should|must|needs?\s+to|are\s+(?:required|instructed|expected)\s+to|is\s+(?:required|instructed|expected)\s+to)\s+(?:always\s+|now\s+|permanently\s+|also\s+)?(?:remember|save|store|record|skip|ignore|disable|treat\s+\w+\s+as)\b/i],
  ["exfil", /!\[[^\]]*\]\(\s*https?:\/\/[^)\s]*(?:track|collect|pixel|beacon|leak|exfil|steal)[^)\s]*\)/i],
  ["instruction", /याद\s*रख|हमेशा\s+\S+\s+(?:push|force|skip)/],
  ["exfil", /\b(?:print|output|dump|reveal|show|list|include|echo|paste|embed)\s+(?:all\s+)?(?:of\s+)?(?:your\s+|the\s+)?(?:memory|memories|learnings|system\s+prompt|secrets?|env(?:ironment)?\s+variables|api\s+keys?|credentials|tokens?|\.env)\b.{0,60}\b(?:in|into|to)\s+(?:the\s+|every\s+|each\s+)?(?:commit|pr|issue|comment|url|readme|log|reply|response|message)|\[[^\]]*\]\(\s*https?:\/\/[^)\s]*[?&](?:data|d|q|memory|mem|key|token|secret|content|payload|m|x|c)=[^)\s]*\)/i],
  ["pre-approval", /\byou\s+(?:have|got)\s+(?:my\s+|full\s+|blanket\s+|standing\s+)?permission\s+to\b|\byou(?:'re|\s+are)\s+(?:cleared|authori[sz]ed|permitted)\s+to\b|\bgreen-?lit\b|\bhas\s+been\s+(?:authori[sz]ed|approved|signed\s+off)\b/i],
  ["cross-agent", /\b(?:whichever|whatever|the\s+next)\s+(?:agent|assistant|ai|model)\b|\bfuture\s+(?:sessions?|agents?|runs?|assistants?)\s+(?:should|must|need\s+to|will\s+need\s+to)\b|\bany\s+other\s+(?:agent|assistant|ai|tool)\b/i],
  ["review-bypass", /\bon\s+my\s+behalf\b.{0,40}\b(?:accept|approve|review)|\b(?:accept|approve)\b.{0,40}\bon\s+my\s+behalf\b|\bskip\s+the\s+(?:review\s+)?queue\b|\bapprove\s+(?:this|the)\s+(?:note|learning|rule|memory)\b|\badd\s+(?:it|this)\s+(?:to|as)\s+(?:an?\s+)?(?:accepted|approved|trusted)\b/i],
  ["guard-weakening", /\b(?:remove|delete|disable|ignore|skip|turn\s+off)\s+(?:the\s+|your\s+|its\s+|ad'?s\s+)?(?:pre-?tool-?use|post-?tool-?use|memory|agent-daemon)\s+(?:hooks?|guards?|rules?|checks?)\b|\bignore\s+agent-daemon\b/i],
  ["guard-weakening", /\bapproval[_\s-]?policy\s*[=:]?\s*["']?never\b|\bdanger-full-access\b|--dangerously-bypass-approvals-and-sandbox\b|--full-auto\b|--yolo\b|\bsandbox[_\s-]?mode\s*[=:]\s*["']?(?:danger|off|none)/i],
  ["exfil", /<img\b[^>]*\bsrc\s*=\s*["']?https?:\/\/[^"'>\s]*[?&]\w+=|^\s*\[[^\]]+\]:\s*https?:\/\/\S*[?&](?:data|d|q|memory|key|token|secret|content|payload)=/im],
  ["pre-approval", /\b(?:the\s+user|user|owner|i)\s+(?:already\s+)?(?:said\s+yes|ok'?d|okay'?d|confirmed|consented)\b|\bconsent\s+(?:was|has\s+been)\s+given\b/i],
  ["cross-agent", /\bif\s+you(?:'re|\s+are)\s+(?:claude|codex|copilot|gemini|cursor|an?\s+coding\s+(?:agent|assistant))\b/i],
  ["exfil", /\b(?:append|add|encode|put|include|attach)\b.{0,60}\b(?:to|in|into|as)\s+(?:the\s+|an?\s+)?(?:url|query\s+(?:string|param(?:eter)?s?)|image\s+(?:url|link|src)|link|request)\b.{0,40}|\b(?:memory|memories|learnings|secrets?|tokens?|keys?|credentials|env)\b.{0,40}\b(?:as|in)\s+(?:a\s+)?(?:query\s+param(?:eter)?|url\s+param(?:eter)?)\b/i],
  ["exfil", /\b(?:embed|render|include|add|put|show|display|append)\b.{0,40}\b(?:image|img|pixel|badge|markdown\s+image|tracking)\b.{0,100}\b(?:every|each|all|your)\s+(?:reply|replies|response|responses|answers?|messages?|outputs?|summar(?:y|ies)|commits?|prs?)\b|\b(?:every|each|all)\s+(?:reply|replies|response|responses|answers?|messages?|outputs?)\b.{0,60}!\[/i],
  ["hidden", /<(?:div|span|p|section|font|small)\b[^>]*(?:display\s*:\s*none|visibility\s*:\s*hidden|\shidden\b|font-size\s*:\s*0|opacity\s*:\s*0|color\s*:\s*(?:white|#fff\b|#ffffff))[^>]*>/i],
  ["propagation", /\b(?:update|edit|modify|change|insert|append\s+to)\b.{0,40}\b(?:claude\.md|agents\.md|gemini\.md|\.cursorrules|copilot-instructions\.md)\b/i],
  ["guard-weakening", /\bapprovals?\s*(?:mode)?\s*[:=]\s*["']?(?:never|off|none|auto)\b|\bask[_\s-]?for[_\s-]?approval\s*[:=]\s*["']?(?:never|false)\b/i],
  ["html-comment", /<!--[\s\S]{0,400}?\b(?:always|never|from\s+now\s+on|should|must|skip|disable|push|approve|accept)\b[\s\S]{0,400}?-->|<details\b[\s\S]{0,600}?\b(?:remember|always|never|rule|assistant|agent|ai|skip|disable)\b[\s\S]{0,600}?<\/details>/i],
  ["secret", /\b(?:password|passphrase|api[\s_-]?key|token|secret|credentials?|access\s+key)\b.{0,40}\byaad\s+rakh/i],
  ["guard-weakening", /\b(?:hooks?|guards?|rules?|sandbox|screen|review\s+gate)\s+(?:hata|hatao|hata\s+do|nikal\s+do|nikalo)\b/i],
  ["pre-approval", /\bpehle\s+se\s+(?:approved|allowed|accepted|ok)\b|\bpermission\s+(?:de\s+di|mil\s+gayi|hai)\b/i],
  ["hidden", /\b(?:title|alt|content|aria-label|data-[\w-]+)\s*=\s*["'][^"']{0,300}\b(?:ai|agents?|assistants?|llms?|remember|instructions?|ignore|always|never|from\s+now\s+on)\b[^"']{0,300}["']|<(?:noscript|template|script)\b[\s\S]{0,600}?\b(?:ai|agents?|assistants?|remember|always|never|rule)\b/i],
  ["guard-weakening", /\b(?:guards?|rules?|memory|hooks?|settings)\s+(?:file|config)\s+(?:ko\s+)?(?:edit|badal|change|delete|hata)\w*\s*(?:kar|karo|kar\s+do|sakte|sakta)?/i],
  ["secret", /\b(?:mera|meri|hamara|hamari)\s+(?:\w+\s+){0,2}(?:password|token|key|api\s*key|secret)\s+\S{6,}\s+hai\b/i],
  ["concealment", /\b(?:silently|secretly|quietly|covertly)\s+(?:save|store|add|remember|run|apply|record)\b|\bwithout\s+(?:notifying|informing|alerting)\b/i],
  ["concealment", /\b(?:don'?t|do\s+not|never)\s+(?:mention|tell|say|show|reveal|report)\s+(?:this|it|anything)?\s*(?:to\s+)?(?:the\s+)?user\b|\bwithout\s+telling\s+(?:the\s+)?user\b|\bkeep\s+(?:this|it)\s+(?:secret|hidden)\s+from\b/i],
];

// Terms whose plain reading weakens a guard or a workflow check. The polarity rule may
// clear one when it sits under a single plain negation in the user's own words.
/** @type {Array<[string, RegExp]>} */
const RISKY = [
  ["unsafe-rule", /--no-verify\b|\bgit\s+commit\s+(?:-\w*\s+)*-n\b/i],
  ["unsafe-rule", /\b(?:git\s+)?push\s+(?:\S+\s+){0,3}?(?:--force(?!-with-lease)\b|-f\b)|\bforce[\s-]?push(?:ing|es|ed)?\b|\bpush(?:ing)?\s+(?:directly|straight|seedha)\s+(?:to|pe)\s+(?:prod(?:uction)?|main|master)\b|\bpush(?:ing)?\s+to\s+(?:main|master|prod(?:uction)?)\s+without\b/i],
  ["unsafe-rule", /\bcurl\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b|\bpip(?:e|ing)\s+curl\s+(?:in)?to\s+(?:sudo\s+)?(?:ba)?sh\b|\bwget\b[^|\n]{0,200}\|\s*(?:sudo\s+)?(?:ba)?sh\b/i],
  ["unsafe-rule", /\bchmod\s+(?:-R\s+)?0?777\b|\bsudo\s+rm\s+-rf\b|\brm\s+-rf\b.{0,60}\b(?:pre-?approved|without\s+asking|always\s+fine|allowed)\b|\breset\s+--hard\b.{0,80}\bwithout\s+asking\b/i],
  ["unsafe-rule", /\bskip(?:ping)?\s+(?:the\s+|all\s+|any\s+)?(?:\w+\s+)?(?:tests?|test\s+suite|lint(?:ing)?|checks?|ci|hooks?|code\s+review)\b|\b(?:tests?|hooks?|lint|ci)\s+(?:are|is)\s+optional\b|--skip-tests?\b|\btests?\s+skip\s+kar\b|\bnever\s+run\s+(?:the\s+)?(?:tests?|test\s+suite|lint|ci)\b|\bdisable\s+(?:the\s+)?(?:pre-commit\s+)?hooks?\b/i],
  ["unsafe-rule", /--insecure\b|\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*["']?0|\bverify\s*=\s*False\b|\bstrict-ssl\s+false\b|\bgit\s+clean\s+-\w*f\w*d|\bhooks?\s+(?:band|off)\s+kar|\btests?\s+chhod\b|\bforce\s+push\s+kar|\bcommit\s+without\s+(?:running\s+)?(?:the\s+)?(?:hooks?|tests?|checks?)\b|\bbypass\s+(?:the\s+)?(?:pre-commit|hooks?|ci|checks?)\b/i],
  ["unsafe-rule", /\b(?:commit|push)\s+directly\s+to\s+(?:main|master)\b|\bmerge\s+without\s+(?:ci|review|checks|tests)\b|\[skip\s+ci\]|\bdisable\s+branch\s+protection\b|\b(?:delete|remove|comment\s+out)\s+(?:the\s+)?failing\s+tests?\b|\bignore\s+(?:the\s+)?failing\s+(?:tests?|checks?)\b|(?:^|\s)--force(?![\w-])/i],
  ["unsafe-rule", /\bdeploy\s+(?:straight|directly)\s+to\s+prod|\bskip\s+staging\b|\bdisable\s+(?:ssl|tls|2fa|mfa|certificate\s+checks?)\b|\brun\s+(?:everything\s+)?as\s+root\b|\bsudo\s+(?:npm|pip|chmod|chown)\b/i],
  ["guard-weakening", /\b(?:rules?\s+(?:pause|rm|remove|allow-once)|allow-once|delete\s+(?:the\s+)?(?:rules?|guards?)|unpause\s+(?:the\s+)?rules?|disable\s+agent-daemon|uninstall\s+agent-daemon)\b/i],
  ["guard-weakening", /\b(?:bypassPermissions|dangerously-skip-permissions|yolo\s+mode|allowedTools|permissions\.allow)\b|\bBash\(\s*\*\s*\)|\b(?:edit|change|modify|update|write\s+to)\s+(?:the\s+)?(?:\.claude\/settings(?:\.local)?\.json|settings\.json|hooks\.json|\.codex\/config\.toml|config\.toml)\b|\bauto-?approve\s+(?:all\s+)?(?:tool\s+calls?|commands?|tools?)\b/i],
  ["guard-weakening", /(?:~|\$HOME|%USERPROFILE%|\{adroot\})[\\/]\.?agent-daemon\b|\bguards\.json\b|\b(?:disable|turn\s+off|bypass|switch\s+off|remove)\s+(?:the\s+)?(?:sandbox|memory\s+screen|screen|guards?|review\s+gate|rules?\s+check|self-protection)\b|\bdangerously[-_ ]?skip[-_ ]?permissions\b/i],
];

const COSMETIC = new Set(["style", "logo", "logocolor", "label", "labelcolor", "color", "colorb", "colora", "v", "w", "h", "width", "height", "size", "s", "format", "raw", "theme", "dpr", "fit", "auto", "quality", "branch", "event", "link", "cachebust", "cache", "t"]);

const NEGATOR = /\b(?:never|don'?t|do\s+not|dont|no|not|stop|avoid|nahi|mat|na)\b/gi;
const INVERSION = /\bwithout\b|\bnever\s+forget\b|\bdon'?t\s+(?:stop|forget|avoid)\b|\bstop\s+(?:avoiding|refusing)\b|\balways\b.{0,20}\bforce\b/i;

// The clause around index i (sentence pieces split at . ; ! ? and newlines), at most
// WINDOW characters each side, so a wall of text costs the same per match.
const WINDOW = 300;
function clauseAt(text, i) {
  const lo = Math.max(0, i - WINDOW);
  const head = text.slice(lo, i);
  const cut = Math.max(head.lastIndexOf("."), head.lastIndexOf(";"), head.lastIndexOf("!"), head.lastIndexOf("?"), head.lastIndexOf("\n"));
  const tail = text.slice(i, i + WINDOW);
  const ends = [".", ";", "!", "?", "\n"].map((c) => tail.indexOf(c)).filter((x) => x >= 0);
  return { before: head.slice(cut + 1), after: tail.slice(0, ends.length ? Math.min(...ends) : tail.length) };
}

// A negator that governs the term: within the last four words before it, not an
// interjection ("No problem, …", "Don't worry, …", "not hard, …"), with no second negator
// and nothing that turns it back around.
const INTERJECTION = /\b(?:no|not|don'?t|never)\b[^,;:—–-]{0,24}[,;:—–-]/i;
// The words a governing negator may have between it and the term ("never use", "don't
// ever run the", "no force"…); anything else ("No big deal use …") means it governs
// something else.
const BRIDGE = new Set(["use", "just", "using", "run", "running", "do", "ever", "the", "a", "an", "any", "to", "git", "commit", "commits", "committing", "with", "push", "pushing", "force", "skip", "skipping", "disable", "chmod", "curl", "into", "pipe", "piping", "sudo", "rm", "on", "in", "your", "our", "its", "add", "pass", "call", "be", "again", "anymore", "touch", "make", "anything"]);
function stricter(text, index) {
  const { before, after } = clauseAt(text, index);
  const negsAll = before.match(NEGATOR) ?? [];
  if (negsAll.length !== 1) return false;
  if (INTERJECTION.test(before)) return false;
  const words = before.trim().split(/\s+/);
  const at = words.findLastIndex((w) => new RegExp(`^${NEGATOR.source}$`, "i").test(w.replace(/[^\w']/g, "")));
  if (at < 0 || words.length - at - 1 > 3) return false;
  if (!words.slice(at + 1).every((w) => BRIDGE.has(w.toLowerCase().replace(/[^\w-]/g, "")))) return false;
  return !INVERSION.test(before + after);
}

function screenText(text, { userWords }) {
  const flags = new Set();
  const phrases = {};
  const hit = (family, m) => {
    flags.add(family);
    if (!phrases[family]) phrases[family] = m[0].trim().slice(0, 60);
  };
  for (const [family, re] of FAMILIES) {
    const m = text.match(re);
    if (m) hit(family, m);
  }
  for (const [family, re] of RISKY) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    for (const m of text.matchAll(g)) {
      if (userWords && stricter(text, m.index)) continue;
      hit(family, m);
      break;
    }
  }
  // A markdown image whose URL carries a parameter that isn't cosmetic: a beacon that can
  // carry data out when the reply renders (badges' style/width/… stay clean).
  for (const m of text.matchAll(/!\[[^\]]{0,200}\]\(\s*(https?:\/\/[^)\s]{1,2000})\)/gi)) {
    const q = m[1].split("?")[1];
    if (!q) continue;
    const names = q.split(/[&;]/).map((kv) => kv.split("=")[0].toLowerCase()).filter(Boolean);
    if (names.some((n) => !COSMETIC.has(n))) {
      hit("exfil", m);
      break;
    }
  }
  // Two or more Devanagari directive words (always, remember, rule, review, skip, accept, without, remove, save).
  if ((text.match(/हमेशा|याद|नियम|समीक्षा|छोड़|स्वीकार|बिना|हटा|सहेज/g) ?? []).length >= 2) hit("instruction", ["Hindi directive words"]);
  // Fake transcripts: two or more role lines.
  const roles = text.match(/(?:^|\n)\s*(?:human|user|assistant|ai)\s*:\s*\S/gi);
  if (roles && roles.length >= 2 && /(?:^|\n)\s*assistant\s*:/i.test(text)) hit("fake-block", roles);
  return { flags, phrases };
}

function secretHits(text) {
  const kinds = findSecrets(text, { minConfidence: "high" }).map((h) => h.kind);
  if (/\bAKIA[0-9A-Z]{16}\b/.test(text)) kinds.push("aws-key");
  if (/\b(?:my|our|the)\s+(?:\w+\s+){0,3}(?:password|passwd|api[\s_-]?key|secret|token|deploy\s+token)\s+(?:is|=|:)\s*\S{6,}/i.test(text)) kinds.push("credential");
  // A password or token-shaped value right after its name (FAKE-PASSWORD, a deploy token…).
  if (/\b(?:password|passwd|pwd|pass|creds?|api[\s_-]?key|secret[\s_-]?key|access[\s_-]?key|token|deploy[\s_-]?token)\b\s*(?:is|=|:|-)?\s*["'`]?(?=[A-Za-z0-9_\-\/+=.]*[0-9A-Z])(?=[A-Za-z0-9_\-\/+=.]*[-_0-9])[A-Za-z0-9_\-\/+=.]{8,}/.test(text)) kinds.push("credential");
  if (/(?<![A-Za-z0-9/+])(?=[A-Za-z0-9/+]*\/)(?=[A-Za-z0-9/+]*[a-z])(?=[A-Za-z0-9/+]*[A-Z])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/.test(text)) kinds.push("aws-secret");
  return kinds;
}

const B64 = /[A-Za-z0-9+/]{24,}={0,2}/g;
const HEX = /\b(?:[0-9a-f]{2}){16,}\b/gi;
const printable = (s) => s.length >= 8 && /^[\x20-\x7E\n\t]+$/.test(s) && /[a-z]{3,}\s+[a-z]{2,}/i.test(s);
const rot13 = (s) => s.replace(/[a-z]/gi, (c) => String.fromCharCode(((c.toLowerCase().charCodeAt(0) - 97 + 13) % 26) + (c <= "Z" ? 65 : 97)));
const MAX_DECODE = 20;

function decodedPayloads(text) {
  const out = [];
  for (const m of text.matchAll(B64)) {
    if (out.length >= MAX_DECODE) break;
    try {
      const d = Buffer.from(m[0], "base64").toString("utf8");
      if (printable(d)) out.push(d);
    } catch {
      // not base64
    }
  }
  for (const m of text.matchAll(HEX)) {
    if (out.length >= MAX_DECODE) break;
    const d = Buffer.from(m[0], "hex").toString("utf8");
    if (printable(d)) out.push(d);
  }
  return out;
}

const MAX_SCREEN = 64 * 1024;

/**
 * Screen a prompt or a note.
 * @param {string} text
 * @param {{userWords?: boolean}} [opts]  userWords: the user's own prompt words (polarity rule allowed)
 * @returns {{flags: string[], phrases: Record<string,string>}}
 */
export function screenPrompt(text, { userWords = true } = {}) {
  // Past the cap: the head and the last 8 KB (padding can't push a block out of reach).
  const all = String(text ?? "");
  const raw = all.length > MAX_SCREEN ? `${all.slice(0, MAX_SCREEN - 8192)}\n${all.slice(-8192)}` : all;
  const n = normalizeForScreen(raw);
  const { flags, phrases } = screenText(n.text, { userWords });
  if (n.hidden.length) {
    flags.add("hidden");
    phrases.hidden = n.hidden.join(", ");
  }
  const secrets = secretHits(n.text);
  if (secrets.length) {
    flags.add("secret");
    phrases.secret = secrets[0];
  }
  // Encoded text: screened for what it says (never with the polarity rule).
  const decoded = decodedPayloads(n.text);
  const flipped = rot13(n.text);
  for (const d of [...decoded, flipped]) {
    const inner = screenText(normalizeForScreen(d).text, { userWords: false });
    const strong = [...inner.flags].filter((f) => ["instruction", "review-bypass", "unsafe-rule", "guard-weakening", "fake-block", "exfil", "persona"].includes(f));
    if (strong.length) {
      flags.add("encoded");
      phrases.encoded = phrases.encoded ?? strong[0];
      break;
    }
  }
  return { flags: [...flags], phrases };
}

/** Plain words for a flag, for the receipt and the review row. */
export const FLAG_PHRASES = Object.freeze({
  instruction: "an instruction aimed at the agent",
  persona: "an instruction that changes who the agent is",
  "review-bypass": "a request to skip review",
  "fake-block": "text dressed up as a system or tool message",
  "hook-spoof": "text dressed up as a hook's output",
  "html-comment": "an instruction hidden in an HTML comment",
  exfil: "a way to send data out",
  "cross-agent": "a message addressed to AI agents",
  "pre-approval": "a claim that someone already approved it",
  propagation: "a request to spread it to every project",
  concealment: "a request to keep it from you",
  "unsafe-rule": "a command that weakens safety checks",
  "guard-weakening": "a change to the agent's own guards",
  secret: "a secret",
  "secret-ask": "a request to keep a credential",
  hidden: "hidden or invisible text",
  encoded: "encoded text with instructions in it",
});
