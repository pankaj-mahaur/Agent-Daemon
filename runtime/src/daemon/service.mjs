// OS service registration for the watch daemon (`ad service install`).
//
// Per-user only — no admin/root required on any platform:
//   - Windows: Scheduled Task (`schtasks /SC ONLOGON`)
//   - macOS:   LaunchAgent plist under ~/Library/LaunchAgents
//   - Linux:   systemd user unit under ~/.config/systemd/user
//
// The render functions are pure (string in → string out) so tests can assert
// the generated artifacts without touching the OS. install/uninstall/status
// dispatch on process.platform and shell out.

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SERVICE_NAME = "agent-daemon-watch";
const LAUNCHD_LABEL = "com.agent-daemon.watch";

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || ".";
}

function cliPath() {
  // service.mjs lives at runtime/src/daemon/, cli.mjs at runtime/src/
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "cli.mjs");
}

export function defaultLogDir() {
  return path.join(homeDir(), ".agent-daemon", "logs");
}

/* ------------------------------------------------------------------ */
/* Pure render functions (unit-testable, no OS calls)                  */
/* ------------------------------------------------------------------ */

/**
 * Arguments for `schtasks /Create` registering a per-user logon task.
 *
 * @param {{ nodePath: string, cli: string, logDir: string }} opts
 * @returns {string[]}
 */
export function renderSchtasksArgs({ nodePath, cli, logDir }) {
  // schtasks /TR has a 261-char limit and mangles nested quotes; route through
  // cmd so the watch process detaches from the schtasks parent cleanly.
  const logFile = path.join(logDir, "watch.log");
  const tr = `"${nodePath}" "${cli}" watch --log-file "${logFile}"`;
  return [
    "/Create", "/F",
    "/SC", "ONLOGON",
    "/TN", SERVICE_NAME,
    "/TR", tr
  ];
}

/**
 * macOS LaunchAgent plist.
 *
 * @param {{ nodePath: string, cli: string, logDir: string }} opts
 * @returns {string}
 */
export function renderLaunchdPlist({ nodePath, cli, logDir }) {
  const logFile = path.join(logDir, "watch.log");
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(cli)}</string>
    <string>watch</string>
    <string>--log-file</string>
    <string>${esc(logFile)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${esc(logFile)}</string>
  <key>StandardErrorPath</key>
  <string>${esc(logFile)}</string>
</dict>
</plist>
`;
}

/**
 * systemd user unit.
 *
 * @param {{ nodePath: string, cli: string, logDir: string }} opts
 * @returns {string}
 */
export function renderSystemdUnit({ nodePath, cli, logDir }) {
  const logFile = path.join(logDir, "watch.log");
  return `[Unit]
Description=agent-daemon transcript watcher (digest pipeline)
After=default.target

[Service]
Type=simple
ExecStart=${nodePath} ${cli} watch --log-file ${logFile}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

/* ------------------------------------------------------------------ */
/* OS dispatch                                                         */
/* ------------------------------------------------------------------ */

function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (c) => out += c);
    child.stderr.on("data", (c) => err += c);
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
    child.on("error", (e) => resolve({ code: -1, out: "", err: e.message }));
  });
}

async function renderOpts(logDir) {
  const dir = logDir || defaultLogDir();
  await fs.mkdir(dir, { recursive: true });
  return { nodePath: process.execPath, cli: cliPath(), logDir: dir };
}

/**
 * Register the watch daemon as a per-user login service.
 *
 * @param {{ logDir?: string }} [opts]
 * @returns {Promise<{ ok: boolean, note: string }>}
 */
