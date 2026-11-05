// What a command line runs (plan L4c: the rule matcher's command
// normalisation). Given the text an agent sends to a shell tool, return every
// simple command it would start, as argv arrays, with shell syntax, nested
// shells, substitutions and wrappers seen through:
//
//   chains and control flow   a && b; c | d & e, newlines, if/for/while, ( ), { }
//   nested shells             bash -c / -lc, sh -c, cmd /c, powershell -Command,
//                             -EncodedCommand (decoded), Invoke-Expression, & { }
//   substitutions             $( ), ` `, <( ), PowerShell $( ) and @( )
//   wrappers                  sudo, doas, env, VAR=x, nice, ionice, time, timeout,
//                             stdbuf, nohup, setsid, command, exec, xargs, find -exec,
//                             npx and other package runners, cmd call/start,
//                             Start-Process, wsl
//   spelling                  quotes (n"p"m), \rm, line continuations, call operator
//
// Text that is only data is never a command: quoted arguments, comments,
// here-document bodies (unless fed to a shell), redirection targets, a quoted
// PowerShell expression.
//
// Three dialects: "bash" (Claude Code's Bash tool, Codex shell on Linux and
// macOS, Git Bash), "powershell" (the PowerShell tool, Codex shell on
// Windows), "cmd" (inside cmd /c). Pure: no fs, no spawn.

const MAX_DEPTH = 6;
const MAX_INPUT = 64 * 1024;

/** A word: its text with quotes removed, and whether any part was quoted. */
const word = () => ({ text: "", quoted: false, started: false });

// ---- scanners ---------------------------------------------------------------

/**
 * Find the index of the ")" closing the "(" at `open`, skipping quotes,
 * comments, nesting and (bash) here-document bodies: "Don't" inside
 * $(cat <<'EOF' … EOF) is data, not an open quote. -1 when there is none.
 */
