// Tests for the pure render functions in daemon/service.mjs — assert the
// generated service artifacts without touching schtasks/launchctl/systemctl.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderSchtasksArgs,
  renderLaunchdPlist,
  renderSystemdUnit,
  defaultLogDir
} from "../src/daemon/service.mjs";

const OPTS = {
  nodePath: "/usr/local/bin/node",
  cli: "/opt/agent-daemon/runtime/src/cli.mjs",
  logDir: "/home/u/.agent-daemon/logs"
};

test("renderSchtasksArgs registers a per-user logon task running watch with --log-file", () => {
  const args = renderSchtasksArgs(OPTS);
  assert.ok(args.includes("/Create"));
  assert.ok(args.includes("/SC"));
  assert.equal(args[args.indexOf("/SC") + 1], "ONLOGON");
  assert.equal(args[args.indexOf("/TN") + 1], "agent-daemon-watch");
  const tr = args[args.indexOf("/TR") + 1];
  assert.match(tr, /node/);
  assert.match(tr, /cli\.mjs/);
  assert.match(tr, /watch --log-file/);
  assert.match(tr, /watch\.log/);
});

test("renderLaunchdPlist produces a KeepAlive LaunchAgent with watch args and log paths", () => {
  const plist = renderLaunchdPlist(OPTS);
  assert.match(plist, /<string>com\.agent-daemon\.watch<\/string>/);
  assert.match(plist, /<string>\/usr\/local\/bin\/node<\/string>/);
  assert.match(plist, /<string>watch<\/string>/);
  assert.match(plist, /<string>--log-file<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /StandardErrorPath/);
  assert.match(plist, /watch\.log/);
});

test("renderSystemdUnit produces a user unit with restart-on-failure", () => {
  const unit = renderSystemdUnit(OPTS);
  assert.match(unit, /ExecStart=\/usr\/local\/bin\/node \/opt\/agent-daemon\/runtime\/src\/cli\.mjs watch --log-file/);
  assert.match(unit, /Restart=on-failure/);
  assert.match(unit, /WantedBy=default\.target/);
});

test("plist escapes XML-significant characters in paths", () => {
  const plist = renderLaunchdPlist({ ...OPTS, cli: "/opt/a&b/cli.mjs" });
  assert.match(plist, /\/opt\/a&amp;b\/cli\.mjs/);
  assert.doesNotMatch(plist, /\/opt\/a&b\//);
});

test("defaultLogDir lives under the user's .agent-daemon", () => {
  assert.match(defaultLogDir(), /[\\/]\.agent-daemon[\\/]logs$/);
});