export async function installService(opts = {}) {
  const ro = await renderOpts(opts.logDir);

  if (process.platform === "win32") {
    const r = await run("schtasks", renderSchtasksArgs(ro));
    return r.code === 0
      ? { ok: true, note: `Scheduled Task "${SERVICE_NAME}" registered (runs at logon). Logs: ${path.join(ro.logDir, "watch.log")}` }
      : { ok: false, note: `schtasks failed (${r.code}): ${r.err || r.out}` };
  }

  if (process.platform === "darwin") {
    const plistPath = path.join(homeDir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await fs.mkdir(path.dirname(plistPath), { recursive: true });
    await fs.writeFile(plistPath, renderLaunchdPlist(ro), "utf8");
    // Reload if already loaded — unload errors are expected on first install.
    await run("launchctl", ["unload", plistPath]);
    const r = await run("launchctl", ["load", plistPath]);
    return r.code === 0
      ? { ok: true, note: `LaunchAgent loaded: ${plistPath}. Logs: ${path.join(ro.logDir, "watch.log")}` }
      : { ok: false, note: `launchctl load failed (${r.code}): ${r.err || r.out}` };
  }

  // Linux / other POSIX: systemd user unit
  const unitDir = path.join(homeDir(), ".config", "systemd", "user");
  const unitPath = path.join(unitDir, `${SERVICE_NAME}.service`);
  await fs.mkdir(unitDir, { recursive: true });
  await fs.writeFile(unitPath, renderSystemdUnit(ro), "utf8");
  const reload = await run("systemctl", ["--user", "daemon-reload"]);
  if (reload.code !== 0) {
    return { ok: false, note: `wrote ${unitPath} but systemctl --user daemon-reload failed: ${reload.err || reload.out}` };
  }
  const r = await run("systemctl", ["--user", "enable", "--now", SERVICE_NAME]);
  return r.code === 0
    ? { ok: true, note: `systemd user service enabled: ${unitPath}. Logs: ${path.join(ro.logDir, "watch.log")}` }
    : { ok: false, note: `systemctl enable failed (${r.code}): ${r.err || r.out}` };
}

/**
 * Unregister the watch service. Never deletes logs.
 *
 * @returns {Promise<{ ok: boolean, note: string }>}
 */
export async function uninstallService() {
  if (process.platform === "win32") {
    const r = await run("schtasks", ["/Delete", "/F", "/TN", SERVICE_NAME]);
    return r.code === 0
      ? { ok: true, note: `Scheduled Task "${SERVICE_NAME}" removed` }
      : { ok: false, note: `schtasks /Delete failed (${r.code}): ${r.err || r.out}` };
  }

  if (process.platform === "darwin") {
    const plistPath = path.join(homeDir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await run("launchctl", ["unload", plistPath]);
    try { await fs.unlink(plistPath); } catch { /* already gone */ }
    return { ok: true, note: `LaunchAgent unloaded and removed: ${plistPath}` };
  }

  await run("systemctl", ["--user", "disable", "--now", SERVICE_NAME]);
  const unitPath = path.join(homeDir(), ".config", "systemd", "user", `${SERVICE_NAME}.service`);
  try { await fs.unlink(unitPath); } catch { /* already gone */ }
  const r = await run("systemctl", ["--user", "daemon-reload"]);
  return { ok: r.code === 0, note: `systemd user service removed: ${unitPath}` };
}

/**
 * Report whether the service is registered (and running where knowable).
 *
 * @returns {Promise<{ installed: boolean, note: string }>}
 */
export async function serviceStatus() {
  if (process.platform === "win32") {
    const r = await run("schtasks", ["/Query", "/TN", SERVICE_NAME]);
    return r.code === 0
      ? { installed: true, note: `Scheduled Task "${SERVICE_NAME}" registered` }
      : { installed: false, note: "not registered — run: ad service install" };
  }

  if (process.platform === "darwin") {
    const r = await run("launchctl", ["list", LAUNCHD_LABEL]);
    return r.code === 0
      ? { installed: true, note: `LaunchAgent ${LAUNCHD_LABEL} loaded` }
      : { installed: false, note: "not loaded — run: ad service install" };
  }

  const r = await run("systemctl", ["--user", "is-enabled", SERVICE_NAME]);
  return r.code === 0
    ? { installed: true, note: `systemd user service enabled (${r.out})` }
    : { installed: false, note: "not enabled — run: ad service install" };
}
