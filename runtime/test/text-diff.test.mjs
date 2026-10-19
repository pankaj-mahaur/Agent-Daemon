// P5.7: the pure line diff that `ad review` shows before a skill change is applied.

import { test } from "node:test";
import assert from "node:assert/strict";
import { diffLines, unifiedDiff } from "../src/text-diff.mjs";

const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n") + "\n";

test("identical input → no hunks, an empty diff", () => {
  const t = lines(20);
  assert.equal(unifiedDiff(t, t), "");
  assert.ok(diffLines(t, t).every((d) => d.op === " "));
});

test("one changed line → one hunk with 3 context lines each side", () => {
  const a = lines(20);
  const b = a.replace("line 10\n", "line ten\n");
  const out = unifiedDiff(a, b, { from: "current", to: "proposed" });
  const body = out.split("\n");
  assert.equal(body[0], "--- current");
  assert.equal(body[1], "+++ proposed");
  assert.equal(body.filter((l) => l.startsWith("@@")).length, 1);
  assert.equal(body[2], "@@ -7,7 +7,7 @@");
  assert.deepEqual(body.slice(3, 11), [" line 7", " line 8", " line 9", "-line 10", "+line ten", " line 11", " line 12", " line 13"]);
});

test("changes far apart → separate hunks; close together → one", () => {
  const a = lines(40);
  const far = a.replace("line 5\n", "five\n").replace("line 30\n", "thirty\n");
  assert.equal(unifiedDiff(a, far).split("\n").filter((l) => l.startsWith("@@")).length, 2);
  const near = a.replace("line 5\n", "five\n").replace("line 9\n", "nine\n");
  assert.equal(unifiedDiff(a, near).split("\n").filter((l) => l.startsWith("@@")).length, 1);
});

test("CRLF against LF → no spurious hunk; a BOM is not a change", () => {
  const lf = lines(10);
  assert.equal(unifiedDiff(lf, lf.replace(/\n/g, "\r\n")), "");
  assert.equal(unifiedDiff(lf, "\u{FEFF}" + lf), "");
});

test("added and removed files, and a missing final newline", () => {
  assert.match(unifiedDiff("", "a\nb\n"), /@@ -0,0 \+1,2 @@\n\+a\n\+b/);
  assert.match(unifiedDiff("a\nb\n", ""), /@@ -1,2 \+0,0 @@\n-a\n-b/);
  assert.match(unifiedDiff("a\nb", "a\nb\n"), /\\ No newline at end of file/);
});

test("insertions and deletions in the middle keep the rest aligned", () => {
  const a = "a\nb\nc\nd\ne\n";
  const b = "a\nb\nX\nc\nd\ne\n";
  assert.deepEqual(diffLines(a, b).filter((d) => d.op !== " "), [{ op: "+", line: "X" }]);
  assert.deepEqual(diffLines(b, a).filter((d) => d.op !== " "), [{ op: "-", line: "X" }]);
});

test("property: the ops rebuild both texts exactly (random inputs)", () => {
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  const text = () => Array.from({ length: rnd(12) }, () => "abcde"[rnd(5)]).join("\n") + (rnd(2) ? "\n" : "");
  for (let i = 0; i < 500; i++) {
    const a = text();
    const b = text();
    const ops = diffLines(a, b);
    const rebuild = (keep) => {
      const kept = ops.filter((o) => keep.includes(o.op));
      return kept.map((o, j) => o.line + (j === kept.length - 1 && o.noEol ? "" : "\n")).join("");
    };
    assert.equal(rebuild([" ", "-"]), a, JSON.stringify({ a, b }));
    assert.equal(rebuild([" ", "+"]), b, JSON.stringify({ a, b }));
  }
});

test("colour only when asked", () => {
  const a = lines(5);
  const b = a.replace("line 3", "three");
  assert.doesNotMatch(unifiedDiff(a, b), new RegExp(String.fromCharCode(27)));
  assert.match(unifiedDiff(a, b, { color: true }), new RegExp(`${String.fromCharCode(27)}\\[31m-line 3`));
});

test("2,000 lines with scattered changes in under 200 ms", () => {
  const a = lines(2000);
  const b = lines(2000, (i) => (i % 50 === 0 ? `changed ${i}` : `line ${i}`));
  const t0 = performance.now();
  const out = unifiedDiff(a, b);
  const ms = performance.now() - t0;
  assert.equal(out.split("\n").filter((l) => l.startsWith("+changed")).length, 40);
  assert.ok(ms < 200, `${ms.toFixed(0)} ms`);
  // Entirely different texts stay bounded too.
  const c = lines(2000, (i) => `other ${i}`);
  const t1 = performance.now();
  unifiedDiff(a, c);
  assert.ok(performance.now() - t1 < 1000);
});
