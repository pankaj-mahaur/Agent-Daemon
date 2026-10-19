// `ad auth` for accounts (P3.5; final texts and help: P3.8a). Used when no engine home was
// chosen (a test or a command naming a home keeps 3.0's behaviour in auth.mjs).
//
//   ad auth login <provider> [--label <l>] [--owner <o>] [--model <m>] [--stdin]
//     an API key (hidden prompt, or the first line of piped stdin), never on the command line
//   ad auth login custom --base-url <url> [--no-key] [--insecure] [--no-test] [--model <m>]
//   ad auth login ollama | lmstudio                       a local server, no key
//   ad auth use <account> [--model <m>]                   the default account
//   ad auth test <account>                                check a stored key again
// A first account becomes the default when it is ready and no other ready account exists
// (a 3.0 ChatGPT sign-in keeps being what ad runs on). ChatGPT sign-in stays in auth.mjs.

import { createInterface } from "node:readline";
import { createAccountService } from "../auth/accounts/service.mjs";
import { findAccount, readRegistry, transact } from "../auth/accounts/registry.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { refuseKeyArgs, signInApiKey, signInCustom, signInLocal, SIGNIN_TEXTS, testKey } from "../auth/accounts/signin.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { redact } from "../auth/redact.mjs";
import { presetFor, UNAVAILABLE } from "../providers/registry.mjs";
import { readSecret } from "./io.mjs";

const OAUTH_LATER = "OpenRouter sign-in in the browser comes in the next update. Meanwhile add a key: ad auth login openrouter";

/** An account by reference, or by provider id when that provider has one account (or one labelled default). */
export function resolveAccountRef(doc, ref) {
  try {
    return findAccount(doc, ref);
  } catch (e) {
    const mine = doc.accounts.filter((a) => a.provider === String(ref).toLowerCase());
    const pick = mine.length === 1 ? mine[0] : mine.find((a) => a.label === "default");
    if (pick) return pick;
    throw e;
  }
}

/** Y/n on a terminal; no terminal (a piped key, a script): no. */
async function askYes(prompt, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) return false;
  const rl = createInterface({ input: stdin, output: stderr });
  try {
    const a = await new Promise((resolve) => rl.question(prompt, resolve));
    return !/^\s*n/i.test(a);
  } finally {
    rl.close();
  }
}

/**
 * After 3.0's "use openai | openrouter" worked: the default account goes back to 3.0's
 * sign-in (or none), so what ad runs on is what the command said.
 */
export async function legacyUseTarget(id, model) {
  await transact((doc) => {
    const legacy = doc.accounts.find((x) => x.migratedFrom === (id === "openai" ? "3.0-default-home" : "3.0-openrouter") && x.status === "ready");
    doc.defaults.target = legacy ? { account: legacy.id, model: model ?? null, effort: null } : null;
  });
}

