// The attribution module: the only place in runtime/src that may name the
// engine in prose (own-harness plan §4, D2, D4). Every screen, refusal and
// file ad writes that names it renders from here; the brand lint's rule C
// (runtime/scripts/check-brand.mjs) exempts this file and nothing else.
//
// Why these places may name it: ad runs on OpenAI's open-source Codex, pinned
// and isolated in its own home. Apache-2.0 §6 grants no trademark rights but
// permits describing origin, and §4 asks for attribution where upstream's
// text is reproduced (the two prompt files below). Where the OS or OpenAI's
// own pages show the engine's name (the process in UAC, Task Manager and the
// firewall; the ChatGPT sign-in page), hiding it would read as malware.
// Everywhere else ad says "the engine", defined once in `ad about`.
//
// Pure: parameters in, text out. The façade and the CLI pass the versions,
// paths and the sign-in route they know; nothing here reads the engine.
// Draft texts (identityBlock: C6, migrateMessages: C8) are signed off at the
// part that wires them; the exports and their parameters are the contract.

export const ENGINE = Object.freeze({
  name: "Codex",
  vendor: "OpenAI",
  license: "Apache-2.0",
  url: "https://github.com/openai/codex",
  processName: "codex", // codex.exe on Windows: what UAC, Task Manager and the firewall show
  npmPackage: "@openai/codex",
});

/** The pre-3.0 engine home folder under ~/.agent-daemon; kept as a link on new installs (D7). */
export const legacyHomeName = "codex-home";

/** The per-project folder the engine reads (hooks, skills, settings); named in the docs only. */
export const projectConfigFolder = ".codex";

/** The sign-in routes the identity block knows. */
export const SIGN_IN_ROUTES = Object.freeze(["chatgpt", "openai-key", "openrouter", "account"]);

/** Files that reproduce upstream's text verbatim; their first lines must keep this attribution (Apache-2.0 §4(c)). */
export const ATTRIBUTED_FILES = Object.freeze([
  Object.freeze({ file: "runtime/src/tui/init-prompt.mjs", header: /openai\/codex \(Apache-2\.0\)/ }),
  Object.freeze({ file: "runtime/src/tui/recap.mjs", header: /openai\/codex \(Apache-2\.0\)/ }),
]);

// ── ad about ───────────────────────────────────────────────────────────────

/**
 * The lines `ad about` prints for the engine. `engineVersion` is the installed
 * binary's, or undefined when none is installed.
 * @param {{engineVersion?: string, pinnedVersion: string, homePath: string, settingsPath: string}} p
 */
export function aboutLines({ engineVersion, pinnedVersion, homePath, settingsPath }) {
  const origin = `by ${ENGINE.vendor}, ${ENGINE.license}, ${ENGINE.url}`;
  let first;
  if (!engineVersion) first = `engine: ${ENGINE.name} ${origin} (not installed; ad pins ${pinnedVersion}: cd runtime && npm install)`;
  else if (engineVersion === pinnedVersion) first = `engine: ${ENGINE.name} ${engineVersion} ${origin}`;
  else first = `engine: ${ENGINE.name} ${engineVersion} ${origin} (installed ${engineVersion}; ad was tested with ${pinnedVersion})`;
  return [
    first,
    `its process shows as ${ENGINE.processName} (${ENGINE.processName}.exe on Windows) in Task Manager, UAC prompts and the firewall`,
    `engine home: ${homePath}`,
    `engine settings: ${settingsPath} (TOML, the engine's own format)`,
  ];
}

// ── sign-in (ChatGPT route only; API-key and OpenRouter routes say nothing about the engine) ──

export const signInNoteBrowser = `Opening your browser to sign in with ChatGPT. The page is ${ENGINE.vendor}'s and may say '${ENGINE.name}': that is the engine ad runs on.`;

export function signInNoteDevice({ url, code }) {
  return `Go to ${url} and enter ${code}. ${ENGINE.vendor}'s page may say '${ENGINE.name}': that is the engine ad runs on.`;
}

// ── README (one sentence under "How it works"; test-checked against the README from Part 5) ──

