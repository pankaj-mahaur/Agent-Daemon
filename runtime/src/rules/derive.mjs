// Correction → rule (plan L4c: offline pattern derivation). A correction
// becomes a command rule, a write rule, or "not a rule" (a reminder: recalled
// and counted, never enforced). Gate: accuracy >= 0.8 on the held-out
// correction → pattern corpus, scored by running the derived rule through the
// matcher on each item's block and allow examples.
//
// A rule needs two things the text must say:
//   a target a single tool call can show: a program, with a verb or flag when
//     the text names one ("git push --force", "terraform apply", "jest"), or
//     files ("src/gen/", "the lockfile", ".pem files");
//   a direction: forbidding it ("don't", "never", "stop", "no", "off limits",
//     "instead of", Hinglish "mat", "nahi"), or preferring its replacement
//     ("use pnpm" forbids npm installs).
// Obligations ("run the tests after you change something"), code or message
// content ("no console.log", "commit messages in English"), conversation style,
// scoped one-offs ("don't push yet") and vague advice are reminders.
//
// The text is read clause by clause: a negation forbids what its own clause
// names. Deterministic and offline. Tuned on
// test/fixtures/rules/dev-corrections.jsonl; the held-out corpus is only
// scored (plan D29).

import { stripPrivate } from "../digest/sanitize.mjs";

// ---- knowledge -----------------------------------------------------------------

