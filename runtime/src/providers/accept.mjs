// Provider acceptance (P3.5b): "supported" always means proven on a real call. One real
// coding task on one of your accounts, through ad's own path (launch → the account's
// engine → the gateway → the provider), written up as a dated record you review.
//
//   runAcceptance({ account, model, out, store, env, clientVersion, now, startOpts }) → { file, record }
//
// Refused under CI: acceptance runs only on your machine, with your own keys. The record
// never holds a key: what is measured is written by ad, what only a person can check
// (official docs, price source, data terms) is left as "(fill in)". Status starts at
// candidate; a person raises it after reviewing.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSyncNoShell, resolveGit, resolvedArgv } from "../safe-spawn.mjs";
import { redact, registerSecret } from "../auth/redact.mjs";
import { adRoot } from "../ad-root.mjs";
import { readRegistry } from "../auth/accounts/registry.mjs";
import { accountName } from "../auth/accounts/target.mjs";
import { resolveAccountRef } from "../harness/auth-accounts.mjs";
import { launchHarness } from "../harness/engines.mjs";
import { lastUpstream } from "../harness/gateway-runtime.mjs";
import { engineVersion } from "../engine/index.mjs";
import { listModels } from "./models.mjs";
import { presetFor } from "./registry.mjs";

export const ACCEPT_TEXTS = Object.freeze({
  REFUSED_CI: "Provider acceptance runs only on your machine, with your own keys.",
  PROMPT: "Make the failing test in test.mjs pass, then run it.",
});

const FILL = "(fill in)";