export const readmeSentence = `ad runs on a pinned copy of ${ENGINE.vendor}'s open-source ${ENGINE.name} engine (${ENGINE.license}) in its own folder; ad never writes to your own \`~/${projectConfigFolder}\`. The optional elevated sandbox (\`ad sandbox setup --elevated\`) is machine-wide. \`ad about\` has the details.`;

// ── identity (the managed instructions block, D5; text per C6, signed off at Part 4 after S3) ──

const SIGN_IN_CLAUSES = Object.freeze({
  chatgpt: `a ChatGPT plan, so the model is ${ENGINE.vendor}'s`,
  "openai-key": `an ${ENGINE.vendor} key, so the model is ${ENGINE.vendor}'s unless the key was pointed at another endpoint`,
  openrouter: "OpenRouter, so the model may come from any provider",
  // ad's api home (P3.4): every API account the user added runs here, through ad's gateway.
  account: "an account the user picked in ad (provider and model show in /status)",
});

/**
 * What the agent knows about itself. No model name: the model is known only
 * after a thread starts and changes with /model; the text says when to name one.
 * @param {{adVersion: string, engineVersion: string, signIn: "chatgpt"|"openai-key"|"openrouter"|"account"}} p
 */
export function identityBlock({ adVersion, engineVersion, signIn } = {}) {
  const clause = SIGN_IN_CLAUSES[signIn];
  if (!clause) throw new Error(`identityBlock: unknown sign-in route ${JSON.stringify(signIn)}; one of ${SIGN_IN_ROUTES.join(", ")}`);
  for (const [name, value] of [["adVersion", adVersion], ["engineVersion", engineVersion]]) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`identityBlock: ${name} must be a version string, got ${JSON.stringify(value)}`);
  }
  return [
    `You are Agent Daemon's agent, working on the user's machine. Facts: Agent Daemon ${adVersion}; engine: ${ENGINE.vendor}'s open-source ${ENGINE.name} ${engineVersion}; signed in with ${clause}.`,
    `Your base instructions may call you "${ENGINE.name}": that is the engine's name, not yours. Mention these facts only when asked, and plainly.`,
    `Who are you: Agent Daemon's agent. What runs you, or are you ${ENGINE.name} or ChatGPT: you are Agent Daemon's agent; the engine under it is ${ENGINE.vendor}'s open-source ${ENGINE.name}; the model comes from the user's sign-in; you are not the ChatGPT app.`,
    "Which model: use the name this conversation gives you; otherwise say what you believe and that you can't confirm it, or that you don't know, and that the model picker or /status shows it where available. Never invent a model; never deny these facts.",
  ].join("\n");
}

// ── the elevated sandbox consent (`ad sandbox setup --elevated`, /setup-default-sandbox) ──

export const sandboxConsentBody = `Windows will ask for administrator permission. The helper is ${ENGINE.vendor}'s sandbox program, shipped with the engine. It creates sandbox accounts and firewall rules on this machine, shared with any other ${ENGINE.name} install.`;

export const sandboxConsent = `${sandboxConsentBody} Continue? [y/N]`;

// ── true statements about the user's own install of the engine ─────────────
// (export names stay brand-free: their callers live outside the allowed zone)

/** The /cd home guard: ad never works inside the user's own engine home. */
export function ownEngineHomeRefusal(dir) {
  return `ad doesn't work inside a ${ENGINE.name} home: ${dir}`;
}

/** The engine refuses to start without a home of its own (the default home is the user's own install). */
export const ownEngineHomeDefaultRefusal = `ad won't start the engine without a home folder of its own: the default (~/${projectConfigFolder}) belongs to your own ${ENGINE.name} install.`;

/** The engine refuses to start in the user's own home. */
export function ownEngineHomeStartRefusal(dir) {
  return `ad won't run the engine in ${dir}: that is your own ${ENGINE.name} home. Choose another folder with AD_ENGINE_DIR.`;
}

// ── start-up isolation (P0.2a): a working folder whose project layer is the user's own ~/.codex ──

const homeLoads = (loads = ["skills"]) => `your own ${ENGINE.name} ${loads.includes("skills") && loads.includes("settings") ? "skills and settings" : loads.includes("settings") ? "settings" : "skills"}`;

