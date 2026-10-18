// A test that creates engines, locks or memory must run in a fake home.
// assertFakeHome() fails it when os.homedir() is the user's real home
// (os.userInfo().homedir). Locks are also redirected automatically under
// node --test (lock.mjs defaultLockDir); this guard is for everything else.

import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

export function assertFakeHome(what = "this test") {
  let real = null;
  try {
    real = os.userInfo().homedir;
  } catch {
    return; // no passwd entry: nothing to compare with
  }
  const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));
  assert.notEqual(norm(os.homedir()), norm(real), `${what} must set HOME/USERPROFILE to a temp folder, never the real home`);
}
