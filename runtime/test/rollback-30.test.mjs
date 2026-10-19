// The 3.0 rollback test (P3.2, run after every M3 part; AD_ROLLBACK_30=1): after the
// current branch has written everything M3 writes so far (the account registry, the
// adopted openrouter key, an acct- key), ad 3.0 still starts, still shows its sign-in
// state, and still finds its OpenRouter key. Needs the v3.0.0 tag and network for its
// npm install, so it is gated (a CI job runs it on Windows and Linux).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skip = process.env.AD_ROLLBACK_30 === "1" ? false : "set AD_ROLLBACK_30=1 (needs the v3.0.0 tag and network)";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const KEY = ["sk", "or", "v1", "eeeeeeeeeeeeeeee5555"].join("-");

test("ad 3.0 still starts and finds its key after this branch's account changes", { skip, timeout: 900_000 }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ad-rollback-"));
  const home = path.join(root, "home");
  const wt = path.join(root, "v30");
  mkdirSync(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, AD_SECRETS_BACKEND: "file" };
  delete env.AD_ROOT;
  delete env.AD_ENGINE_DIR;
  try {
    // 1. The current branch: the 3.0 key, then everything M3 writes.
    const cur = (code) => execFileSync(process.execPath, ["--input-type=module", "-e", code], { cwd: path.join(REPO, "runtime"), env, encoding: "utf8" });
    cur(`const { createSecretStore } = await import("./src/auth/secrets.mjs"); createSecretStore().set("openrouter", ${JSON.stringify(KEY)});`);
    cur(`const { syncLegacyAccounts } = await import("./src/auth/accounts/migrate.mjs"); const { createSecretStore } = await import("./src/auth/secrets.mjs");
await syncLegacyAccounts({ store: createSecretStore(), legacy: { account: { account: null }, config: { model_provider: "openrouter", model: "m" } } });
const { createAccountService } = await import("./src/auth/accounts/service.mjs");
await createAccountService().addApiKey({ provider: "openrouter", label: "work", key: ${JSON.stringify(KEY.replace("5555", "6666"))} });`);
    // 2. ad 3.0 from its tag.
    execFileSync("git", ["-C", REPO, "worktree", "add", "--detach", wt, "v3.0.0"], { stdio: "inherit" });
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["ci", "--no-audit", "--no-fund"], { cwd: path.join(wt, "runtime"), stdio: "inherit", shell: process.platform === "win32" });
    // 3. 3.0's view of the same home.
    const r = spawnSync(process.execPath, [path.join(wt, "runtime", "src", "cli.mjs"), "auth", "status"], { env, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /openrouter key:\s+stored/);
  } finally {
    spawnSync("git", ["-C", REPO, "worktree", "remove", "--force", wt]);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