/** ad run/chat/loop (strict in a later release), acp and web: the folder is refused. */
export function homeFolderRefusal({ loads } = {}) {
  return `Run this in a project folder: ~/${projectConfigFolder} in your home folder has ${homeLoads(loads)}, which ad would load here. Use --cwd <project>, or add --allow-home-folder.`;
}

/** The launcher's one dim line. */
export function homeLauncherWhy({ loads } = {}) {
  return `Your home folder's ~/${projectConfigFolder} has ${homeLoads(loads)}; ad would load them here.`;
}

/** The launcher's "Open home anyway" hint. */
export function homeOpenAnywayHint({ loads } = {}) {
  return `loads ${homeLoads(loads)} from ~/${projectConfigFolder}`;
}

/** /cd into a refused folder. */
export function homeCdRefusal({ loads } = {}) {
  return `That folder would load ${homeLoads(loads)} from ~/${projectConfigFolder} into this session. Pick a project folder, or allow it: start ad with --allow-home-folder, or choose Always open home in the launcher.`;
}

/** One transcript note when the override is on and something loads. */
export function homeOverrideNote({ loads } = {}) {
  return `Working in your home folder: ${homeLoads(loads)} from ~/${projectConfigFolder} load in this session.`;
}

/** The trust question is skipped: trusting this folder (under a git home) would apply the home's settings. */
export const homeTrustSkippedNote = `ad didn't offer to trust this folder: your home folder is a git repository, so trusting a folder in it would also apply your own ${ENGINE.name} settings from ~/${projectConfigFolder} here. Give the project its own git repository to trust it.`;

/** A one-time note when ad removed a trusted home entry from its engine settings. */
export const homeTrustRemovedNote = `ad removed the trust its engine had for your home folder, so your own ${ENGINE.name} settings no longer apply in ad. Folders you trusted are unchanged.`;

/** A 3.0 scheduled job in the home folder, kept running (one note per job). */
export function homeJobNote(id) {
  return `Scheduled job ${id} runs in your home folder, where your own ${ENGINE.name} skills load. Move it with ad schedule add --cwd <project>, or keep it as is.`;
}

/** A team worker started in the caller's home folder (worktree: false). */
export function homeWorkerNote(name) {
  return `Worker ${name} runs in your home folder, where your own ${ENGINE.name} skills load. Give the team a project folder, or keep it as is.`;
}

/** ad doctor's "Home folder" row (doctor rows never name the engine). */
export function homeDoctorNote({ trusted, loadable, settingsPath }) {
  if (trusted) return `your home folder is trusted in ${settingsPath}, so your own engine settings there would apply; the next ad start removes that trust`;
  if (loadable) return "refused as a working folder: your own skills there would load (override: --allow-home-folder, AD_ALLOW_HOME_FOLDER=1 or the allowHomeFolder pref)";
  return "nothing from your own engine install would load there";
}

/** Non-interactive ad run/chat/loop in a refused folder, until a later release makes it strict (one note per folder). */
export const homeCliGraceNote = `ad ran in your home folder, where your own ${ENGINE.name} skills load. A later release will need --allow-home-folder here.`;

/** `ad watch` reads the user's own engine conversations, like Claude Code's and Cursor's. */
export const ownEngineSessionsNote = `ad watch also reads your own ${ENGINE.name} conversations in ~/${projectConfigFolder}/sessions, if you have ${ENGINE.name} installed; ad never writes there.`;

// ── tombstones for the dropped hand-off to the engine's own UI (C4, C14: through 3.x) ──

function tombstone(what, settingsPath) {
  return `${what} was removed in 3.0. Settings: ${settingsPath}. Resume a conversation: \`ad --last\`. More: docs/upgrade-3.0.md.`;
}

/** The `ad codex` CLI command. */
export function tombstoneEngineUiCommand({ settingsPath }) {
  return tombstone("`ad codex`", settingsPath);
}

/** The `/codex` slash command. */
export function tombstoneEngineUiSlash({ settingsPath }) {
  return tombstone("/codex", settingsPath);
}

