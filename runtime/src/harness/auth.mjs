// `ad auth …` — log the harness in to a model provider.
//
//   ad auth login chatgpt [--device]       ChatGPT subscription (browser or device code)
//   ad auth login openai                   OpenAI API key (hidden prompt or piped stdin)
//   ad auth login openrouter --model <m>   OpenRouter key → secret store, provider active
//   ad auth use <openai|openrouter> [--model <m>]
//   ad auth status
//   ad auth logout [openrouter]
//
// Everything here acts on the engine home only. If the home was
// not created by ad, mutations are refused unless --force: that folder
// belongs to the user's own engine install.

import { cliErrorLines } from "./io.mjs";
import { createEngine, engineHome, engineError } from "../engine/index.mjs";
import { signInNoteBrowser, signInNoteDevice } from "../engine/attribution.mjs";

import { PROVIDERS, useProviderEdits } from "../auth/providers.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { openUrl, readSecret } from "./io.mjs";
import { cmdAuthAccounts, legacyUseTarget } from "./auth-accounts.mjs";
import { redact } from "../auth/redact.mjs";
import { AUTH_HELP, AUTH_TEXTS, loginHelp } from "./auth-texts.mjs";
import { cmdList, cmdLogoutAccount, cmdRemove, cmdRename, cmdStatusAccount, cmdUse, listJson, refuseInToolShell, resolveAccount, statusSummary } from "./auth-commands.mjs";
import { readRegistry } from "../auth/accounts/registry.mjs";
import { syncAccountsFromEngine } from "./accounts-sync.mjs";
import { refuseKeyArgs } from "../auth/accounts/signin.mjs";

const AUTH_COMMANDS = ["login", "list", "use", "rename", "logout", "remove", "status", "test"];
const MUTATING = new Set(["login", "use", "rename", "logout", "remove"]);
// accountCommand's answer for "3.0's logout of the main engine folder's sign-in".
const LEGACY_LOGOUT = Symbol("legacy-logout");
const EXIT_2 = new Set(["TOOL_SHELL", "KEY_ON_COMMAND_LINE", "PROVIDER_UNAVAILABLE", "HOME_UNMANAGED"]);

/**
 * The account commands (P3.8a), when no engine home was chosen. → an exit code, or null
 * for what 3.0's engine path still does (ChatGPT sign-in, `logout` alone, `status` alone).
 */
