// A pure line diff (P5.7): what `ad review` shows before a skill change is applied.
// No git on PATH needed (`git diff --no-index` exits 1 on any difference).
//
//   diffLines(a, b)            → [{ op: " " | "-" | "+", line, noEol? }]
//   unifiedDiff(a, b, opts)    → unified text, "" when the texts are the same
//
// Line endings are normalised (CRLF = LF) and a leading BOM is ignored, so a file
// saved on another OS shows no change. Myers' O(ND) algorithm after trimming the
// common prefix and suffix; past MAX_D edits the middle is shown as replaced.

const MAX_D = 1500;
const ESC = String.fromCharCode(27);
const paint = (code, s) => `${ESC}[${code}m${s}${ESC}[0m`;

/** Text → { lines, noEol }: the last line has no newline when noEol. */
function split(text) {
  const t = String(text ?? "").replace(/^\u{FEFF}/u, "").replace(/\r\n/g, "\n");
  if (t === "") return { lines: [], noEol: false };
  const lines = t.split("\n");
  const noEol = lines.at(-1) !== "";
  if (!noEol) lines.pop();
  return { lines, noEol };
}

// Myers: the shortest edit script between a and b (arrays of keys) → ops on indices.
function myers(a, b) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  let v = new Int32Array(2 * max + 3);
  const trace = [];
  let found = -1;
  for (let d = 0; d <= Math.min(max, MAX_D); d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found >= 0) break;
  }
  if (found < 0) return null;
  // Walk back through the trace.
  const ops = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    // trace[d] holds v[-d-1 .. d+1] as it was before step d (indices shifted by d+1).
    const prev = trace[d];
    const get = (k) => prev[k + d + 1];
    const k = x - y;
    const down = k === -d || (k !== d && get(k - 1) < get(k + 1));
    const pk = down ? k + 1 : k - 1;
    const px = get(pk);
    const py = px - pk;
    while (x > px + (down ? 0 : 1) && y > py + (down ? 1 : 0)) {
      ops.push([" ", x - 1, y - 1]);
      x--;
      y--;
    }
    if (down) {
      ops.push(["+", -1, y - 1]);
      y--;
    } else {
      ops.push(["-", x - 1, -1]);
      x--;
    }
  }
  while (x > 0 && y > 0) {
    ops.push([" ", x - 1, y - 1]);
    x--;
    y--;
  }
  return ops.reverse();
}

/** The edit script between two texts, line by line. */
export function diffLines(aText, bText) {
  const A = split(aText);
  const B = split(bText);
  // A last line without a newline differs from the same line with one.
  const key = (s, i) => (s.noEol && i === s.lines.length - 1 ? `${s.lines[i]}\u{0}noeol` : s.lines[i]);
  const ka = A.lines.map((_, i) => key(A, i));
  const kb = B.lines.map((_, i) => key(B, i));
  let pre = 0;
  while (pre < ka.length && pre < kb.length && ka[pre] === kb[pre]) pre++;
  let suf = 0;
  while (suf < ka.length - pre && suf < kb.length - pre && ka[ka.length - 1 - suf] === kb[kb.length - 1 - suf]) suf++;
  const midA = ka.slice(pre, ka.length - suf);
  const midB = kb.slice(pre, kb.length - suf);
  const item = (op, s, i) => (s.noEol && i === s.lines.length - 1 ? { op, line: s.lines[i], noEol: true } : { op, line: s.lines[i] });
  const out = [];
  for (let i = 0; i < pre; i++) out.push(item(" ", A, i));
  const script = myers(midA, midB);
  if (script) {
    for (const [op, i, j] of script) out.push(op === "+" ? item("+", B, pre + j) : item(op, A, pre + i));
  } else {
    // Too different to align usefully: the middle is replaced.
    for (let i = 0; i < midA.length; i++) out.push(item("-", A, pre + i));
    for (let j = 0; j < midB.length; j++) out.push(item("+", B, pre + j));
  }
  for (let i = ka.length - suf; i < ka.length; i++) out.push(item(" ", A, i));
  return out;
}

/**
 * A unified diff with `context` lines around each change ("" when equal).
 * @param {{ context?: number, color?: boolean, from?: string, to?: string }} [opts]
 */
export function unifiedDiff(aText, bText, { context = 3, color = false, from = "a", to = "b" } = {}) {
  const ops = diffLines(aText, bText);
  const changed = ops.map((o, i) => (o.op === " " ? -1 : i)).filter((i) => i >= 0);
  if (!changed.length) return "";
  // Group changes whose context would touch.
  const groups = [];
  for (const i of changed) {
    const g = groups.at(-1);
    if (g && i - g.end <= 2 * context + 1) g.end = i;
    else groups.push({ start: i, end: i });
  }
  // Line numbers before each op.
  const aNo = [];
  const bNo = [];
  let ai = 0;
  let bi = 0;
  for (const o of ops) {
    aNo.push(ai);
    bNo.push(bi);
    if (o.op !== "+") ai++;
    if (o.op !== "-") bi++;
  }
  const lines = [color ? paint(1, `--- ${from}`) : `--- ${from}`, color ? paint(1, `+++ ${to}`) : `+++ ${to}`];
  for (const g of groups) {
    const s = Math.max(0, g.start - context);
    const e = Math.min(ops.length - 1, g.end + context);
    const slice = ops.slice(s, e + 1);
    const aLen = slice.filter((o) => o.op !== "+").length;
    const bLen = slice.filter((o) => o.op !== "-").length;
    const aStart = aLen ? aNo[s] + 1 : aNo[s];
    const bStart = bLen ? bNo[s] + 1 : bNo[s];
    const head = `@@ -${aStart},${aLen} +${bStart},${bLen} @@`;
    lines.push(color ? paint(36, head) : head);
    for (const o of slice) {
      const text = `${o.op}${o.line}`;
      lines.push(color && o.op === "-" ? paint(31, text) : color && o.op === "+" ? paint(32, text) : text);
      if (o.noEol) lines.push("\\ No newline at end of file");
    }
  }
  return `${lines.join("\n")}\n`;
}