/** The unanswerable form the engine's own UI would show (modals.mjs): ad cancels it with this. */
export const formAutoCancel = "This form can only be answered in the engine's own UI, which ad doesn't ship; ad cancelled it. Use /mcp, or a static token in the engine settings (see the upgrade guide).";

// ── the engine home on disk (D7, C8; drafts signed off at Part 2 after S1) ──

export function twoHomesRefusal({ oldPath, newPath }) {
  return `Two engine folders exist: ${oldPath} and ${newPath}. ad won't pick for you; nothing is deleted. \`ad doctor\` shows each one's last use, conversation count and sign-in. Rename the one you don't want (for example to \`engine.old\`); don't delete either until you've checked.`;
}

export const migrateMessages = Object.freeze({
  done({ oldPath, newPath, unsafeDeleteTool, macos }) {
    const lines = [`Moved ${oldPath} to ${newPath}. Sign-in, conversations, skills and hooks came along; nothing was deleted. \`${legacyHomeName}\` is now a link (hidden on Windows) that older versions need; \`ad doctor\` lists it.`];
    if (unsafeDeleteTool) lines.push(`Delete it only with \`rmdir\`, never with \`${unsafeDeleteTool}\`.`);
    if (macos) lines.push("Restart `ad watch` (or the service) once.");
    return lines.join(" ");
  },
  busy({ oldPath }) {
    return `Not moved: something is using ${oldPath} (another Agent Daemon window, an editor's agent panel, a background loop, a terminal, or antivirus). Nothing changed. Close it and run \`ad migrate\` again.`;
  },
  failed({ reason }) {
    return `Couldn't move the data folder (${reason}). Nothing changed.`;
  },
  customPath({ path }) {
    return `AD_CODEX_HOME still works (its new name is AD_ENGINE_DIR). Using ${path}; nothing moved.`;
  },
  oneEmpty({ name }) {
    return `Found a second, empty engine folder; set it aside as ${name}.`;
  },
});

/**
 * Names from ad 2.x that users may still type or set; read forever (design C11).
 * Code outside the adapter reads them through this object, never as literals,
 * so the brand lint stays clean.
 */
export const LEGACY = Object.freeze({
  productValue: "codex", // the old value of --engine, --llm, --host and their env vars
  command: "codex", // the removed command
  envHome: "AD_CODEX_HOME",
  envBin: "AD_CODEX_BIN",
  envModel: "AD_CODEX_LLM_MODEL",
});

/** An old env var name still works, once per install. */
export function envRenameNote(oldName, newName) {
  return `${oldName} still works (its new name is ${newName}).`;
}

/** Both names of one setting are set, to different values. */
export function envConflictRefusal({ newName, oldName, newValue, oldValue }) {
  return `${newName} (${newValue}) and ${oldName} (${oldValue}) point at different folders. Keep one of them.`;
}

// ── the live brand test's allowance (spike S5) ─────────────────────────────

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * One pattern per place above that carries the engine's name, as rendered
 * (parameters as wildcards). The live brand test strips these and model names
 * from ad's chrome, refusals and written files, then asserts that nothing
 * else names the engine. The test proves the list covers every rendered text
 * and that a bare "Codex stopped" on screen is still caught.
 */
