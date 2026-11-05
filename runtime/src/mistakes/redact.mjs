// Redaction for what the mistakes report shows or shares (D13: one redacted
// sentence of at most 200 characters per repeated cluster). Secrets go
// through the one secret-pattern module; then URLs keep only their host,
// absolute paths keep only their last part, and the account name, e-mail
// addresses, @handles and IP addresses are replaced. People's names inside a
// sentence can't be found reliably: --share says so.

import os from "node:os";
import path from "node:path";
import { redactSecrets } from "../security/secret-patterns.mjs";
import { stripPrivate } from "../digest/sanitize.mjs";

export const MAX_SENTENCE = 200;

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, (c) => "\\" + c);

/** Names that identify this machine's user: the account name and the home folder's name. */
export function accountNames({ home = os.homedir(), env = process.env } = {}) {
  const names = new Set();
  try {
    names.add(os.userInfo().username);
  } catch {
    // no passwd entry (containers): the env and home folder still name the user
  }
  for (const v of [env.USER, env.USERNAME, env.LOGNAME, path.basename(home ?? "")]) if (v) names.add(v);
  return [...names].filter((n) => n && n.length >= 3 && !/^(root|admin|user|users|home|runner|ubuntu)$/i.test(n));
}

// Every quantifier is bounded or anchored: these run on text the user typed,
// which can be a pasted 50 KB blob.
const URL_RE = /\b[a-z][a-z0-9+.-]{0,30}:\/\/[^\s"'`<>)\]]+/gi;
const SCP_RE = /\b([\w.-]{1,64})@([\w-]{1,63}(?:\.[\w-]{1,63}){1,8}):(?!\/\/)[^\s"'`<>]{1,512}/g;
const EMAIL_RE =/[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}\b/g;
// $HOME/…, ${HOME}/…, %USERPROFILE%\…, $env:USERPROFILE\…: the home folder by another name.
const ENV_HOME_RE = /(?:\$HOME|\$\{HOME\}|%USERPROFILE%|%HOMEPATH%|\$env:USERPROFILE|\$env:HOME)(?=[\\/])/gi;
// Folder names may hold spaces ("D:\Program Files\…", "/Users/x/Client Work/…") when a separator follows.
const SEG = String.raw`[^\\/\s"'` + "`" + String.raw`<>|*?]+(?: [^\\/\s"'` + "`" + String.raw`<>|*?]+)*[\\/]`;
const LAST = String.raw`[^\s"'` + "`" + String.raw`<>|*?\\/]*`;
const WIN_PATH_RE = new RegExp(String.raw`\b[A-Za-z]:[\\/](?:${SEG})*${LAST}`, "g");
const TILDE_PATH_RE = new RegExp(String.raw`(?<![\w~])~[\\/](?:${SEG})+${LAST}`, "g");
const UNC_RE = /\\\\[^\s"'`<>|*?]+/g;
const POSIX_PATH_RE = new RegExp(String.raw`(?<![\w.:~/\\-])\/(?:${SEG.replace(String.raw`[\\/]`, "/")})+${LAST}`, "g");
const MAX_INPUT = 4000;
const HANDLE_RE = /(^|[\s(,;:])@([A-Za-z][\w-]{1,38})\b(?![/.@])/g;
const IP_RE = /\b(?!127\.0\.0\.1\b)(?!0\.0\.0\.0\b)(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;

const lastPart = (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";

/**
 * Redact one sentence for display or sharing.
 * @param {string} text
 * @param {{home?:string, names?:string[], max?:number}} [opts]
 */
export function redactSentence(text, { home = os.homedir(), names = accountNames({ home }), max = MAX_SENTENCE } = {}) {
  let t = stripPrivate(String(text ?? "")).slice(0, MAX_INPUT);
  // URLs first: user:password@host loses its credentials with the rest of the URL.
  t = t.replace(URL_RE, (u) => {
    try {
      const url = new URL(u);
      const rest = url.pathname.length > 1 || url.search ? "/…" : "";
      return `${url.protocol}//${url.host}${rest}`;
    } catch {
      return "<url>";
    }
  });
  // git@host:org/repo.git: the org and repo can name a client.
  t = t.replace(SCP_RE, (_m, user, host) => `${user}@${host}:…`);
  t = redactSecrets(t).text;
  t = t.replace(EMAIL_RE, "<email>");
  t = t.replace(ENV_HOME_RE, "~");
  // Folder names in a path can name a client or a person: only the last part stays.
  t = t.replace(TILDE_PATH_RE, (p) => `~/…/${lastPart(p)}`);
  t = t.replace(UNC_RE, (p) => `<path>${lastPart(p) ? "\\" + lastPart(p) : ""}`);
  t = t.replace(WIN_PATH_RE, (p) => `<path>${lastPart(p) ? "\\" + lastPart(p) : ""}`);
  t = t.replace(POSIX_PATH_RE, (p) => `<path>/${lastPart(p)}`);
  if (home) {
    const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
    for (const h of variants) t = t.replace(new RegExp(escapeRe(h) + "(?=$|[\\\\/\\s\"'`])", "gi"), "~");
  }
  for (const n of names) t = t.replace(new RegExp(`(?<![A-Za-z0-9])${escapeRe(n)}(?![A-Za-z0-9])`, "gi"), "<user>");
  t = t.replace(HANDLE_RE, (_m, pre) => `${pre}@<name>`);
  t = t.replace(IP_RE, "<ip>");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}