async function accountCommand(sub, args, o) {
  if (sub === "list") return cmdList({ out: o.out, json: o.json, provider: o.provider, wide: o.wide, width: o.width });
  if (sub === "rename") {
    if (!args[0] || (!args[1] && o.owner === undefined)) throw Object.assign(new Error("Usage: ad auth rename <account> <new-label> [--owner <text>]"), { code: "USAGE" });
    return cmdRename(args[0], args[1], { out: o.out, owner: o.owner, store: o.store });
  }
  if (sub === "remove") {
    if (!args[0]) throw Object.assign(new Error("Usage: ad auth remove <account> [--yes]"), { code: "USAGE" });
    return cmdRemove(args[0], { out: o.out, err: o.err, yes: o.yes, store: o.store, stdin: o.stdin ?? process.stdin, ask: o.ask });
  }
  if (sub === "status" && args[0]) return cmdStatusAccount(args[0], { out: o.out, json: o.json });
  if (sub === "logout" && args[0]) {
    const id = String(args[0]).toLowerCase();
    let a;
    try {
      a = resolveAccount(readRegistry(), args[0]);
    } catch (e) {
      // 3.0's "logout chatgpt | openai | openrouter" with no such account: its own
      // behaviour, with its argument (3.0's "logout openrouter" deletes only that key).
      if (["chatgpt", "openai", "openrouter"].includes(id) && e.code === "ACCOUNT_NOT_FOUND") return null;
      throw e;
    }
    // A sign-in kept by an engine home: the main folder's is 3.0's logout; others are P3.7's.
    if (a.credential?.kind === "engine-home" || a.method === "engine-login") {
      if (a.credential?.home === "@default") return LEGACY_LOGOUT;
      throw Object.assign(new Error(AUTH_TEXTS.CHATGPT_LATER), { code: "CHATGPT_LATER" });
    }
    const r = await cmdLogoutAccount(a.id, { out: o.out, store: o.store });
    if (r.handled) return 0;
    throw Object.assign(new Error(`${a.provider}/${a.label} has no key to sign out; remove it instead: ad auth remove ${a.provider}/${a.label}`), { code: "NOTHING_TO_SIGN_OUT" });
  }
  if (sub === "use" && o.scope === "conflict") throw Object.assign(new Error(AUTH_TEXTS.SCOPE_CONFLICT), { code: "USAGE" });
  if (sub === "use" && (o.scope && o.scope !== "global" || o.effort)) {
    return cmdUse(args[0], { out: o.out, model: o.model, effort: o.effort, scope: o.scope, store: o.store, fetch: o.fetch, clientVersion: o.clientVersion });
  }
  if (sub === "use" && args[0]) {
    // The global default (3.0's "use openai | openrouter" without such an account stays 3.0's).
    try {
      resolveAccount(readRegistry(), args[0]);
    } catch (e) {
      if (["openai", "openrouter"].includes(String(args[0]).toLowerCase()) && e.code === "ACCOUNT_NOT_FOUND") return null;
      throw e;
    }
    return cmdUse(args[0], { out: o.out, model: o.model, scope: "global", store: o.store, fetch: o.fetch, clientVersion: o.clientVersion });
  }
  return null;
}