const NPM_INSTALL = ["install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "ci", "clean-install", "ic", "install-clean", "isntall-clean"];
const NPM_UNINSTALL = ["uninstall", "un", "unlink", "remove", "rm", "r"];
// Subcommand spellings a rule must list (the matcher compares words exactly).
const SUB_ALIASES = {
  npm: { install: NPM_INSTALL, i: NPM_INSTALL, add: NPM_INSTALL, ci: ["ci", "clean-install", "ic", "install-clean", "isntall-clean"], uninstall: NPM_UNINSTALL, remove: NPM_UNINSTALL, rm: NPM_UNINSTALL, run: ["run", "run-script", "rum", "urn"], test: ["test", "t", "tst"], update: ["update", "up", "upgrade", "udpate"], upgrade: ["update", "up", "upgrade", "udpate"] },
  pnpm: { install: ["install", "i", "add"], add: ["add", "install", "i"], update: ["update", "up", "upgrade"], remove: ["remove", "rm", "uninstall", "un"] },
  yarn: { upgrade: ["upgrade", "up"], remove: ["remove"] },
  bun: { install: ["install", "i", "add", "a"], add: ["add", "a", "install", "i"] },
  cargo: { test: ["test", "t"], build: ["build", "b"], run: ["run", "r"] },
  helm: { uninstall: ["uninstall", "delete", "del", "un"], delete: ["uninstall", "delete", "del", "un"] },
  winget: { install: ["install", "add"], uninstall: ["uninstall", "remove", "rm"] },
  composer: { update: ["update", "upgrade", "u"], upgrade: ["update", "upgrade", "u"], require: ["require", "r"] },
  gem: { install: ["install", "i"] },
  brew: { upgrade: ["upgrade"], install: ["install"], uninstall: ["uninstall", "remove", "rm"] },
  kubectl: { delete: ["delete"] },
  docker: { rm: ["rm"], rmi: ["rmi"] },
};
// Flag spellings that mean the same thing, per program ("*" for any).
const FLAG_ALIASES = {
  "*": { "--force": ["--force", "-f"], "-f": ["-f", "--force"], "--global": ["-g", "--global", "--location=global"], "-g": ["-g", "--global", "--location=global"], "--recursive": ["-r", "-R", "--recursive"], "-auto-approve": ["-auto-approve", "--auto-approve"], "--auto-approve": ["-auto-approve", "--auto-approve"], "--in-place": ["-i", "--in-place"] },
  git: { "-d": ["-d", "--delete"], "--delete": ["-d", "--delete"], "-D": ["-D"], "--no-verify": ["--no-verify"] },
  sed: { "-i": ["-i", "--in-place"] },
  perl: { "-i": ["-i"] },
  rubocop: { "-A": ["-A", "--autocorrect-all"], "-a": ["-a", "--autocorrect"] },
  chown: { "-R": ["-R", "--recursive"], "-r": ["-R", "--recursive"] },
  chmod: { "-R": ["-R", "--recursive"], "-r": ["-R", "--recursive"] },
  cp: { "-r": ["-r", "-R", "--recursive"], "-R": ["-r", "-R", "--recursive"] },
  rm: { "-r": ["-r", "-R", "--recursive"], "-R": ["-r", "-R", "--recursive"] },
  docker: { "-v": ["-v", "--volumes"], "--volumes": ["-v", "--volumes"] },
  "docker-compose": { "-v": ["-v", "--volumes"], "--volumes": ["-v", "--volumes"] },
  taskkill: { "/f": ["/F", "/f"], "/F": ["/F", "/f"] },
  prettier: { "--write": ["--write", "-w"], "-w": ["--write", "-w"] },
};

// Command-line programs a correction may name. Words that are also plain
// English (make, find, kill, go, date) count only next to a verb, a flag or
// a negation that points at them.
const PROGRAMS = new Set(`
npm pnpm yarn bun npx pnpx bunx pip pip3 pipx uv uvx poetry pipenv conda mamba easy_install cargo rustup go gofmt
git gh glab hub docker docker-compose podman kubectl k9s helm kustomize terraform tofu terragrunt pulumi packer vagrant
gcloud gsutil aws az doctl heroku vercel netlify firebase flyctl fly wrangler supabase railway
gradle gradlew mvn mvnw ant sbt dotnet nuget msbuild make cmake ninja bazel buck
rm rmdir chmod chown chgrp cp mv dd mkfs fdisk parted diskpart shutdown reboot halt poweroff systemctl service launchctl
kill killall pkill taskkill sudo su doas curl wget ssh scp rsync sed perl awk truncate shred
prisma knex sequelize typeorm alembic flyway liquibase rails rake bundle gem rspec composer artisan php
jest vitest mocha jasmine ava cypress playwright pytest tox nox unittest
prettier eslint biome black ruff flake8 isort autopep8 yapf pylint mypy rubocop standard tslint stylelint clang-format rustfmt
nodemon pm2 forever ts-node tsx babel-node deno node python python3 ruby
brew apt apt-get yum dnf pacman zypper snap flatpak winget choco scoop port
reg regedit setx netsh sc bcdedit icacls takeown schtasks wmic robocopy xcopy del erase rd format
ansible ansible-playbook chef puppet salt mix flutter dart pod xcodebuild swift turbo nx lerna changeset
`.trim().split(/\s+/));
const ENGLISH_PROGRAMS = new Set(["make", "find", "kill", "go", "service", "format", "port", "snap", "standard", "node", "forever", "pod", "dart", "swift", "salt", "chef", "puppet", "mix", "ant", "bundle", "del", "erase", "sc", "su", "fly", "turbo", "nx", "deno", "tsx", "rd", "reg"]);
// Programs whose whole use can be forbidden without a verb ("never call aws yourself").
const isCmdlet = (w) => /^(?:remove|set|clear|stop|restart|invoke|format|uninstall|install|new|update|start|disable|enable|reset|add|move|copy|rename|out|export|import)-[a-z]+$/i.test(w);
const isProgramWord = (w) => PROGRAMS.has(w.toLowerCase()) || isCmdlet(w);

// "Use X" forbids X's usual alternative.
const REPLACES = {
  pnpm: { program: "npm", sub: "install" },
  yarn: { program: "npm", sub: "install" },
  bun: { program: "npm", sub: "install" },
  uv: { program: "pip", sub: "install" },
  poetry: { program: "pip", sub: "install" },
  pipenv: { program: "pip", sub: "install" },
  vitest: { program: "jest" },
  nextest: { program: "cargo", sub: "test" },
  biome: { program: "prettier" },
  ruff: { program: "black" },
  gradlew: { program: "gradle" },
  mvnw: { program: "mvn" },
};

// Things named in words, not paths.
const NAMED_PATHS = [
  [/\block ?files?\b|\bpackage-lock\b/i, ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"]],
  [/\b(?:jest |test )?snapshots?\b/i, ["**/__snapshots__/**", "*.snap"]],
  [/\b(?:\.?env|dotenv) files?\b/i, [".env", ".env.*"]],
  [/\b(?:github actions?|workflows?|ci (?:config|files?|yaml|pipelines?|workflows?))\b/i, [".github/workflows/**"]],
  [/\bchangelog\b/i, ["CHANGELOG*"]],
];
// File names without an extension that name themselves.
const BARE_FILES = /\b(Dockerfile|Makefile|Jenkinsfile|Procfile|Gemfile|Vagrantfile|Brewfile|Justfile|Taskfile|CODEOWNERS|LICENSE)\b/;

// ---- text --------------------------------------------------------------------

const NEGATION = /\b(?:don'?t|dont|do not|never|stop|quit|avoid|no more|no|not|nahi|nahin|mat|without|instead of|rather than|band karo|kabhi|forbidden|not allowed|banned|off[- ]limits|hands off|isn'?t (?:something|yours|allowed)|ruin(?:s|ed)?|dropped|broke|breaks)\b/i;
const PREFIX_NEG = /\b(?:don'?t|dont|do not|never|stop|quit|avoid|no more|no|not|without|instead of|rather than|kabhi|nobody|nothing)\b/i;
const POSTFIX_NEG = /^(?:mat|nahi|nahin|na|band|is|are|isn'?t)$/i;
const PREFER_BEFORE = /\b(?:use|using|prefer|switch to|go with|stick (?:to|with)|through|via|only|sirf)\s*$/i;
const PREFER = /\b(?:use|using|prefer|switch to|go with|stick (?:to|with)|we use|only use|always use|use karo|use kar(?:na|o)?|chalao)\b/i;
const OBLIGATION = /\b(?:always run|make sure (?:you |to )?run|remember to run|run .* (?:before|after) |before (?:you )?(?:commit|push|merge|finish)|after (?:you )?(?:change|edit|commit|finish|add))\b/i;
const WRITE_VERB = /\b(?:touch|edit|edits|editing|modify|modifying|change|changes|changing|write|writes|writing|overwrite|update|updating|hand[- ]edit|regenerate|delete|remove|mess with|stay out of|keep out of|haath|chhedo|chhuo|chedo|badlo|likho)\b/i;
const OWNED = /\b(?:generated|auto-?generated|vendored|read-?only|mine|managed by|owned by|owns it|off[- ]limits|hands off|alone|belongs? to|build outputs?|output of)\b/i;
const SCOPED = /\b(?:for now|yet|this time|right now|today|for today|in this pr|for this (?:pr|task|branch|feature|session)|until|this session|aaj)\b/i;
const STOP_AFTER = new Set("to on in the a an with without unless before after ever again please here there anything it that this directly and or for from into main master prod production origin by at of mat nahi karo kar chalao use kabhi is are was be when if as so but yourself manually locally globally anymore commands command se mein me ko ka ki ke ya aur bhi bina pe par jo hi sirf woh ye yeh mere liye bhai yaar on my any every all your just again stuff things".split(" "));
const ALT_JOIN = /^(?:or|ya|and|aur|nor|\/)$/i;

/** Split into clauses: sentences and "…; …" parts. A leading "No," is an interjection, not a negation. */
function clausesOf(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+|;\s+|\s+[–—]\s+/)
    .map((c) => c.trim().replace(/^(?:no|nope|nah|nahi)\s*[,!:]\s*/i, ""))
    .filter(Boolean);
}

/**
 * Words with their punctuation trimmed, keeping ' : . / - inside (don't,
 * db:drop, ./gradlew), and where a phrase ended ("jest, we use vitest": "we"
 * isn't jest's verb).
 */
function tokensOf(clause) {
  const words = [];
  const stops = new Set();
  for (const raw of clause.replace(/[“”]/g, '"').replace(/[‘’]/g, "'").split(/\s+/)) {
    const w = raw.replace(/^[("'`[{]+|[)"'`\]},.!?:;]+$/g, "");
    if (!w) continue;
    words.push(w);
    if (/[,;:.!?)]["'`]?$/.test(raw)) stops.add(words.length - 1);
  }
  return { words, stops };
}
const wordsOf = (clause) => tokensOf(clause).words;

/** Inline code spans. */
const codeSpans = (text) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()).filter(Boolean);

const isFlag = (w) => /^--?[a-z][\w-]*(?:=[\w-]+)?$/i.test(w) || /^\/[a-z]{1,2}$/i.test(w);
const isSubWord = (w) => /^[a-z][\w:.-]*$/.test(w) && !STOP_AFTER.has(w) && !isProgramWord(w);

// Programs whose next word is usually a verb (git push, docker run). Other
// programs take a verb from free text only when it's a known one (SUB_ALIASES)
// or the words are in a code span.
const TAKES_VERBS = new Set("make just task invoke artisan git gh glab npm pnpm yarn bun pip pip3 uv poetry pipenv conda cargo rustup go docker docker-compose podman kubectl helm kustomize terraform tofu terragrunt pulumi packer vagrant gcloud gsutil aws az doctl heroku vercel netlify firebase flyctl fly wrangler supabase railway gradle gradlew mvn mvnw dotnet nuget prisma knex sequelize typeorm alembic flyway liquibase rails rake bundle gem composer artisan brew apt apt-get yum dnf pacman zypper snap flatpak winget choco scoop port systemctl service launchctl ansible mix flutter dart pod swift turbo nx lerna changeset reg sc schtasks netsh wmic chmod".split(" "));
const ENGLISH_NOT_VERBS = new Set("we you i they it is are was be because since so but and or if when then that this these those which who hangs keeps breaks fails ruins takes always never again here there now just only even also too either please".split(" "));

/** The command named from word k on: program, verb alternatives, flags. */
function commandAt(words, k, { stops = new Set(), code = false } = {}) {
  // python -m pip install: the module is the program. npx prisma …, php artisan …:
  // the runner runs the program the rule is about (the matcher sees through it too).
  if (/^(?:python[\d.]*|py)$/i.test(words[k]) && words[k + 1] === "-m" && words[k + 2]) k += 2;
  else if (/^(?:npx|pnpx|bunx|uvx)$/i.test(words[k]) && words[k + 1] && /^[a-z][\w@./-]*$/i.test(words[k + 1]) && !ENGLISH_NOT_VERBS.has(words[k + 1].toLowerCase())) k += 1;
  else if (/^php$/i.test(words[k]) && /^artisan$/i.test(words[k + 1] ?? "")) k += 1;
  const program = programOf(words[k]);
  const p = program.toLowerCase();
  const subs = [];
  const flags = [];
  const cmdlet = isCmdlet(program);
  const verbOk = (w) => code || SUB_ALIASES[p]?.[w.toLowerCase()] || (TAKES_VERBS.has(p) && !ENGLISH_NOT_VERBS.has(w.toLowerCase()));
  for (let j = k + 1; j < words.length && j < k + 8; j++) {
    if (stops.has(j - 1)) break;
    const w = words[j];
    if (isFlag(w)) {
      flags.push(w);
      continue;
    }
    if (/^[0-7]{3,4}$/.test(w) && !subs.length && !cmdlet) {
      subs.push(w); // chmod 777: the mode is the first non-option argument
      continue;
    }
    if (!cmdlet && isSubWord(w) && verbOk(w) && (!subs.length || ALT_JOIN.test(words[j - 1] ?? ""))) {
      subs.push(w);
      continue;
    }
    if (ALT_JOIN.test(w) && subs.length) continue;
    break;
  }
  return { program, subs, flags, at: k };
}

/** "./gradlew" → gradlew, "bin/rails" → rails, "docker-compose.exe" → docker-compose. */
function programOf(w) {
  return w.split(/[\\/]/).pop().replace(/\.(?:exe|cmd|bat|ps1)$/i, "");
}

// A negation that asks for the command, not against it: "don't forget to run
// npm install", "never skip it", "no need to", "you didn't run it", "nahi kiya".
const NEG_OBLIGATION = /\b(?:forget|forgot|skip|skipping|skipped|need|needs|needed|miss|missing|neglect|fail(?:ed)? to|without running)\b/i;
const PAST_NOT = /\b(?:did ?n[o']?t|didn'?t|have ?n[o']?t|haven'?t|hasn'?t|wasn'?t|weren'?t)\b/i;

/** Is this candidate forbidden by its clause? */
function forbiddenIn(words, c) {
  const before = words.slice(0, c.at).join(" ");
  const after = words.slice(c.at + 1, c.at + 9);
  // From the last negation to the program: an obligation or a report of the past forbids nothing.
  const negAt = Math.max(...[...before.matchAll(new RegExp(PREFIX_NEG.source, "gi"))].map((m) => m.index), -1);
  if (negAt >= 0 && (NEG_OBLIGATION.test(before.slice(negAt)) || PAST_NOT.test(before.slice(Math.max(0, negAt - 6))))) return false;
  const post = after.findIndex((w) => /^(?:mat|nahi|nahin)$/i.test(w));
  if (post >= 0 && /^(?:kiya|kia|kiye|ki|chalaya|chalayi|hua|hui|kari|kara)$/i.test(after[post + 1] ?? "")) return false;
  // Preferred, not forbidden: "use pnpm", "go through npm test", "only via ./gradlew".
  if (PREFER_BEFORE.test(before) && !PREFIX_NEG.test(words.slice(Math.max(0, c.at - 2), c.at).join(" "))) {
    const lastNeg = before.search(new RegExp(`${PREFIX_NEG.source}(?![\\s\\S]*${PREFIX_NEG.source})`, "i"));
    const lastPref = before.search(/\b(?:use|using|prefer|through|via|only|sirf)\s*$/i);
    if (lastNeg < 0 || lastPref > lastNeg) return false;
  }
  if (PREFIX_NEG.test(before)) return true;
  if (after.some((w) => /^(?:mat|nahi|nahin)$/i.test(w))) return true;
  // "mvn deploy is off limits", "alembic downgrade is not something you get to run".
  const rest = words.slice(c.at + 1).join(" ");
  return /\b(?:is|are|isn'?t)\b.*\b(?:not|off[- ]limits|forbidden|banned|mine|not allowed)\b|\b(?:off[- ]limits|is forbidden|is banned|not allowed|never again|dropped|broke|ruined)\b/i.test(rest);
}

/** Flag aliases a rule lists for this program. */
function expandFlags(program, flags) {
  const p = program.toLowerCase();
  const out = new Set();
  for (const f of flags) {
    const own = FLAG_ALIASES[p]?.[f] ?? FLAG_ALIASES[p]?.[f.toLowerCase()];
    const any = FLAG_ALIASES["*"][f] ?? FLAG_ALIASES["*"][f.toLowerCase()];
    for (const x of own ?? any ?? [f]) out.add(x);
  }
  return [...out];
}

function commandRule(program, subs, flags) {
  const p = program.toLowerCase();
  const cmdlet = isCmdlet(program);
  const name = cmdlet ? program.replace(/(^|-)(\w)/g, (_m, d, ch) => d + ch.toUpperCase()) : p;
  const subList = subs?.length ? [...new Set(subs.flatMap((s) => SUB_ALIASES[p]?.[s.toLowerCase()] ?? [s]))] : null;
  return { type: "command", program: name, subcommands: subList, flags: flags?.length ? expandFlags(name, flags) : null };
}

// Habits named in words, without the program spelled out.
const PHRASES = [
  [/\bforce[- ]?push(?:ing|es)?\b|\bpush(?:ing)? (?:with )?--force\b/i, () => ["git", ["push"], ["--force"]]],
  [/\bpush(?:ing)? (?:the )?tags\b|\bpush --tags\b/i, () => ["git", ["push"], ["--tags"]]],
  [/\bamend(?:ing|ed)?\b/i, () => ["git", ["commit"], ["--amend"]]],
  [/--no-verify\b|\bskip(?:ping)? (?:the )?(?:git |pre-commit )?hooks\b|\bbypass(?:ing)? (?:the )?(?:git |pre-commit )?hooks\b/i, () => ["git", [], ["--no-verify"]]],
  [/\breset --hard\b|\bhard reset\b/i, () => ["git", ["reset"], ["--hard"]]],
  [/\bpush(?:ing)? (?:directly |straight )?(?:to )?(?:main|master)\b|\bpush(?:es)? (?:directly|straight) to\b|\b(?:main|master)(?: branch)? (?:pe|par|mein|me) (?:seedha |direct )?push\b/i, () => ["git", ["push"], []]],
  [/\b(?:create|creating|make|making|add|adding|push|pushing)(?: any| new)? (?:git )?tags\b/i, () => ["git", ["tag"], []]],
  [/^(?:please )?(?:don'?t |never |stop )?commit(?:ting)?(?: (?:mat|nahi)\b| for me\b| anything\b| yourself\b|$)/i, () => ["git", ["commit"], []]],
  [/\b(?:delete|deleting|remove|removing) branches\b/i, () => ["git", ["branch"], ["-D", "-d"]]],
  [/\b(?:compose down)\b/i, (t) => ["docker", ["compose"], /(?:^|\s)-v\b|--volumes|volumes?\b/i.test(t) ? ["-v"] : []]],
  [/\b(?:run|running|start|starting) containers?\b/i, (t) => ["docker", ["run"], (t.match(/--[a-z][\w-]*/gi) ?? []).slice(0, 1)]],
  [/\b(?:build|building) (?:docker )?images?\b/i, (t) => ["docker", ["build"], (t.match(/--[a-z][\w-]*/gi) ?? []).slice(0, 1)]],
  [/\binstall\w*\b[^.]*\bglobal(?:ly)?\b|\bglobal(?:ly)? install/i, () => ["npm", ["install"], ["--global"]]],
];

/** Path-looking tokens: src/gen/, .github/workflows, *.snap, go.sum, docker-compose.prod.yml. */
function pathTokens(clause) {
  const out = [];
  const re = /(?:^|[\s`'"(])((?:\.{0,2}\/)?(?:[\w.*@-]+\/)+[\w.*@-]*|\*\.[\w.]+|\.(?:env|github|husky|vscode|idea|circleci|gitlab|terraform|config|docker|devcontainer)[\w./*-]*|[\w-]+(?:\.[\w-]+)*\.(?:json|ya?ml|lock|lockb|sum|mod|toml|md|txt|csproj|sln|xml|gradle|cfg|ini|conf|env|snap|proto|tf|tfvars|sql|pem|key|crt|plist|xcconfig|properties|config|js|ts|py|rb|go|rs|java|kt|cs|sh|ps1))(?=$|[\s`'",;:)!?]|\.(?:\s|$))/g;
  for (const m of clause.matchAll(re)) {
    let p = m[1].replace(/^\.\//, "").replace(/\.+$/, "");
    if (!p || /^\.\.?$/.test(p) || /^https?:/.test(p)) continue;
    out.push(p);
  }
  // ".pem files", "*.key files": every file with that extension.
  for (const m of clause.matchAll(/(?:^|\s)\.([a-z0-9]{1,8}) files?\b/gi)) if (!/^env$/i.test(m[1])) out.push(`*.${m[1]}`);
  // "the dist folder", "dist folder mein": a folder named in words.
  for (const m of clause.matchAll(/\b(?:the )?([\w.-]+) (?:folder|directory|dir)\b/gi)) if (!STOP_AFTER.has(m[1].toLowerCase()) && !/^(?:this|that|any|every|whole|project|repo|root|build|output|same|other)$/i.test(m[1])) out.push(`${m[1]}/`);
  const bare = BARE_FILES.exec(clause);
  if (bare) out.push(bare[1]);
  return [...new Set(out)];
}

// Folders tools create wherever they run: protected at any depth.
const ANY_DEPTH = /^(?:node_modules|\.terraform|__pycache__|\.venv|venv|\.next|\.nuxt|\.gradle|\.pytest_cache|\.mypy_cache|__snapshots__|\.git)$/;

/** A path as a glob: a folder is the project's own (and everything under it); a tool's cache folder is any. */
function toGlob(p) {
  if (/[*?]/.test(p)) return p;
  const dir = p.endsWith("/") || (!/\.[\w-]+$/.test(p.split("/").pop()) && !BARE_FILES.test(p));
  const clean = p.replace(/\/+$/, "");
  if (!dir) return clean;
  return ANY_DEPTH.test(clean) ? `**/${clean}/**` : `${clean}/**`;
}

/** "Don't run npm install, use npm ci instead": npm ci stays allowed. */
function withoutPreferred(rule, text) {
  if (!rule.subcommands) return rule;
  const p = rule.program.toLowerCase();
  const keep = new Set();
  const re = new RegExp(String.raw`\b(?:use|prefer|stick to)\s+(?:only\s+)?\`?${p.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c)}\s+([\w:-]+)`, "gi");
  for (const m of text.matchAll(re)) {
    if (/\b(?:don'?t|dont|do not|never|not|no|stop|avoid)\s*$/i.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const sub = m[1].toLowerCase();
    for (const s of [sub, ...(SUB_ALIASES[p]?.[sub] ?? [])]) keep.add(s); // "npm ci" keeps ci, clean-install, ic …
  }
  if (!keep.size) return rule;
  const subs = rule.subcommands.filter((s) => !keep.has(s.toLowerCase()));
  return subs.length ? { ...rule, subcommands: subs } : rule;
}

/**
 * Derive a rule from a correction.
 * @param {string} correction
 * @returns {{type:"command", program:string, subcommands:string[]|null, flags:string[]|null}|{type:"write", globs:string[]}|{type:"not-a-rule", why:string}}
 */
export function deriveRule(correction) {
  const text = stripPrivate(String(correction ?? "")).slice(0, 4000);
  if (!text.trim()) return { type: "not-a-rule", why: "empty" };
  const clauses = clausesOf(text);

  // 1. A program a negating clause forbids.
  let carry = null; // the last program named, for "…--fix keeps deleting imports. Don't use --fix."
  for (const clause of clauses) {
    const { words, stops } = tokensOf(clause);
    const cands = [];
    for (const span of codeSpans(clause)) {
      const sw = wordsOf(span);
      const k = sw.findIndex((w) => isProgramWord(programOf(w)));
      if (k >= 0) {
        const c = commandAt(sw, k, { code: true });
        const at = words.findIndex((w) => programOf(w).toLowerCase() === c.program.toLowerCase());
        cands.push({ ...c, at: at < 0 ? 0 : at });
      }
    }
    for (let k = 0; k < words.length; k++) {
      const w = programOf(words[k]);
      if (!isProgramWord(w)) continue;
      if (cands.some((c) => c.at === k)) continue;
      const c = { ...commandAt(words, k, { stops }), at: k };
      // A word that is also English needs a verb or flag after it, or "run"/"use" before it.
      if (ENGLISH_PROGRAMS.has(w.toLowerCase()) && !c.subs.length && !c.flags.length && !/^(?:run|running|call|calling|use|using)$/i.test(words[k - 1] ?? "")) continue;
      cands.push(c);
    }
    // forbiddenIn needs a negation (or "off limits", "is not …") pointing at the program.
    if (!SCOPED.test(clause)) {
      const forbidden = cands.find((c) => forbiddenIn(words, c));
      if (forbidden) {
        const p = forbidden.program.toLowerCase();
        let { subs, flags } = forbidden;
        // Flags the clause forbids elsewhere ("no git branch -D, not even -d"), not the ones it recommends ("use --dry-run").
        // "Don't pass -auto-approve to terraform": the flag may come first when the program has none of its own.
        const more = words.filter((w, i) => isFlag(w) && (!flags.length || i > forbidden.at) && !/^(?:use|using|prefer|try|with|instead|python[\d.]*|py)$/i.test(words[i - 1] ?? ""));
        flags = [...new Set([...flags, ...more])];
        // Bare "npm" in "use pnpm, not npm": its install verbs.
        if ((p === "npm" || p === "pip") && !subs.length && !flags.length) subs = ["install"];
        if (p === "npm" && /\bglobal(?:ly)?\b/i.test(clause) && !flags.length) flags = ["--global"];
        return withoutPreferred(commandRule(forbidden.program, subs, flags), text);
      }
      // "Don't use --fix" after "ruff check --fix …" in the clause before.
      const fl = words.filter(isFlag);
      if (!cands.length && fl.length && carry && /\b(?:don'?t|never|no|stop|avoid) (?:use |pass |add )?/i.test(clause)) return commandRule(carry.program, carry.subs, fl);
    }
    if (cands.length) carry = cands[cands.length - 1];
  }

  // 2. Files a negating clause protects ("… Don't edit them" points at the clause before).
  let lastPaths = [];
  for (const clause of clauses) {
    if (SCOPED.test(clause)) continue;
    const named = NAMED_PATHS.filter(([re]) => re.test(clause)).flatMap(([, g]) => g);
    let paths = pathTokens(clause);
    if (!paths.length && !named.length && lastPaths.length && NEGATION.test(clause) && WRITE_VERB.test(clause) && /\b(?:them|it|those|these|that folder|those files|these files|it's|its contents)\b/i.test(clause)) paths = lastPaths;
    if (paths.length) lastPaths = paths;
    if (!paths.length && !named.length) continue;
    const protects = (NEGATION.test(clause) && (WRITE_VERB.test(clause) || OWNED.test(clause))) || (OWNED.test(clause) && !/\b(?:run|use|chalao)\b/i.test(clause));
    if (!protects) continue;
    // "the root package.json": that file only, not every package.json below it.
    const root = /\broot\b/i.test(clause);
    const globs = paths.length ? paths.map(toGlob).map((g) => (root && !g.includes("/") && !/[*?]/.test(g) ? `/${g}` : g)) : named;
    return { type: "write", globs: [...new Set(globs)] };
  }

  // 3. A habit named in words.
  for (const clause of clauses) {
    if (!NEGATION.test(clause) || SCOPED.test(clause)) continue;
    for (const [re, make] of PHRASES) {
      if (re.test(clause)) {
        const [program, subs, flags] = make(clause);
        return commandRule(program, subs, flags);
      }
    }
  }

  // 4. "Use pnpm": the tool it replaces (a preference, not an obligation).
  if (PREFER.test(text)) {
    for (const clause of clauses) {
      for (const w of wordsOf(clause)) {
        const r = REPLACES[programOf(w).toLowerCase()];
        if (r && !/\b(?:test|tests|lint|build)\b.*\b(?:after|before)\b/i.test(clause)) return commandRule(r.program, r.sub ? [r.sub] : [], []);
      }
    }
  }
  return { type: "not-a-rule", why: OBLIGATION.test(text) ? "obligation" : NEGATION.test(text) ? "no target" : "no direction" };
}

export const _internals = { pathTokens, codeSpans, commandAt, wordsOf, clausesOf, toGlob };
