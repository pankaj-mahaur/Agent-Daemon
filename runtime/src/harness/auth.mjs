// `ad auth …` — log the harness in to a model provider.
//
//   ad auth login chatgpt [--device]       ChatGPT subscription (browser or device code)
//   ad auth login openai                   OpenAI API key (hidden prompt or piped stdin)
//   ad auth login openrouter --model <m>   OpenRouter key → secret store, provider active
//   ad auth use <openai|openrouter> [--model <m>]
//   ad auth status
//   ad auth logout [openrouter]
//
// Everything here acts on the harness CODEX_HOME only. If CODEX_HOME was
// not created by ad (AD_CODEX_HOME pointing at a real ~/.codex), mutations
// are refused unless --force: that folder belongs to the user's own codex.

import { createEngine } from "../engine/index.mjs";
import { isManagedHome } from "../engine/codex/home.mjs";
import { PROVIDERS, useProviderEdits } from "../auth/providers.mjs";
import { createSecretStore } from "../auth/secrets.mjs";
import { openUrl, readSecret } from "./io.mjs";

export function maskEmail(email) {
  if (!email || !email.includes("@")) return email ?? "";
  const [user, domain] = email.split("@");
  return `${user.slice(0, 2)}${"*".repeat(Math.max(1, user.length - 2))}@${domain}`;
}

export function describeAccount(acct, config = {}) {
  const provider = config.model_provider ?? "openai";
  const model = config.model ?? "(codex default)";
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
  const usage = "Usage: ad auth login <chatgpt|openai|openrouter> | use <openai|openrouter> | status | logout [openrouter]\n";

  if (!["login", "use", "status", "logout"].includes(sub)) {
    err.write(usage);
    return 1;
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
    if (sub !== "status" && !isManagedHome(engine.home) && !opts.force) {
      err.write(`Refusing to change ${engine.home}: it was not created by ad (it may be your own codex home). Re-run with --force to proceed.\n`);
      return 2;
    }

    if (sub === "status") {
      const [acct, config] = [await engine.account(), await engine.readConfig()];
      out.write(`${"harness home:".padEnd(16)}${engine.home}\n`);
      out.write(`${"active:".padEnd(16)}${describeAccount(acct, config)}\n`);
      for (const p of Object.values(PROVIDERS).filter((p) => p.secret)) {
        out.write(`${(p.id + " key:").padEnd(16)}${store.has(p.secret) ? `stored (${store.backend})` : "not set"}\n`);
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
    err.write(`ad auth: ${e.message}\n`);
    return 1;
  } finally {
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
    out.write(`Open ${r.verificationUrl} and enter code: ${r.userCode}\n`);
  } else {
    const opened = await openBrowser(r.authUrl);
    // Always print the URL: on Windows the opener "succeeds" even when no
    // browser appears (no default browser, remote session).
    out.write(`${opened ? "Opened your browser. If nothing appeared, open" : "Open"} this URL to sign in:\n${r.authUrl}\n`);
  }
  out.write("Waiting for sign-in to finish (Ctrl+C to cancel)…\n");
  // Ctrl+C cancels locally at once. The same Ctrl+C usually reaches the
  // codex child too, so the protocol-level cancel is best-effort: its
  // failure ("codex exited") is expected and not worth reporting.
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
      err.write(`sign-in failed: ${done.error ?? "unknown error"}\n`);
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