export function maskEmail(email) {
  if (!email || !email.includes("@")) return email ?? "";
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

export function describeAccount(acct, config = {}) {
  const provider = config.model_provider ?? "openai";
  const model = config.model ?? "(the engine's default)";
  if (provider !== "openai") return `provider ${provider}, model ${model}`;
  const a = acct?.account;
  if (!a) return "not logged in";
  if (a.type === "chatgpt") return `ChatGPT ${a.planType ?? ""} plan (${maskEmail(a.email)}), model ${model}`.replace("  ", " ");
  if (a.type === "apiKey") return `OpenAI API key, model ${model}`;
  return `${a.type}, model ${model}`;
}

export async function cmdAuth(sub, args = [], opts = {}) {
  const out = opts.stdout ?? process.stdout;
  const err = opts.stderr ?? process.stderr;
  const store = opts.store ?? createSecretStore();
  const usage = AUTH_HELP;
  // --json: any error is {"error": {code, message}} on stdout, with the same exit code.
  const failWith = (e) => {
    const code = e.code ?? "AUTH_FAILED";
    const exit = e.exit ?? (EXIT_2.has(code) ? 2 : 1);
    if (opts.json) out.write(`${JSON.stringify({ error: { code, message: redact(e.message) } })}\n`);
    else err.write(cliErrorLines("auth", e));
    return exit;
  };

  if (!sub || sub === "help" || opts.help) {
    if (sub === "login") out.write(loginHelp({ provider: args[0] ?? null }));
    else out.write(usage);
    return sub || opts.help ? 0 : 1;
  }
  if (!AUTH_COMMANDS.includes(sub)) {
    if (opts.json) return failWith(Object.assign(new Error(`unknown command "${sub}". See: ad auth --help`), { code: "USAGE" }));
    err.write(usage);
    return 1;
  }
  try {
    // A key anywhere on the command line is refused before anything reads the arguments
    // (a lookup error would quote it). A new label (rename) is a label, not a reference.
    // An argument that names an existing account is a reference, whatever it looks like.
    const named = (p) => !opts.home && (() => {
      try {
        return Boolean(resolveAccount(readRegistry(), p));
      } catch (e) {
        return e.code === "ACCOUNT_AMBIGUOUS";
      }
    })();
    refuseKeyArgs({ values: opts.rawValues ?? {}, positionals: (sub === "rename" ? args.slice(0, 1) : args).filter((p) => !named(p)) }, args[0]);
    // D49: account changes refuse in the agent's own shell.
    if (MUTATING.has(sub)) refuseInToolShell(opts.env ?? process.env);
    if (sub === "login" && !args[0]) {
      out.write(loginHelp());
      return 1;
    }
    if (!opts.home) {
      const r = await accountCommand(sub, args, { ...opts, out, err, store });
      if (r === LEGACY_LOGOUT) args = [];
      else if (r !== null) return r;
    }
    // Accounts (P3.5): API keys, your own endpoint, local servers; ChatGPT stays below.
    if (["login", "use", "test"].includes(sub)) {
      const r = await cmdAuthAccounts(sub, args, { ...opts, stdout: out, stderr: err, store });
      if (r !== null) return r;
      if (sub === "test") {
        err.write(usage);
        return 1;
      }
    }
    if (["list", "rename", "remove"].includes(sub)) {
      err.write("ad auth: this command works on ad's own accounts, not on an engine home a command chose.\n");
      return 1;
    }
  } catch (e) {
    return failWith(e);
  }

  let engine;
  try {
    engine = await createEngine({
      home: opts.home,
      command: opts.command,
      clientVersion: opts.clientVersion,
      // No provider keys here: auth commands never run a turn, and a damaged
      // stored key must not block the very commands that repair it.
      env: opts.env,
    });
    // ad 3.0's sign-ins as accounts (P3.2), before and after any change below.
    await syncAccountsFromEngine(engine, { store, err });
    if (sub !== "status" && !engineHome.isManaged(engine.home) && !opts.force) {
      return failWith(Object.assign(new Error(`Refusing to change ${engine.home}: ad didn't create it (it may belong to another program). Re-run with --force to proceed.`), { code: "HOME_UNMANAGED", exit: 2 }));
    }

    if (sub === "status") {
      const [acct, config] = [await engine.account(), await engine.readConfig()];
      // 3.0's two labels first; the account summary after them (P3.8a).
      const summary = opts.home ? null : statusSummary(store);
      if (opts.json) {
        out.write(`${JSON.stringify({ schemaVersion: 1, harnessHome: engine.home, active: summary?.active ?? describeAccount(acct, config), ...(opts.home ? {} : listJson(readRegistry())) }, null, 2)}\n`);
        return 0;
      }
      out.write(`${"harness home:".padEnd(16)}${engine.home}\n`);
      out.write(`${"active:".padEnd(16)}${summary?.active ?? describeAccount(acct, config)}\n`);
      if (summary) for (const l of summary.lines) out.write(`${l}\n`);
      else {
        for (const p of Object.values(PROVIDERS).filter((p) => p.secret)) {
          out.write(`${(p.id + " key:").padEnd(16)}${store.has(p.secret) ? `stored (${store.backend})` : "not set"}\n`);
        }
      }
      return 0;
    }

    if (sub === "use") {
      const id = args[0];
      if (PROVIDERS[id]?.secret && !store.has(PROVIDERS[id].secret)) {
        err.write(`No ${id} key stored. Run: ad auth login ${id} --model <slug>\n`);
        return 1;
      }
      await engine.writeConfig(useProviderEdits(id, { model: opts.model }));
      if (!opts.home) await legacyUseTarget(id, opts.model);
      out.write(`active provider: ${id}${opts.model ? ` (model ${opts.model})` : ""}\n`);
      return 0;
    }

    if (sub === "logout") {
      const id = args[0];
      if (id !== undefined && !["chatgpt", "openai", "openrouter"].includes(id)) {
        err.write(`Unknown provider "${id}". ${usage}`);
        return 1;
      }
      if (id === "openrouter") {
        store.delete(PROVIDERS.openrouter.secret);
        if ((await engine.readConfig()).model_provider === "openrouter") await engine.writeConfig(useProviderEdits("openai"));
        out.write("openrouter key removed\n");
        return 0;
      }
      await engine.logout();
      out.write("logged out of ChatGPT / OpenAI\n");
      return 0;
    }

    // login
    const target = args[0];
    if (target === "chatgpt") return await loginChatgpt(engine, { device: opts.device, openBrowser: opts.openBrowser ?? openUrl, out, err });
    if (target === "openai") {
      const apiKey = opts.readKey ? await opts.readKey() : await readSecret("OpenAI API key (hidden): ");
      if (!apiKey) throw new Error("no key entered");
      await engine.loginStart({ type: "apiKey", apiKey });
      if ((await engine.readConfig()).model_provider === "openrouter") await engine.writeConfig(useProviderEdits("openai"));
      out.write(`logged in: ${describeAccount(await engine.account(), await engine.readConfig())}\n`);
      return 0;
    }
    if (target === "openrouter") {
      const edits = useProviderEdits("openrouter", { model: opts.model }); // validates --model first
      const key = opts.readKey ? await opts.readKey() : await readSecret("OpenRouter API key (hidden): ");
      if (!key) throw new Error("no key entered");
      store.set(PROVIDERS.openrouter.secret, key);
      await engine.writeConfig(edits);
      out.write(`openrouter key stored (${store.backend}); active provider: openrouter, model ${opts.model}\n`);
      return 0;
    }
    err.write(usage);
    return 1;
  } catch (e) {
    return failWith(e);
  } finally {
    if (engine && sub !== "status") await syncAccountsFromEngine(engine, { store, err });
    await engine?.close();
  }
}

async function loginChatgpt(engine, { device, openBrowser, out, err }) {
  const completed = engine.waitForLogin(null, { timeoutMs: 15 * 60_000 });
  // If loginStart throws, nobody awaits `completed`; its later rejection
  // (engine closing) must not surface as an unhandled rejection. The await
  // below still sees the real outcome.
  completed.catch(() => {});
  const r = await engine.loginStart({ type: device ? "chatgptDeviceCode" : "chatgpt" });
  if (r.type === "chatgptDeviceCode") {
    out.write(`${signInNoteDevice({ url: r.verificationUrl, code: r.userCode })}\n`);
  } else {
    out.write(`${signInNoteBrowser}\n`);
    const opened = await openBrowser(r.authUrl);
    // Always print the URL: on Windows the opener "succeeds" even when no
    // browser appears (no default browser, remote session).
    out.write(`${opened ? "If nothing appeared, open" : "Open"} this URL to sign in:\n${r.authUrl}\n`);
  }
  out.write("Waiting for sign-in to finish (Ctrl+C to cancel)…\n");
  // Ctrl+C cancels locally at once. The same Ctrl+C usually reaches the
  // engine's process too, so the protocol-level cancel is best-effort: its
  // failure (the engine exited) is expected and not worth reporting.
  let cancel;
  const cancelled = new Promise((_, reject) => (cancel = () => reject(new Error("cancelled"))));
  const onSigint = () => {
    engine.loginCancel(r.loginId).catch(() => {});
    cancel();
  };
  process.once("SIGINT", onSigint);
  try {
    let done;
    try {
      done = await Promise.race([completed, cancelled]);
    } catch (e) {
      if (e.message !== "cancelled") throw e;
      err.write("sign-in cancelled\n");
      return 130;
    }
    if (done.loginId && done.loginId !== r.loginId) throw new Error("login finished for a different request");
    if (!done.success) {
      err.write("sign-in failed\n" + cliErrorLines("auth", engineError(-32000, done.error ?? "unknown error", { raw: done.error ?? "unknown error" })));
      return 1;
    }
    const config = await engine.readConfig();
    if (config.model_provider === "openrouter") await engine.writeConfig(useProviderEdits("openai"));
    out.write(`logged in: ${describeAccount(await engine.account(), await engine.readConfig())}\n`);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
  }
}