export function brandPatterns() {
  const { name, vendor, processName } = ENGINE;
  const pathChars = "[\\w~.:\\\\/-]*";
  return [
    new RegExp(`engine: ${name} (?:\\S+ )?by ${vendor}, ${escapeRe(ENGINE.license)}, ${escapeRe(ENGINE.url)}`),
    new RegExp(`its process shows as ${processName} \\(${processName}\\.exe on Windows\\)`),
    new RegExp(`may say '${name}': that is the engine ad runs on\\.`),
    new RegExp(`${vendor}'s open-source ${name} engine \\(${escapeRe(ENGINE.license)}\\)`),
    new RegExp(`${vendor}'s open-source ${name}(?: \\S+;|;)`),
    new RegExp(`call you "${name}": that is the engine's name, not yours`),
    new RegExp(`are you ${name} or ChatGPT`),
    new RegExp(`shared with any other ${name} install\\.`),
    new RegExp(`ad doesn't work inside a ${name} home:`),
    new RegExp(`your own ${name} conversations in ~/${escapeRe(projectConfigFolder)}/sessions, if you have ${name} installed`),
    new RegExp(`the default \\(~/${escapeRe(projectConfigFolder)}\\) belongs to your own ${name} install\\.`),
    new RegExp(`: that is your own ${name} home\\. Choose another folder with AD_ENGINE_DIR\\.`),
    new RegExp(`your own ${name} (?:skills and settings|skills|settings)`),
    /AD_CODEX_[A-Z_]+ still works \(its new name is AD_ENGINE_[A-Z_]+\)\./,
    /\) and AD_CODEX_HOME \(/,
    /`ad codex` was removed in 3\.0\./,
    /\/codex was removed in 3\.0\./,
    /AD_CODEX_HOME still works/,
    new RegExp(`${pathChars}${escapeRe(legacyHomeName)}${pathChars}`), // a path or link named after the old home
    new RegExp(`${pathChars}[\\\\/]${escapeRe(projectConfigFolder)}(?=[\\\\/\\s\`'"]|$)${pathChars}`), // the user's own ~/.codex
    new RegExp(escapeRe(ENGINE.url)),
  ];
}

/** Every text this module can render, with sample parameters; the test proves brandPatterns() covers them all. */
export function renderedSamples() {
  const p = { oldPath: "~/.agent-daemon/codex-home", newPath: "~/.agent-daemon/engine", settingsPath: "~/.agent-daemon/engine/config.toml" };
  return [
    ...aboutLines({ engineVersion: "0.160.0", pinnedVersion: "0.160.0", homePath: "~/.agent-daemon/engine", settingsPath: p.settingsPath }),
    ...aboutLines({ engineVersion: "0.161.0", pinnedVersion: "0.160.0", homePath: "~/.agent-daemon/engine", settingsPath: p.settingsPath }),
    ...aboutLines({ pinnedVersion: "0.160.0", homePath: "~/.agent-daemon/engine", settingsPath: p.settingsPath }),
    signInNoteBrowser,
    signInNoteDevice({ url: "https://auth.openai.com/device", code: "ABCD-EFGH" }),
    readmeSentence,
    ...SIGN_IN_ROUTES.map((signIn) => identityBlock({ adVersion: "3.0.0", engineVersion: "0.160.0", signIn })),
    sandboxConsent,
    sandboxConsentBody,
    ownEngineHomeRefusal("~/.codex"),
    ownEngineHomeDefaultRefusal,
    ...[["skills"], ["settings"], ["skills", "settings"]].flatMap((loads) => [homeFolderRefusal({ loads }), homeLauncherWhy({ loads }), homeOpenAnywayHint({ loads }), homeCdRefusal({ loads }), homeOverrideNote({ loads })]),
    homeTrustRemovedNote,
    homeTrustSkippedNote,
    homeJobNote("nightly"),
    homeWorkerNote("w1"),
    homeDoctorNote({ trusted: true, settingsPath: "~/.agent-daemon/engine/config.toml" }),
    homeDoctorNote({ loadable: true }),
    homeDoctorNote({}),
    homeCliGraceNote,
    ownEngineHomeStartRefusal("C:\\Users\\me\\.codex"),
    ownEngineSessionsNote,
    tombstoneEngineUiCommand(p),
    tombstoneEngineUiSlash(p),
    formAutoCancel,
    twoHomesRefusal(p),
    migrateMessages.done({ ...p, unsafeDeleteTool: "Remove-Item -Recurse", macos: true }),
    migrateMessages.done(p),
    migrateMessages.busy(p),
    migrateMessages.failed({ reason: "permission denied" }),
    migrateMessages.customPath({ path: "D:\\engine" }),
    migrateMessages.oneEmpty({ name: "codex-home.empty-2026-10-12" }),
    envRenameNote("AD_CODEX_BIN", "AD_ENGINE_BIN"),
    envRenameNote("AD_CODEX_LLM_MODEL", "AD_ENGINE_MODEL"),
    envConflictRefusal({ newName: "AD_ENGINE_DIR", oldName: "AD_CODEX_HOME", newValue: "D:\\a", oldValue: "D:\\b" }),
  ];
}