/** The workspace: a git repo with one failing test the agent must fix. */
function scratchWorkspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ad-accept-"));
  fs.writeFileSync(path.join(dir, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
  fs.writeFileSync(path.join(dir, "test.mjs"), 'import assert from "node:assert/strict";\nimport { sum } from "./sum.mjs";\nassert.equal(sum(2, 3), 5);\nconsole.log("test.mjs: ok");\n');
  try {
    const [cmd, args] = resolvedArgv(resolveGit(), ["init", "-q"]);
    execFileSyncNoShell(cmd, args, { cwd: dir, stdio: "ignore" });
  } catch {
    // git isn't needed for the task itself
  }
  return dir;
}

/** Where records go: the plan's acceptance folder in a repo checkout (git-ignored), else <ad root>/acceptance. */
export function defaultOutDir({ repoRoot = null, adRootDir = adRoot() } = {}) {
  if (repoRoot && fs.existsSync(path.join(repoRoot, "docs", "plans"))) return path.join(repoRoot, "docs", "plans", "post-v3-program", "research", "acceptance");
  return path.join(adRootDir, "acceptance");
}

export async function runAcceptance({ account: ref, model = null, out, store, env = process.env, clientVersion = "dev", now = () => new Date(), startOpts = {}, fetch } = {}) {
  if (env.CI) throw Object.assign(new Error(ACCEPT_TEXTS.REFUSED_CI), { code: "ACCEPT_CI" });
  const doc = readRegistry();
  const account = resolveAccountRef(doc, ref);
  const preset = presetFor(account.provider);
  const key = account.credential?.kind === "secret" ? store.get(account.credential.ref) : null;
  if (key) registerSecret(key, "key"); // every copy (escaped, encoded) is redacted from here on

  // 1. Models, as ad lists them (free flags need a fresh price).
  let models = [];
  let modelsError = null;
  try {
    models = await listModels(account, { key, fetch, clientVersion, refresh: true });
  } catch (e) {
    modelsError = redact(e.message);
  }

  // 2. The task, on the real engine through the gateway. The workspace goes on every path.
  const cwd = scratchWorkspace();
  const tools = [];
  const started = Date.now();
  let turn = null;
  let startError = null;
  let r = null;
  let elapsedMs = 0;
  let testPasses = false;
  try {
    try {
      r = await launchHarness({ cwd, account: account.id, model: model ?? undefined, store, err: { write: () => true }, clientVersion, ...startOpts });
    } catch (e) {
      startError = redact(e.message);
    }
    if (r && !r.engine) startError = redact(r.error ?? "the engine didn't start");
    else if (r) {
      try {
        const { threadId } = await r.engine.startThread({ cwd, modelProvider: r.params.modelProvider, model: r.params.model, approvalPolicy: "never", sandbox: "workspace-write" });
        turn = await r.engine.turn({
          threadId,
          text: ACCEPT_TEXTS.PROMPT,
          timeoutMs: 10 * 60_000,
          onEvent: (ev) => {
            if (ev.type === "itemStarted" && ev.item?.type && ev.item.type !== "agentMessage" && ev.item.type !== "userMessage" && ev.item.type !== "reasoning") tools.push(ev.item.type);
          },
        });
      } catch (e) {
        startError = redact(e.message);
      } finally {
        await Promise.resolve(r.release()).catch(() => {});
      }
    }
    elapsedMs = Date.now() - started;
    // The agent wrote test.mjs: it runs with no environment of ad's (no key, no home) and,
    // through Node's permission model, may read only its own folder.
    try {
      execFileSyncNoShell(process.execPath, ["--permission", `--allow-fs-read=${cwd}`, "test.mjs"], { cwd, stdio: "ignore", timeout: 30_000, env: { PATH: process.env.PATH ?? process.env.Path ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) } });
      testPasses = true;
    } catch {
      testPasses = false;
    }
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }

  const obs = lastUpstream(account.id);
  const free = models.filter((m) => m.free);
  const date = now().toISOString().slice(0, 10);
  const record = [
    `# Provider acceptance: ${preset.name} (${date})`,
    "",
    "Written by `runtime/scripts/provider-accept.mjs`; the lines marked (fill in) are a person's to check.",
    "",
    "~~~text",
    `Provider ID / service / model family: ${preset.id} / ${preset.name} / ${r?.params?.model ?? model ?? "(the account's default)"}`,
    `Adapter and auth method: gateway ${preset.mode}, ${account.method === "openrouter-oauth" ? "OpenRouter sign-in (PKCE key)" : account.method === "none" ? "no key" : "API key"}`,
    `Account metadata fields (no credential values): ${accountName(account)}, status ${account.status}, key hint …${account.keyHint ?? "-"}`,
    `Official documentation and checked date: ${preset.docs.join(", ") || FILL} (preset checked ${preset.checkedAt}); ${FILL}`,
    `Exact base URL / wire / model ID / region/deployment: ${account.endpoint ?? preset.upstreamBase} / responses / ${r?.params?.model ?? model ?? "-"} / ${FILL}`,
    `API vs subscription entitlement: ${account.method === "none" ? "local, no key" : "API key"}`,
    "Token refresh owner and keyring/home namespace proof: ad's secret store; the engine holds only the gateway token",
    `Tools/custom tools / vision / structured output / cancellation: tools called: ${[...new Set(tools)].join(", ") || "none"}; ${FILL}`,
    `Context/output limits: source and confidence: ${FILL}`,
    `Price/free status: source, observation time, expiry: ${preset.freeSource ?? "none"}; ${models.length} models listed${modelsError ? ` (${modelsError})` : ""}; ${free.length} free${free.length ? ` (e.g. ${free.slice(0, 3).map((m) => m.id).join(", ")})` : ""}; observed ${models[0]?.priceObservedAt ? new Date(models[0].priceObservedAt).toISOString() : "-"}, valid 24 h`,
    `Quota scope/group/reset semantics: last gateway observation: ${obs ? redact(JSON.stringify({ status: obs.status, limits: obs.limits ?? null, class: obs.errorClass ?? null })) : "none"}; ${FILL}`,
    `Data handling/retention restrictions relevant to route consent: ${free.length ? `${free[0].dataNote} ` : ""}${FILL}`,
    "Mock contract tests and result: provider-wave1.test.mjs, accounts-signin.test.mjs (run them before raising the status)",
    `Real scratch coding task/test/memory result: turn ${turn?.status ?? "not run"}${startError ? ` (${startError})` : ""}; test.mjs ${testPasses ? "passes" : "still fails"}; ${Math.round(elapsedMs / 1000)} s; usage ${turn?.usage ? redact(JSON.stringify(turn.usage)) : "not reported"}`,
    `Supported OS/client versions and actual evidence: ${process.platform} ${os.release()}, Node ${process.versions.node}, ad ${clientVersion}, engine ${engineVersion.installed().version ?? engineVersion.pinned() ?? "?"}`,
    `Known limitations / unsupported features: ${FILL}`,
    "Status: candidate",
    "Recovery/rollback: remove the account (its key goes with it); the preset stays a candidate",
    "~~~",
    "",
  ].join("\n");
  const dir = out ?? defaultOutDir({});
  fs.mkdirSync(dir, { recursive: true });
  // One record per account and day: a second account of the provider never overwrites it.
  const file = path.join(dir, `${preset.id}-${String(account.label).replace(/[^A-Za-z0-9._-]+/g, "_")}-${date}.md`);
  // Belt and braces: the key never reaches the record, whatever a provider echoed.
  const safe = key ? redact(record).split(key).join("[redacted:key]") : redact(record);
  fs.writeFileSync(file, safe);
  return { file, record: safe, turn: turn?.status ?? null, testPasses };
}
