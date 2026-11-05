// Paths and globs for write rules (plan L4c). OS-aware and pure: a call made
// on Windows is judged with Windows rules (backslashes, drive letters, case)
// whatever machine runs the check, so fixtures and replay agree everywhere.

const caseInsensitive = (os) => os === "windows" || os === "macos";

/**
 * Normalise a path to forward slashes with "." and ".." resolved.
 * @returns {{root:string, parts:string[]}|null}  root "" for a relative path
 */
function split(p, os) {
  let s = String(p ?? "");
  if (os === "windows") {
    s = s.replace(/^\\\\\?\\(?:UNC\\)?/i, (m) => (/UNC/i.test(m) ? "\\\\" : "")); // \\?\C:\x, \\?\UNC\host\share
    s = s.replace(/\\/g, "/");
    s = s.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:"); // Git Bash and MSYS: /c/work/app is C:/work/app
  }
  let root = "";
  let m;
  if (os === "windows" && (m = /^([A-Za-z]):(?:\/|$)/.exec(s))) {
    root = `${m[1].toUpperCase()}:/`;
    s = s.slice(m[0].length);
  } else if (os === "windows" && (m = /^\/\/([^/]+)\/([^/]+)\/?/.exec(s))) {
    root = `//${m[1]}/${m[2]}/`;
    s = s.slice(m[0].length);
  } else if (s.startsWith("/")) {
    root = "/";
    s = s.replace(/^\/+/, "");
  }
  const parts = [];
  for (const seg of s.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      // A relative path keeps leading ".." segments ("../../x"); they resolve against cwd later.
      if (parts.length && parts[parts.length - 1] !== "..") parts.pop();
      else if (!root) parts.push("..");
      continue;
    }
    parts.push(seg);
  }
  return { root, parts };
}

/**
 * The path relative to the project root, with forward slashes, or null when
 * it is outside the project.
 * @param {string} target  absolute, or relative to cwd
 * @param {{cwd:string, root:string, os:string}} ctx
 */
export function projectRelative(target, { cwd, root, os }) {
  let t = split(target, os);
  if (!t.root) {
    const base = split(cwd ?? root, os);
    t = split([base.root + base.parts.join("/"), ...t.parts].join("/"), os);
  }
  const r = split(root, os);
  const fold = caseInsensitive(os) ? (x) => x.toLowerCase() : (x) => x;
  if (fold(t.root) !== fold(r.root) || t.parts.length < r.parts.length) return null;
  for (let i = 0; i < r.parts.length; i++) if (fold(t.parts[i]) !== fold(r.parts[i])) return null;
  const rel = t.parts.slice(r.parts.length);
  return rel.length ? rel.join("/") : null;
}

const RE_SPECIAL = /[.+^${}()|\\]/g;

/**
 * A glob as a regex over a project-relative path ("a/b/c.ts"):
 *   *  any characters inside one folder name; ?  one character
 *   ** any number of folders (zero included); a trailing / means "everything under"
 *   no slash at all (package-lock.json, *.snap): the name at any depth, as in .gitignore
 *   a leading / or ./ (/package.json): the project root only
 *   no wildcard (src/gen): that path and everything under it
 *   {a,b}: either
 * A glob that can't be read matches nothing.
 */
export function globToRegExp(glob, { os = "linux" } = {}) {
  try {
    return compileGlob(glob, os);
  } catch {
    return /(?!)/;
  }
}

function compileGlob(glob, os) {
  let g = String(glob).trim().replace(/\\/g, "/");
  const anchored = /^\.?\//.test(g);
  g = g.replace(/^\.\//, "").replace(/^\/+/, "");
  if (g.endsWith("/")) g = `${g}**`;
  const anywhere = !anchored && !g.includes("/");
  const literal = !/[*?[{]/.test(g);
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*" && g[i + 1] === "*") {
      const slashAfter = g[i + 2] === "/";
      const slashBefore = i === 0 || g[i - 1] === "/";
      if (slashBefore && slashAfter) {
        re += "(?:.*/)?";
        i += 2;
      } else if (slashBefore && i + 2 === g.length) {
        re = re.replace(/\/$/, "") + (re === "" ? ".*" : "(?:/.*)?");
        i += 1;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const e = g.indexOf("}", i + 1);
      if (e < 0) re += "\\{";
      else {
        re += `(?:${g.slice(i + 1, e).split(",").map((alt) => alt.replace(/[.+^$()|\\[\]]/g, (x) => "\\" + x).replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")).join("|")})`;
        i = e;
      }
    }
    else if (c === "[") {
      const e = g.indexOf("]", i + 1);
      if (e < 0) re += "\\[";
      else {
        re += `[${g.slice(i + 1, e).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
        i = e;
      }
    } else re += c.replace(RE_SPECIAL, (x) => "\\" + x);
  }
  if (literal) re += "(?:/.*)?";
  if (anywhere) re = `(?:.*/)?${re}`;
  return new RegExp(`^${re}$`, caseInsensitive(os) ? "i" : "");
}

/** Does any glob match this project-relative path? */
export function globsMatch(globs, rel, { os = "linux" } = {}) {
  return (Array.isArray(globs) ? globs : [globs]).some((g) => typeof g === "string" && globToRegExp(g, { os }).test(rel));
}