function closeParen(src, open, dialect) {
  let depth = 0;
  const pending = [];
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === "\n" && pending.length) {
      // Skip each here-document body up to its delimiter line.
      for (const { delim, dash } of pending.splice(0)) {
        let j = i + 1;
        for (;;) {
          let e = src.indexOf("\n", j);
          if (e < 0) e = src.length;
          const line = src.slice(j, e).replace(/\r$/, "");
          j = e;
          if ((dash ? line.replace(/^\t+/, "") : line) === delim || e >= src.length) break;
          j = e + 1;
        }
        i = j;
      }
      continue;
    }
    if (c === "\\" && dialect === "bash") {
      i++;
      continue;
    }
    if (c === "`" && dialect === "powershell") {
      i++;
      continue;
    }
    if (c === "#" && (i === open + 1 || /[\s;(|&]/.test(src[i - 1]))) {
      const e = src.indexOf("\n", i);
      if (e < 0) return -1;
      i = e - 1;
      continue;
    }
    if (dialect === "bash" && c === "<" && src[i + 1] === "<" && src[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([^\s'"();&|<>]+)\2/.exec(src.slice(i, i + 200));
      if (m) {
        pending.push({ delim: m[3], dash: m[1] === "-" });
        i += m[0].length - 1;
        continue;
      }
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) return -1;
      i = j;
      continue;
    }
    if (c === '"') {
      for (i++; i < src.length && src[i] !== '"'; i++) if ((src[i] === "\\" && dialect === "bash") || (src[i] === "`" && dialect === "powershell")) i++;
      if (i >= src.length) return -1;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/**
 * Scan bash/sh text into commands (arrays of words) and nested texts.
 * @returns {{commands:{words:object[], heredocs:string[]}[], nested:{text:string, dialect:string}[]}}
 */
function scanBash(src) {
  const commands = [];
  const nested = [];
  let words = [];
  let heredocs = [];
  let cur = null;
  let dropNext = false; // the next word is a redirection target (true) or a here-string ("data")
  let pipedFrom = null; // the command whose output feeds the next one
  let piping = false;
  const pending = []; // here-document delimiters waiting for the end of the line
  const endWord = () => {
    if (cur === null) return;
    if (dropNext === "data") heredocs.push(cur.text); // bash <<< 'npm install' feeds a shell
    if (dropNext) dropNext = false;
    else words.push(cur);
    cur = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) {
      const cmd = { words, heredocs, pipedFrom: piping ? pipedFrom : null };
      commands.push(cmd);
      pipedFrom = cmd;
    }
    piping = false;
    words = [];
    heredocs = [];
  };
  const add = (s, quoted = false) => {
    cur ??= word();
    cur.text += s;
    cur.started = true;
    if (quoted) cur.quoted = true;
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "\\") {
      if (src[i + 1] === "\n") i += 2;
      else if (src[i + 1] === "\r" && src[i + 2] === "\n") i += 3;
      else {
        add(src[i + 1] ?? "");
        i += 2;
      }
      continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j < 0 ? n : j;
      add(src.slice(i + 1, end), true);
      i = end + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "'") {
      // ANSI-C quoting: $'…' with backslash escapes.
      let j = i + 2;
      let buf = "";
      while (j < n && src[j] !== "'") {
        if (src[j] === "\\" && j + 1 < n) {
          const e = src[j + 1];
          buf += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
          continue;
        }
        buf += src[j++];
      }
      add(buf, true);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let buf = "";
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n && '"\\$`\n'.includes(src[j + 1])) {
          if (src[j + 1] !== "\n") buf += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "$" && src[j + 1] === "(" && src[j + 2] !== "(") {
          // Unclosed: everything after it is read as commands, never swallowed.
          const e = closeParen(src, j + 1, "bash");
          const end = e < 0 ? n : e;
          nested.push({ text: src.slice(j + 2, end), dialect: "bash" });
          buf += src.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        if (src[j] === "`") {
          let e = j + 1;
          while (e < n && src[e] !== "`") e += src[e] === "\\" ? 2 : 1;
          nested.push({ text: src.slice(j + 1, e), dialect: "bash" });
          buf += src.slice(j, e + 1);
          j = e + 1;
          continue;
        }
        buf += src[j++];
      }
      add(buf, true);
      i = j + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      const e = closeParen(src, i + 1, "bash");
      const end = e < 0 ? n : e;
      if (src[i + 2] !== "(") nested.push({ text: src.slice(i + 2, end), dialect: "bash" }); // $(( )) is arithmetic
      add(src.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    if (c === "`") {
      let e = i + 1;
      while (e < n && src[e] !== "`") e += src[e] === "\\" ? 2 : 1;
      nested.push({ text: src.slice(i + 1, e), dialect: "bash" });
      add(src.slice(i, e + 1));
      i = e + 1;
      continue;
    }
    if ((c === "<" || c === ">") && src[i + 1] === "(") {
      const e = closeParen(src, i + 1, "bash");
      const end = e < 0 ? n : e;
      nested.push({ text: src.slice(i + 2, end), dialect: "bash" });
      i = end + 1;
      continue;
    }
    // { … } and function bodies: a group, not words of one command.
    if ((c === "{" && cur === null && /[\s]/.test(src[i + 1] ?? "")) || (c === "}" && cur === null)) {
      endCommand();
      i++;
      continue;
    }
    if (c === "#" && cur === null) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      endCommand();
      i++;
      if (c === "\r" && src[i] === "\n") i++;
      // Here-document bodies follow the line that opened them.
      while (pending.length && i < n) {
        const { delim, dash, literal, target } = pending.shift();
        const lines = [];
        while (i < n) {
          let e = src.indexOf("\n", i);
          if (e < 0) e = n;
          const line = src.slice(i, e).replace(/\r$/, "");
          i = e + 1;
          if ((dash ? line.replace(/^\t+/, "") : line) === delim) break;
          lines.push(line);
        }
        const body = lines.join("\n");
        target.push(body);
        // An unquoted delimiter expands the body: $( … ) and ` … ` inside it run.
        if (!literal) {
          for (let k = body.indexOf("$("); k >= 0; k = body.indexOf("$(", k + 2)) {
            const e = closeParen(body, k + 1, "bash");
            nested.push({ text: body.slice(k + 2, e < 0 ? body.length : e), dialect: "bash" });
          }
          for (const m of body.matchAll(/`([^`]*)`/g)) nested.push({ text: m[1], dialect: "bash" });
        }
      }
      continue;
    }
    if (c === ";") {
      endCommand();
      i += src[i + 1] === ";" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === "&") {
        endCommand();
        i += 2;
      } else if (src[i + 1] === ">") {
        endWord();
        i += src[i + 2] === ">" ? 3 : 2;
        dropNext = true;
      } else {
        endCommand();
        i++;
      }
      continue;
    }
    if (c === "|") {
      const pipe = src[i + 1] !== "|";
      endCommand();
      piping = pipe; // a | b: b reads a's output
      i += src[i + 1] === "|" || src[i + 1] === "&" ? 2 : 1;
      continue;
    }
    if (c === "(" || c === ")") {
      endCommand();
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      // "2>" and "3<": the digits are the descriptor, not a word.
      if (cur && !cur.quoted && /^\d+$/.test(cur.text)) cur = null;
      else endWord();
      if (c === "<" && src[i + 1] === "<") {
        if (src[i + 2] === "<") {
          i += 3;
          dropNext = "data"; // here-string: data, unless a shell reads it
          continue;
        }
        let j = i + 2;
        const dash = src[j] === "-";
        if (dash) j++;
        while (src[j] === " " || src[j] === "\t") j++;
        let delim = "";
        let literal = false; // a quoted delimiter ('EOF') keeps the body literal
        while (j < n && !/[\s;&|<>()]/.test(src[j])) {
          if (src[j] === "'" || src[j] === '"') {
            literal = true;
            const q = src[j];
            const e = src.indexOf(q, j + 1);
            delim += src.slice(j + 1, e < 0 ? n : e);
            j = e < 0 ? n : e + 1;
          } else if (src[j] === "\\") {
            literal = true;
            delim += src[j + 1] ?? "";
            j += 2;
          } else delim += src[j++];
        }
        pending.push({ delim, dash, literal, target: heredocs });
        i = j;
        continue;
      }
      let j = i + 1;
      while (j < n && ">&|".includes(src[j])) j++;
      i = j;
      dropNext = true;
      continue;
    }
    add(c);
    i++;
  }
  endCommand();
  return { commands, nested };
}

/** Scan PowerShell text. */
function scanPowerShell(src) {
  const commands = [];
  const nested = [];
  let words = [];
  let cur = null;
  let dropNext = false;
  let call = false; // & or . at command start: the next word is the command even if quoted
  const endWord = () => {
    if (cur === null) return;
    if (dropNext) dropNext = false;
    else words.push(cur);
    cur = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push({ words, heredocs: [] });
    words = [];
    call = false;
  };
  const add = (s, quoted = false) => {
    cur ??= word();
    if (call && !words.length) cur.call = true;
    cur.text += s;
    cur.started = true;
    if (quoted) cur.quoted = true;
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "`") {
      if (src[i + 1] === "\n") i += 2;
      else if (src[i + 1] === "\r" && src[i + 2] === "\n") i += 3;
      else {
        add(src[i + 1] ?? "");
        i += 2;
      }
      continue;
    }
    if (c === "<" && src[i + 1] === "#") {
      const e = src.indexOf("#>", i + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === "'" || c === "‘" || c === "’") {
      let j = i + 1;
      let buf = "";
      while (j < n) {
        if ((src[j] === "'" || src[j] === "’") && src[j + 1] === "'") {
          buf += "'";
          j += 2;
          continue;
        }
        if (src[j] === "'" || src[j] === "’" || src[j] === "‘") break;
        buf += src[j++];
      }
      add(buf, true);
      i = j + 1;
      continue;
    }
    if (c === '"' || c === "“" || c === "”") {
      let j = i + 1;
      let buf = "";
      while (j < n) {
        if (src[j] === "`" && j + 1 < n) {
          buf += src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === '"' && src[j + 1] === '"') {
          buf += '"';
          j += 2;
          continue;
        }
        if (src[j] === '"' || src[j] === "“" || src[j] === "”") break;
        if (src[j] === "$" && src[j + 1] === "(") {
          const e = closeParen(src, j + 1, "powershell");
          const end = e < 0 ? n : e;
          nested.push({ text: src.slice(j + 2, end), dialect: "powershell" });
          buf += src.slice(j, end + 1);
          j = end + 1;
          continue;
        }
        buf += src[j++];
      }
      add(buf, true);
      i = j + 1;
      continue;
    }
    // Here-strings @' … '@ and @" … "@ are data.
    if (c === "@" && (src[i + 1] === "'" || src[i + 1] === '"') && /\r?\n/.test(src.slice(i + 2, i + 4))) {
      const q = src[i + 1];
      const e = src.indexOf(`\n${q}@`, i + 2);
      add(e < 0 ? src.slice(i + 2) : src.slice(i + 2, e), true);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (c === "#" && cur === null) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r" || c === ";") {
      endCommand();
      i++;
      continue;
    }
    if (c === "|") {
      endCommand();
      i += src[i + 1] === "|" ? 2 : 1;
      continue;
    }
    if (c === "&") {
      if (src[i + 1] === "&") {
        endCommand();
        i += 2;
        continue;
      }
      if (!words.length && cur === null) {
        call = true; // the call operator
        i++;
        continue;
      }
      endCommand();
      i++;
      continue;
    }
    if (c === "." && !words.length && cur === null && /[\s{]/.test(src[i + 1] ?? "")) {
      call = true; // dot-sourcing
      i++;
      continue;
    }
    // ( … ), @( … ), $( … ) after a command has started: an argument value
    // (-ArgumentList @('install')) that may also run commands ((npm install)).
    if (c === "(" && (words.length || (cur && !cur.quoted && (cur.text === "$" || cur.text === "@")))) {
      if (cur && !cur.quoted && (cur.text === "$" || cur.text === "@")) cur = null;
      else endWord();
      const e = closeParen(src, i, "powershell");
      const end = e < 0 ? n : e;
      const inner = src.slice(i + 1, end);
      nested.push({ text: inner, dialect: "powershell" });
      for (const piece of inner.split(/[\s,]+/)) {
        const t = piece.replace(/^['"]+|['"]+$/g, "");
        if (t) words.push({ text: t, quoted: true, started: true });
      }
      i = end + 1;
      continue;
    }
    if (c === "(" || c === ")" || c === "{" || c === "}") {
      // A lone $ or @ before ( is a subexpression marker, not a word.
      if (cur && !cur.quoted && (cur.text === "$" || cur.text === "@")) cur = null;
      endCommand();
      i++;
      continue;
    }
    if (c === ">" || (c === "<" && src[i + 1] !== "#")) {
      if (cur && !cur.quoted && /^[\d*]+$/.test(cur.text)) cur = null;
      else endWord();
      let j = i + 1;
      while (j < n && ">&".includes(src[j])) j++;
      if (src[j - 1] === "&" && /\d/.test(src[j] ?? "")) j++; // 2>&1
      else dropNext = true;
      i = j;
      continue;
    }
    if (c === "," && cur !== null && !cur.quoted) {
      // An array literal (a,b): separate words.
      endWord();
      i++;
      continue;
    }
    add(c);
    i++;
  }
  endCommand();
  return { commands, nested };
}

/** Scan cmd.exe text. */
function scanCmd(src) {
  const commands = [];
  let words = [];
  let cur = null;
  let dropNext = false;
  const endWord = () => {
    if (cur === null) return;
    if (dropNext) dropNext = false;
    else words.push(cur);
    cur = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push({ words, heredocs: [] });
    words = [];
  };
  const add = (s, quoted = false) => {
    cur ??= word();
    cur.text += s;
    cur.started = true;
    if (quoted) cur.quoted = true;
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === "^") {
      if (src[i + 1] === "\n") i += 2;
      else if (src[i + 1] === "\r" && src[i + 2] === "\n") i += 3;
      else {
        add(src[i + 1] ?? "");
        i += 2;
      }
      continue;
    }
    if (c === '"') {
      const j = src.indexOf('"', i + 1);
      const end = j < 0 ? n : j;
      add(src.slice(i + 1, end), true);
      i = end + 1;
      continue;
    }
    if (c === " " || c === "\t" || c === "," || c === "=" && cur === null) {
      endWord();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      endCommand();
      i++;
      continue;
    }
    if (c === "&" || c === "|") {
      endCommand();
      i += src[i + 1] === c ? 2 : 1;
      continue;
    }
    if (c === "(" || c === ")") {
      endCommand();
      i++;
      continue;
    }
    if (c === ">" || c === "<") {
      if (cur && !cur.quoted && /^\d+$/.test(cur.text)) cur = null;
      else endWord();
      let j = i + 1;
      while (j < n && ">&".includes(src[j])) j++;
      if (src[j - 1] === "&" && /\d/.test(src[j] ?? "")) j++;
      else dropNext = true;
      i = j;
      continue;
    }
    add(c);
    i++;
  }
  endCommand();
  return { commands, nested: [] };
}

// ---- argv: keywords, assignments, wrappers ------------------------------------

const BASH_KEYWORDS = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "!", "{", "}", "[[", "]]", "function", "coproc"]);
const BASH_HEADERS = new Set(["for", "select", "case"]); // the rest of the command is a header, not a command
const PS_KEYWORDS = new Set(["if", "elseif", "else", "foreach", "for", "while", "do", "until", "switch", "try", "catch", "finally", "trap", "function", "filter", "param", "begin", "process", "end", "return", "throw", "break", "continue", "exit", "in"]);

/** Strip the path and an executable extension: C:\a\npm.cmd → npm. */
export function programName(s) {
  const base = String(s).split(/[\\/]/).pop() ?? "";
  return base.replace(/\.(?:exe|cmd|bat|ps1|com)$/i, "");
}

const lower = (s) => s.toLowerCase();

/** A wrapper's options that take a value (the next argument), by wrapper name. */
const WRAPPERS = {
  sudo: { values: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U", "-r", "-t", "--user", "--group", "--host", "--prompt", "--chdir", "--close-from", "--role", "--type", "--other-user", "--command-timeout"], stopAt: ["-e", "--edit", "-l", "--list", "-v", "--validate", "-k", "-K"] },
  doas: { values: ["-u", "-C"] },
  nice: { values: ["-n", "--adjustment"] },
  ionice: { values: ["-c", "-n", "-p", "--class", "--classdata", "--pid"] },
  time: { values: ["-f", "-o", "--format", "--output"] },
  stdbuf: { values: ["-i", "-o", "-e", "--input", "--output", "--error"] },
  nohup: { values: [] },
  setsid: { values: [] },
  exec: { values: ["-a"] },
  builtin: { values: [] },
  chronic: { values: [] },
  caffeinate: { values: ["-t", "-w"] },
  watch: { values: ["-n", "--interval", "-d", "--differences"] },
  call: { values: [] }, // cmd
  timeout: { values: ["-s", "-k", "--signal", "--kill-after"], positional: 1 },
  xargs: { values: ["-n", "-L", "-P", "-s", "-d", "-E", "-I", "-a", "--max-args", "--max-lines", "--max-procs", "--max-chars", "--delimiter", "--eof", "--replace", "--arg-file"] },
  command: { values: [], stopAt: ["-v", "-V"] }, // command -v x looks x up
  npx: { values: ["-p", "--package", "--cache", "--userconfig", "-w", "--workspace"], script: ["-c", "--call"] },
  pnpx: { values: ["-p", "--package"] },
  bunx: { values: ["-p", "--package"] },
  uvx: { values: ["--from", "--with", "-p", "--python"] },
  wsl: { values: ["-d", "--distribution", "-u", "--user", "--cd"], skip: ["-e", "--exec", "--"] },
  unbuffer: { values: [] },
  winpty: { values: [] },
  busybox: { values: [] }, // busybox sh -c …, busybox rm -rf …
  flock: { values: ["-w", "-E", "--timeout", "--conflict-exit-code"], script: ["-c", "--command"], positional: 1 },
  script: { values: ["-t", "-T", "-O", "-I", "-B", "-E", "-m", "--log-out", "--log-in", "--log-io", "--log-timing"], script: ["-c", "--command"], positional: 1 }, // BSD: script -q file cmd …
};
// Package managers that run a project binary when the word isn't one of their
// own verbs: yarn jest, pnpm eslint --fix, bun vitest.
const OWN_VERBS = {
  yarn: "add install remove upgrade up upgrade-interactive run exec dlx init info why workspace workspaces global cache config link unlink pack publish version test create set plugin node bin constraints dedupe explain npm patch patch-commit rebuild search stage unplug list outdated audit login logout owner tag team import licenses generate-lock-entry check autoclean help policies start".split(" "),
  pnpm: "add install i remove rm uninstall un update up upgrade run exec dlx test t start publish link ln unlink store list ls ll why outdated audit init create import rebuild rb prune fetch patch patch-commit env setup server recursive deploy pack config licenses doctor root bin help install-test it add-global self-update".split(" "),
  bun: "add a install i remove rm update upgrade run x test build create init link unlink pm publish outdated patch repl".split(" "),
};
// npm exec, pnpm dlx/exec, yarn dlx/exec, bun x, pipx run, bundle exec, poetry run …:
// the runner's verb, then the program it runs.
const RUNNER_VERBS = { npm: ["exec", "x"], pnpm: ["dlx", "exec"], yarn: ["dlx", "exec"], bun: ["x"], pipx: ["run"], bundle: ["exec"], poetry: ["run"], pipenv: ["run"], uv: ["run"], pdm: ["run"], hatch: ["run"], rye: ["run"] };
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash", "fish", "mksh"]);
const POWERSHELLS = new Set(["powershell", "pwsh", "powershell_ise"]);

// PowerShell's built-in aliases on Windows (PowerShell 7 on Linux and macOS
// leaves rm, ls, cp … to the native programs).
const PS_ALIASES = {
  rm: "remove-item", ri: "remove-item", del: "remove-item", erase: "remove-item", rd: "remove-item", rmdir: "remove-item",
  cp: "copy-item", copy: "copy-item", cpi: "copy-item", mv: "move-item", move: "move-item", mi: "move-item",
  ls: "get-childitem", dir: "get-childitem", gci: "get-childitem", cat: "get-content", gc: "get-content", type: "get-content",
  sc: "set-content", ac: "add-content", iex: "invoke-expression", saps: "start-process", start: "start-process",
  ni: "new-item", ren: "rename-item", rni: "rename-item", sl: "set-location", cd: "set-location", chdir: "set-location",
  icm: "invoke-command", iwr: "invoke-webrequest", irm: "invoke-restmethod", echo: "write-output", write: "write-output",
};

// powershell.exe / pwsh parameters that take a value; PowerShell accepts any
// unambiguous prefix (-ExecutionPolicy, -ex, -ep).
const PS_VALUE_PARAMS = ["executionpolicy", "windowstyle", "inputformat", "outputformat", "workingdirectory", "configurationname", "version", "settingsfile", "custompipename"];
const PS_VALUE_ALIASES = new Set(["ep", "ex", "w", "if", "of", "wd", "config", "v"]);
function psValueParam(arg) {
  const m = /^-([a-z]+)$/i.exec(arg);
  if (!m) return false;
  const p = m[1].toLowerCase();
  return PS_VALUE_ALIASES.has(p) || (p.length >= 3 && PS_VALUE_PARAMS.some((full) => full.startsWith(p)));
}

const isAssignment = (w) =>/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(w.text);

/** Split a PowerShell -ArgumentList value ("install -g" or "install","-g") into arguments. */
function splitArgs(s) {
  return String(s).split(/[\s,]+/).filter(Boolean);
}

/**
 * Turn one scanned command into argv arrays to check: the command itself
 * after its wrappers, plus anything it runs (nested shells, find -exec, xargs).
 * @returns {{argv:string[], nested:{text:string, dialect:string}[]}[]}
 */
function resolve(cmd, dialect, os) {
  const out = [];
  let words = cmd.words.slice();
  const nested = [];
  if (dialect === "bash") {
    while (words.length && !words[0].quoted && BASH_KEYWORDS.has(words[0].text)) words.shift();
    if (words.length && !words[0].quoted && BASH_HEADERS.has(words[0].text)) return out;
    while (words.length && isAssignment(words[0])) words.shift();
  } else if (dialect === "powershell") {
    while (words.length && !words[0].quoted && PS_KEYWORDS.has(lower(words[0].text))) words.shift();
    // $x = …, [type]$x += …: the right side runs.
    while (words.length >= 2 && /^(?:\[[^\]]*\])*\$[\w:{}]+$/.test(words[0].text) && /^[+\-*/%]?=$/.test(words[1].text)) words = words.slice(2);
    if (words.length && /^\$[\w:{}]*$/.test(words[0].text) && !words[0].call) return out; // an expression
    // A quoted word not after & or . is a string expression: PowerShell prints it.
    if (words.length && words[0].quoted && !words[0].call) return out;
  } else if (dialect === "cmd") {
    words = words.filter((w, k) => !(k === 0 && w.text === "@"));
    if (words.length && /^@/.test(words[0].text)) words[0] = { ...words[0], text: words[0].text.slice(1) };
    if (words.length && /^(?:rem|::)$/i.test(words[0].text)) return out;
    // if [/i] [not] (exist x | errorlevel n | defined v | a==b | a op b) cmd; for … do cmd
    while (words.length && /^(?:if|else)$/i.test(words[0].text)) {
      words.shift();
      if (words[0] && /^\/i$/i.test(words[0].text)) words.shift();
      if (words[0] && /^not$/i.test(words[0].text)) words.shift();
      if (words[0] && /^(?:exist|errorlevel|defined|cmdextversion)$/i.test(words[0].text)) words = words.slice(2);
      else if (words[1] && /^(?:equ|neq|lss|leq|gtr|geq)$/i.test(words[1].text)) words = words.slice(3);
      else words = words.slice(1);
    }
    if (words.length && /^for$/i.test(words[0].text)) {
      const k = words.findIndex((w) => /^do$/i.test(w.text));
      if (k < 0) return out;
      words = words.slice(k + 1);
    }
    // "for %i in (…) do del /s": the ( … ) split the line, so "do" starts this part.
    if (words.length && /^do$/i.test(words[0].text)) words.shift();
  }
  let argv = words.map((w) => w.text);
  const firstQuoted = words.map((w) => w.quoted);
  // Arguments joined back into one script: a single argument is the script as
  // written; several keep their spaces inside quotes (cmd /c "C:\Program Files\…\npm.cmd" install).
  const rejoin = (list) => (list.length === 1 ? list[0] : list.map((a) => (/\s/.test(a) && !/^".*"$/.test(a) ? `"${a}"` : a)).join(" "));
  for (let hop = 0; hop < 12 && argv.length; hop++) {
    const raw = programName(argv[0]);
    let name = lower(raw);
    if (dialect === "powershell" && os === "windows" && PS_ALIASES[name] && !/[\\/.]/.test(argv[0])) {
      name = PS_ALIASES[name];
      argv = [name, ...argv.slice(1)];
    }
    const args = argv.slice(1);
    // Nested shells.
    if (SHELLS.has(name)) {
      let script = null;
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (a === "--") break;
        if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(a)) {
          script = args.slice(k + 1).find((x) => !/^-/.test(x)) ?? null;
          break;
        }
        if (a === "-o" || a === "--rcfile" || a === "--init-file") k++;
        else if (!a.startsWith("-") && !a.startsWith("+")) break; // a script file
      }
      if (script !== null) nested.push({ text: script, dialect: "bash" });
      else if (cmd.heredocs.length) for (const h of cmd.heredocs) nested.push({ text: h, dialect: "bash" });
      else if (cmd.pipedFrom && /^(?:echo|printf)$/.test(lower(programName(cmd.pipedFrom.words[0]?.text ?? "")))) {
        // echo 'npm install' | sh
        nested.push({ text: cmd.pipedFrom.words.slice(1).map((w) => w.text).filter((a) => !/^-[a-z]+$/.test(a)).join(" "), dialect: "bash" });
      }
      out.push({ argv, nested });
      return out;
    }
    if (name === "su" || (name === "php" && lower(args.find((a) => !a.startsWith("-")) ?? "") === "artisan")) {
      out.push({ argv, nested: [] });
      if (name === "su") {
        // su [user] -c "cmd": the script, wherever -c sits.
        const k = args.findIndex((a) => a === "-c" || a === "--command");
        if (k >= 0 && args[k + 1]) nested.push({ text: args[k + 1], dialect: "bash" });
        out.push({ argv: [], nested });
        return out;
      }
      // php artisan migrate:fresh: Laravel's artisan is the program.
      argv = args.slice(args.findIndex((a) => !a.startsWith("-")));
      continue;
    }
    if (name === "eval" && dialect === "bash") {
      nested.push({ text: args.join(" "), dialect: "bash" });
      out.push({ argv, nested });
      return out;
    }
    if (/^(?:python[\d.]*|py|pythonw)$/.test(name)) {
      // python -m pip install …: the module runs as the program.
      let k = 0;
      while (k < args.length && /^-(?:[a-ln-zA-Z]+|\d[\d.]*)$/.test(args[k])) k += /^-[WX]$/.test(args[k]) ? 2 : 1;
      if (args[k] === "-m" && args[k + 1]) {
        out.push({ argv, nested: [] });
        argv = args.slice(k + 1);
        continue;
      }
      out.push({ argv, nested });
      return out;
    }
    if (name === "cmd") {
      const k = args.findIndex((a) => /^\/{1,2}[ckr]$/i.test(a) || /^\/{1,2}[ckr]\b/i.test(a));
      if (k >= 0) {
        const rest = rejoin([args[k].replace(/^\/{1,2}[ckr]/i, ""), ...args.slice(k + 1)].filter(Boolean));
        nested.push({ text: rest, dialect: "cmd" });
      }
      out.push({ argv, nested });
      return out;
    }
    if (POWERSHELLS.has(name)) {
      let script = null;
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (/^-(?:c|co|com|comm|comma|comman|command)$/i.test(a)) {
          script = rejoin(args.slice(k + 1));
          break;
        }
        if (/^-(?:e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)$/i.test(a)) {
          try {
            script = Buffer.from(args[k + 1] ?? "", "base64").toString("utf16le");
          } catch {
            script = null;
          }
          break;
        }
        if (/^-(?:f|fi|fil|file)$/i.test(a)) break; // a script file
        if (psValueParam(a)) {
          k++;
          continue;
        }
        if (a.startsWith("-")) continue;
        // powershell.exe runs a bare argument as a command; pwsh runs it as a file.
        if (name !== "pwsh") script = args.slice(k).join(" ");
        break;
      }
      if (script !== null) nested.push({ text: script, dialect: "powershell" });
      out.push({ argv, nested });
      return out;
    }
    if (name === "invoke-expression") {
      const k = args.findIndex((a) => /^-command$/i.test(a));
      const text = k >= 0 ? args[k + 1] : args.find((a) => !a.startsWith("-"));
      if (text) nested.push({ text, dialect: "powershell" });
      out.push({ argv, nested });
      return out;
    }
    if (name === "start-process") {
      let file = null;
      let list = [];
      const pos = [];
      for (let k = 0; k < args.length; k++) {
        const a = args[k];
        if (/^-(?:filepath|path|fp)$/i.test(a)) file = args[++k];
        else if (/^-(?:argumentlist|args)$/i.test(a)) {
          // The value always follows (it may itself start with "-": '-g','install'); more values follow unless a parameter does.
          if (k + 1 < args.length) list.push(...splitArgs(args[++k]));
          for (k++; k < args.length && !/^-[a-z]+$/i.test(args[k]); k++) list.push(...splitArgs(args[k]));
          k--;
        } else if (/^-(?:verb|workingdirectory|windowstyle|redirectstandard\w+|credential|environment)$/i.test(a)) k++;
        else if (a.startsWith("-")) continue;
        else pos.push(a);
      }
      file ??= pos.shift() ?? null;
      if (!list.length && pos.length) list = pos.flatMap(splitArgs);
      out.push({ argv, nested });
      if (!file) return out;
      argv = [file, ...list];
      continue;
    }
    if (name === "start" && (dialect === "cmd" || os === "windows")) {
      // cmd's start ["title"] [/b /wait /min /max /d dir /i …] program args
      out.push({ argv, nested: [] });
      let k = 0;
      if (hop === 0 && firstQuoted[1] && args[0] !== undefined && dialect === "cmd") k = 1; // a quoted first argument ("" too) is the title
      while (k < args.length && /^\/(?:d|node|affinity)$/i.test(args[k])) k += 2;
      while (k < args.length && /^\//.test(args[k])) k++;
      argv = args.slice(k);
      continue;
    }
    if (name === "env") {
      out.push({ argv, nested: [] });
      let k = 0;
      for (; k < args.length; k++) {
        const a = args[k];
        if (a === "-S" || a === "--split-string") {
          nested.push({ text: args.slice(k + 1).join(" "), dialect: "bash" });
          out.push({ argv, nested });
          return out;
        }
        if (a === "-u" || a === "-C" || a === "--unset" || a === "--chdir") k++;
        else if (a.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
        else break;
      }
      argv = args.slice(k);
      continue;
    }
    if (name === "find") {
      out.push({ argv, nested: [] });
      const k = args.findIndex((a) => /^-(?:exec|execdir|ok|okdir)$/.test(a));
      if (k < 0) return out;
      const end = args.findIndex((a, j) => j > k && (a === ";" || a === "+" || a === "\\;"));
      argv = args.slice(k + 1, end < 0 ? undefined : end).filter((a) => a !== "{}");
      continue;
    }
    if (RUNNER_VERBS[name] && RUNNER_VERBS[name].includes(lower(args.find((a) => !a.startsWith("-")) ?? ""))) {
      const v = args.findIndex((a) => !a.startsWith("-"));
      out.push({ argv, nested: [] });
      let k = v + 1;
      while (k < args.length && args[k].startsWith("-")) k += /^(?:-p|--package|--from|--with)$/.test(args[k]) ? 2 : 1;
      if (args[k] === "--") k++;
      argv = args.slice(k);
      continue;
    }
    if (OWN_VERBS[name]) {
      // yarn jest --watch, pnpm eslint --fix: a project binary, seen as its own command too.
      const v = args.findIndex((a) => !a.startsWith("-"));
      if (v >= 0 && !OWN_VERBS[name].includes(lower(args[v]))) {
        out.push({ argv, nested: [] });
        argv = args.slice(v);
        continue;
      }
    }
    const w = WRAPPERS[name];
    if (w && !(name === "time" && dialect === "powershell")) {
      // The wrapper is a program too ("never use sudo"), then the program it runs.
      out.push({ argv, nested: [] });
      let k = 0;
      let positional = w.positional ?? 0;
      for (; k < args.length; k++) {
        const a = args[k];
        if (a === "--") {
          k++;
          break;
        }
        if (w.stopAt?.includes(a)) {
          out.push({ argv: [], nested });
          return out;
        }
        if (w.script?.includes(a)) {
          nested.push({ text: args[k + 1] ?? "", dialect: "bash" });
          out.push({ argv: [], nested });
          return out;
        }
        if (w.skip?.includes(a)) continue;
        if (w.values.includes(a)) {
          k++;
          continue;
        }
        if (/^--?[\w-]+=/.test(a)) continue;
        if (a.startsWith("-") && a.length > 1) {
          // nice -10, timeout -s9, stdbuf -oL: one argument.
          continue;
        }
        if (name === "sudo" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) continue;
        if (positional > 0) {
          positional--;
          continue;
        }
        break;
      }
      argv = args.slice(k);
      // watch -n 5 'npm test': one string the wrapper hands to a shell.
      if (name === "watch" && argv.length === 1 && /\s/.test(argv[0])) {
        nested.push({ text: argv[0], dialect: "bash" });
        out.push({ argv: [], nested });
        return out;
      }
      continue;
    }
    out.push({ argv, nested });
    return out;
  }
  if (argv.length) out.push({ argv, nested });
  return out;
}

/**
 * Every command a command line runs.
 * @param {string|string[]} command  the text, or an argv array (Codex's exec form)
 * @param {{dialect?:"bash"|"powershell"|"cmd", os?:"linux"|"macos"|"windows"}} [opts]
 * @returns {{argv:string[], dialect:string}[]}
 */
export function commandsIn(command, { dialect = "bash", os = "linux" } = {}) {
  const found = [];
  // Set when part of the text wasn't read (too long, nested too deep): a caller
  // that must not miss anything treats that as "can't tell".
  found.incomplete = false;
  const visit = (text, d, depth) => {
    if (typeof text !== "string" || !text.trim()) return;
    if (depth > MAX_DEPTH) {
      found.incomplete = true;
      return;
    }
    if (text.length > MAX_INPUT) found.incomplete = true;
    const src = text.slice(0, MAX_INPUT);
    const scanned = d === "powershell" ? scanPowerShell(src) : d === "cmd" ? scanCmd(src) : scanBash(src);
    for (const n of scanned.nested) visit(n.text, n.dialect, depth + 1);
    for (const cmd of scanned.commands) {
      for (const r of resolve(cmd, d, os)) {
        if (r.argv.length) found.push({ argv: r.argv, dialect: d });
        for (const n of r.nested) visit(n.text, n.dialect, depth + 1);
      }
    }
  };
  if (Array.isArray(command)) {
    // Codex's exec form: argv already split; a shell in front still runs a script.
    const words = command.map((t) => ({ text: String(t), quoted: true, started: true }));
    words[0] = { ...words[0], quoted: false };
    for (const r of resolve({ words, heredocs: [] }, "bash", os)) {
      if (r.argv.length) found.push({ argv: r.argv, dialect: "bash" });
      for (const n of r.nested) visit(n.text, n.dialect, 1);
    }
    return found;
  }
  visit(String(command ?? ""), dialect, 0);
  return found;
}