/** → an exit code, or null when the request isn't for this path. */
export async function cmdAuthAccounts(sub, args = [], opts = {}) {
  if (opts.home) return null;
  const out = opts.stdout ?? process.stdout;
  const errRaw = opts.stderr ?? process.stderr;
  // Whatever goes to the terminal passes the redactor (a key registered at checkKeyText).
  const err = { write: (s) => errRaw.write(redact(String(s))) };
  const store = opts.store ?? createSecretStore();
  const service = createAccountService({ store });
  const id = String(args[0] ?? "").toLowerCase();
  // A key in any argument (the provider's place too) is refused before anything else.
  if (["login", "use", "test"].includes(sub)) refuseKeyArgs({ values: opts.rawValues ?? {}, positionals: args }, id);

  if (sub === "use") {
    if (!args[0]) return null;
    let a;
    try {
      a = resolveAccountRef(readRegistry(), args[0]);
    } catch (e) {
      // 3.0's "use openai | openrouter" with no such account: its own behaviour (auth.mjs),
      // which calls legacyUseTarget once it worked.
      if (["openai", "openrouter"].includes(id) && e.code === "ACCOUNT_NOT_FOUND") return null;
      throw e;
    }
    await transact((doc) => {
      doc.defaults.target = { account: a.id, model: opts.model ?? a.defaultModel ?? null, effort: null };
    });
    out.write(`Default account: ${accountName(a)}${opts.model ? ` (model ${opts.model})` : ""}\n`);
    return 0;
  }

  if (sub === "test") {
    if (!args[0]) return null;
    const a = resolveAccountRef(readRegistry(), args[0]);
    const preset = presetFor(a.provider);
    const key = a.credential?.kind === "secret" ? store.get(a.credential.ref) : null;
    if (a.credential?.kind === "secret" && !key) {
      const text = `The stored key for ${accountName(a)} is missing. Add it again: ad auth login ${a.provider} --label ${a.label}`;
      await service.setStatus(a.id, "needs-sign-in", text);
      err.write(`${text}\n`);
      return 1;
    }
    // An endpoint that passed the one-token test at login is tested that way again.
    const v = await testKey(preset, { key, endpoint: a.endpoint, fetch: opts.fetch, clientVersion: opts.clientVersion, insecure: Boolean(a.insecure), probe: Boolean(a.probed) });
    if (v.status === "ready") {
      await service.setStatus(a.id, "ready");
      out.write(`${accountName(a)} works.\n`);
      return 0;
    }
    const text = v.status === "refused" ? `The key was refused (HTTP ${v.http}). Add it again: ad auth login ${a.provider} --label ${a.label}` : v.detail;
    await service.setStatus(a.id, v.status === "refused" ? "needs-sign-in" : "error", text);
    err.write(`${text}\n`);
    return 1;
  }

  if (sub !== "login" || !id || id === "chatgpt") return null;
  const unavailable = UNAVAILABLE.find((r) => r.id === id);
  if (unavailable) {
    err.write(`${unavailable.text}\n`);
    return 2;
  }
  const preset = presetFor(id);
  const readKey = opts.readKey ?? (() => readSecret(`${preset.name} API key (hidden): `));
  const common = { service, label: opts.label, owner: opts.owner ?? "", fetch: opts.fetch, clientVersion: opts.clientVersion };
  let a;
  if (preset.local) a = await signInLocal({ ...common, provider: id });
  else if (id === "custom") {
    if (!opts.baseUrl) throw Object.assign(new Error("Name your endpoint: ad auth login custom --base-url https://<host>/v1"), { code: "BASE_URL_NEEDED" });
    const confirmProbe = opts.noTest ? async () => false : (opts.confirm ?? (() => askYes(SIGNIN_TEXTS.PROBE_ASK)));
    a = await signInCustom({ ...common, baseUrl: opts.baseUrl, noKey: Boolean(opts.noKey), insecure: Boolean(opts.insecure), model: opts.model ?? null, confirmProbe, readKey });
  } else {
    if (opts.oauth) {
      err.write(`${OAUTH_LATER}\n`);
      return 2;
    }
    a = await signInApiKey({ ...common, provider: id, readKey, defaultModel: opts.model ?? null });
  }
  // The default: this one, when it works and no other ready account could already be it.
  let isDefault = false;
  await transact((doc) => {
    const others = doc.accounts.filter((x) => x.id !== a.id && x.status === "ready");
    const mine = doc.accounts.find((x) => x.id === a.id);
    if (!doc.defaults.target && mine?.status === "ready" && !others.length) {
      doc.defaults.target = { account: a.id, model: a.defaultModel ?? null, effort: null };
      isDefault = true;
    } else isDefault = doc.defaults.target?.account === a.id;
  });
  if (a.status === "ready") out.write(`${accountName(a)} is ready${a.keyHint ? ` (key …${a.keyHint})` : ""}.${isDefault ? " It is your default account." : ` Make it the default: ad auth use ${a.provider}/${a.label}`}\n`);
  else err.write(`${accountName(a)}: ${a.statusDetail}\n`);
  return a.status === "ready" ? 0 : 1;
}

export { SIGNIN_TEXTS };
