// Starting the gateway child (P3.3): one per ad process, started before the first engine
// that needs it, outliving engine restarts (same port, same token).
//
//   startGateway({ table, getKeys, onUpstream, ...opts }) →
//     { port, token, baseUrlFor(entry), setTable(table), last(accountId), close(), child }
// table: Map<entry, route> (table.mjs); getKeys(accountIds) → { accountId: key } (one
// secret-store read). The token is 32 random bytes made here; keys and token travel over
// IPC only. The child's env is minimal: PATH, the OS basics, proxy and CA settings.

import { fork } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { registerSecret } from "../auth/redact.mjs";

const MAIN = fileURLToPath(new URL("./main.mjs", import.meta.url));
const KEEP = ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "windir", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "NODE_EXTRA_CA_CERTS", "NODE_USE_ENV_PROXY", "SSL_CERT_FILE"];

/** The child's environment: no keys, no ad or engine variables. */
export function gatewayEnv(env = process.env) {
  const out = {};
  for (const k of KEEP) if (env[k] !== undefined) out[k] = env[k];
  // A CA users set for the engine works for the gateway too.
  if (!out.NODE_EXTRA_CA_CERTS && env.CODEX_CA_CERTIFICATE) out.NODE_EXTRA_CA_CERTS = env.CODEX_CA_CERTIFICATE;
  return out;
}

const accountsOf = (table) => [...new Set([...table.values()].filter((r) => r.auth?.kind !== "none").map((r) => r.accountId))];
// Functions (token providers) can't cross IPC: only static-key and none routes go there.
const wire = (table) => [...table.entries()].filter(([, r]) => r.auth?.kind !== "token-provider");

// sessionId: this ad session's id for providers that want one per session (OpenCode Go's
// x-opencode-session outside a conversation); made here, so it is ad's, not the child's.
export async function startGateway({ table = new Map(), getKeys = async () => ({}), onUpstream = () => {}, env = process.env, startTimeoutMs = 15_000, sessionId = randomUUID(), ...rest } = {}) {
  const opts = { ...rest, sessionId };
  const token = randomBytes(32).toString("base64url");
  registerSecret(token, "gateway token");
  const keys = await getKeys(accountsOf(table));
  for (const k of Object.values(keys)) registerSecret(k, "key");
  const child = fork(MAIN, [], { detached: process.platform !== "win32", windowsHide: true, stdio: ["pipe", "ignore", "pipe", "ipc"], env: gatewayEnv(env), execArgv: [] });
  child.stderr?.resume();
  const last = new Map();
  const byThread = new Map(); // the engine's thread → its last translated request's event (≤ 256)
  let closing = false;
  child.on("message", (m) => {
    if (m?.type !== "upstream") return;
    last.set(m.event.accountId, m.event);
    if (m.event.threadId) {
      byThread.delete(m.event.threadId);
      byThread.set(m.event.threadId, m.event);
      if (byThread.size > 256) byThread.delete(byThread.keys().next().value);
    }
    try {
      onUpstream(m.event);
    } catch {
      // an observer's failure is its own
    }
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ad: the gateway didn't start")), startTimeoutMs);
    child.once("error", reject);
    child.once("exit", (code) => !closing && reject(new Error(`ad: the gateway stopped at start (exit ${code})`)));
    const onReady = (m) => {
      if (m?.type !== "ready") return;
      clearTimeout(timer);
      child.off("message", onReady);
      resolve(m.port);
    };
    child.on("message", onReady);
    child.send({ type: "init", token, table: wire(table), keys, opts });
  });
  // The child never keeps ad running: when ad's work is done it exits, its pipe and IPC
  // channel close, and the child ends with it.
  child.unref();
  child.channel?.unref?.();
  child.stdin?.unref?.();
  child.stderr?.unref?.();
  return {
    port,
    token,
    child,
    baseUrlFor: (entry) => `http://127.0.0.1:${port}/p/${entry}/v1`,
    async setTable(next) {
      const k = await getKeys(accountsOf(next));
      for (const v of Object.values(k)) registerSecret(v, "key");
      await new Promise((resolve) => {
        const on = (m) => {
          if (m?.type !== "table-set") return;
          child.off("message", on);
          resolve();
        };
        child.on("message", on);
        child.send({ type: "table", table: wire(next), keys: k });
      });
    },
    last: (accountId) => last.get(accountId) ?? null,
    /** The last translated request's event for a conversation (the engine's thread id). */
    lastForThread: (threadId) => (threadId ? (byThread.get(threadId) ?? null) : null),
    async close() {
      closing = true;
      if (child.exitCode !== null) return;
      const gone = new Promise((r) => child.once("exit", r));
      try {
        child.send({ type: "close" });
      } catch {
        child.kill();
      }
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
      if (child.exitCode === null) child.kill();
    },
  };
}
