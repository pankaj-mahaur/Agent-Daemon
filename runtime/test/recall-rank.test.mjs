// L6 P1 (design decisions 2, 4, 5): the recall core's ranking, pure.
//   - terms: identifiers and paths split (camelCase, snake_case, kebab, folders, file
//     stems), light stemming, English and Hinglish stop words out;
//   - the repo-context query: the branch's words weigh most (its type prefix dropped),
//     path words by how many recent paths share them, commit words least;
//   - BM25 over the project's own notes; a newer note on the same subject that says
//     things changed supersedes an older one;
//   - the brief and the prompt keep only notes above their thresholds.

import { test } from "node:test";
import assert from "node:assert/strict";

const K = await import("../src/memory/recall-rank.mjs");

test("terms split identifiers and paths and stem lightly", () => {
  assert.deepEqual(K.terms("src/billing/InvoiceRounding.ts"), ["src", "bill", "invoic", "round", "ts"]);
  assert.deepEqual(K.terms("run pnpm test:e2e --project=chromium"), ["run", "pnpm", "test", "e2e", "project", "chromium"]);
  assert.deepEqual(K.terms("retries retried retry"), ["retry", "retry", "retry"]);
  assert.deepEqual(K.terms("migrations migrated migrate"), ["migrat", "migrat", "migrat"]);
  assert.deepEqual(K.terms("snake_case_name kebab-case-name"), ["snak", "case", "name", "kebab", "case", "name"]);
  assert.deepEqual(K.terms("snakes"), K.terms("snake"), "one stem for both forms");
  // a word with digits is kept whole and split
  assert.deepEqual(K.terms("postgres16"), ["postgres16", "postgr", "16"]);
});

test("stop words are dropped, English and Hinglish", () => {
  assert.deepEqual(K.terms("how do I run the tests for this?"), ["run", "test"]);
  assert.deepEqual(K.terms("test kaise chalate hain is service ke"), ["test", "chalat", "servic"]);
});

test("the context query weighs the branch most and drops its type prefix", () => {
  const q = K.contextQuery({ branch: "feat/kafka-consumer-retries", paths: ["internal/consumer/retry.go", "internal/consumer/dlq.go"], commits: ["add retry backoff to consumer"] });
  assert.equal(q.has("feat"), false);
  assert.equal(q.has("internal"), false, "path noise");
  assert.ok(q.get("kafka") >= 3);
  assert.ok(q.get("consumer") > q.get("dlq"), "a word in two paths and the branch outweighs one in one path");
  assert.ok(q.get("backoff") < q.get("dlq"), "commit words weigh least");
});

const NOW = Date.parse("2026-11-08T12:00:00Z");
const ago = (d) => new Date(NOW - d * 86_400_000).toISOString();
const n = (id, text, o = {}) => ({ id, text, created: ago(o.days ?? 100), status: "active", ...o });
const CTX = { branch: "feat/checkout-refunds", paths: ["src/refunds/bulk_issuer.rb", "app/jobs/bulk_refund_job.rb"], commits: ["queue bulk refunds"] };

test("every session: the newest provisional and recent own corrections, five at most", () => {
  const notes = [
    n(6, "use pnpm, not npm", { standing: true, days: 1 }),
    n(7, "tabs in go files", { standing: true, days: 2, status: "provisional" }),
    n(8, "third recent one", { standing: true, days: 3 }),
    n(11, "fourth recent one", { standing: true, days: 4 }),
    n(12, "fifth recent one", { standing: true, days: 5 }),
    n(13, "sixth recent one", { standing: true, days: 6 }),
    n(10, "not sent every session", { days: 1, repeats: 40 }),
  ];
  const b = K.selectBrief(notes, CTX, { now: NOW });
  assert.deepEqual(b.standing.map((r) => r.note.id), [6, 7, 8, 11, 12]);
});

test("supersession: by the creation date, never the accept date; no negation cue on the older note", () => {
  const filler = ["Admin dashboards use Chartkick with a 5 minute cache", "Lint with standardrb before pushing", "Search uses pg_search on products", "Emails go through Postmark templates", "Feature flags live in Flipper", "Product images are resized by ImageProcessing"].map((t, i) => n(20 + i, t));
  const current = n(1, "Bulk refunds go through Refunds::BulkIssuer in BulkRefundJob; the refunds controller only enqueues", { days: 5 });
  // an old note accepted today (a history import): new by acceptance only
  const imported = n(2, "Refunds go through the refunds controller synchronously; BulkRefundJob is not used for refunds", { days: 0, written: ago(700) });
  let b = K.selectBrief([...filler, current, imported], CTX, { now: NOW });
  assert.ok(!b.superseded.has(1), "an import accepted today doesn't replace a newer note");
  assert.ok(b.superseded.has(2), "the note written later replaces it");
  // only the change-cue path (plain overlap bar out of reach): a negation in the older
  // note never makes a replacement; a change cue in the newer one does
  const cueOnly = { ...K.SUPERSEDE, overlap: 2, overlapWithCue: 0 };
  const neg = n(3, "Never refund from the admin console; refunds need a ticket", { days: 400 });
  const plain = n(4, "Refund tickets are triaged by the payments team", { days: 5 });
  const cued = n(5, "Refund tickets are now triaged by the payments team instead", { days: 5 });
  const ids = new Set([3, 4, 5]);
  assert.ok(!K.supersededNotes(K.indexNotes([...filler, neg, plain]), { only: ids, by: ids, opts: cueOnly }).has(3));
  assert.ok(K.supersededNotes(K.indexNotes([...filler, neg, cued]), { only: ids, by: ids, opts: cueOnly }).has(3));
});

test("a note in the user's own words gives way only to their own newer words or a near-duplicate", () => {
  const filler = ["Admin dashboards use Chartkick with a 5 minute cache", "Lint with standardrb before pushing", "Search uses pg_search on products", "Emails go through Postmark templates", "Feature flags live in Flipper", "Product images are resized by ImageProcessing"].map((t, i) => n(20 + i, t));
  const own = n(2, "Refunds are issued synchronously in the refunds controller; no background job for refunds", { days: 600, own: true });
  const agentNewer = n(1, "Bulk refunds now go through Refunds::BulkIssuer in BulkRefundJob instead; the refunds controller only enqueues", { days: 5 });
  assert.ok(!K.selectBrief([...filler, own, agentNewer], CTX, { now: NOW }).superseded.has(2));
  assert.ok(K.selectBrief([...filler, own, { ...agentNewer, own: true }], CTX, { now: NOW }).superseded.has(2));
});

test("a note is dropped only where its replacement is shown", () => {
  const filler = ["Admin dashboards use Chartkick with a 5 minute cache", "Lint with standardrb before pushing", "Search uses pg_search on products", "Emails go through Postmark templates", "Feature flags live in Flipper", "Product images are resized by ImageProcessing"].map((t, i) => n(20 + i, t));
  const old = n(2, "Refunds are issued synchronously in the refunds controller; no background job for refunds", { days: 600 });
  const newer = n(1, "Bulk refunds now go through Refunds::BulkIssuer in BulkRefundJob instead; the refunds controller only enqueues", { days: 5 });
  const ix = K.indexNotes([...filler, old, newer]);
  assert.ok(!K.supersededNotes(ix, { only: new Set([2]), by: new Set([2]) }).has(2), "replacement not shown: kept");
  assert.ok(K.supersededNotes(ix, { only: new Set([2]), by: new Set([1, 2]) }).has(2));
});

test("the work tier: notes that match the context, superseded ones out", () => {
  const notes = [
    n(1, "Bulk refunds go through Refunds::BulkIssuer in BulkRefundJob; the controller only enqueues", { days: 5 }),
    n(2, "Refunds are issued synchronously in the refunds controller; no background job for refunds", { days: 600 }),
    n(3, "Admin dashboards use Chartkick with a 5 minute cache", { days: 50 }),
  ];
  const b = K.selectBrief(notes, CTX, { now: NOW });
  const work = b.work.map((r) => r.note.id);
  assert.ok(work.includes(1));
  assert.ok(!work.includes(2), "the newer note on the same subject replaces it");
  assert.ok(!work.includes(3), "another area");
  assert.equal(b.superseded.get(2)?.by, 1);
});

test("a note of lower standing never replaces an accepted one", () => {
  const filler = ["Admin dashboards use Chartkick with a 5 minute cache", "Lint with standardrb before pushing", "Search uses pg_search on products", "Emails go through Postmark templates", "Feature flags live in Flipper", "Product images are resized by ImageProcessing"].map((t, i) => n(20 + i, t));
  const old = n(2, "Refunds are issued synchronously in the refunds controller; no background job for refunds", { days: 600 });
  const newerText = "Bulk refunds now go through Refunds::BulkIssuer in BulkRefundJob instead; the refunds controller only enqueues";
  // control: alone, the old note is shown
  assert.ok(K.selectBrief([...filler, old], CTX, { now: NOW }).work.some((r) => r.note.id === 2), "control: the old note is a candidate");
  assert.ok(K.selectBrief([...filler, old, n(1, newerText, { days: 5 })], CTX, { now: NOW }).superseded.has(2), "an accepted newer note replaces it");
  for (const status of ["provisional", "pending", "forget-requested", "quarantined"]) {
    const b = K.selectBrief([...filler, old, n(1, newerText, { days: 5, status })], CTX, { now: NOW });
    assert.ok(!b.superseded.has(2), status);
    assert.ok(b.work.some((r) => r.note.id === 2), `${status}: the accepted note is still shown`);
  }
  // a provisional note may replace an older provisional one
  const oldProv = { ...old, status: "provisional" };
  assert.ok(K.selectBrief([...filler, oldProv, n(1, newerText, { days: 5, status: "provisional" })], CTX, { now: NOW }).superseded.has(2));
});

test("no context: the freshest notes, marked as the fallback (never by repeats)", () => {
  const notes = [n(1, "a", { days: 300 }), n(2, "b", { days: 3 }), n(3, "c", { days: 30, repeats: 40 }), n(4, "d", { days: 1 }), n(5, "e"), n(6, "f"), n(7, "g")];
  const b = K.selectBrief(notes, {}, { now: NOW });
  assert.equal(b.fallback, true);
  assert.deepEqual(b.work.map((r) => r.note.id).slice(0, 3), [4, 2, 3]);
  assert.equal(b.work.length, K.BRIEF.fallback);
});

test("prompt recall: above the threshold only, three at most, a shared word alone isn't enough", () => {
  const notes = [
    n(1, "Unit tests: uv run pytest -q tests/unit; integration tests need docker compose up -d postgres"),
    n(2, "Partner API allows 10 requests per second; retries must back off"),
    n(3, "Upload size limit is 25 MB at the nginx ingress"),
  ];
  assert.deepEqual(K.selectPrompt(notes, "how do i run the unit tests").map((r) => r.note.id), [1]);
  assert.deepEqual(K.selectPrompt(notes, "what's the capital of france"), []);
  assert.deepEqual(K.selectPrompt(notes, "the second test of the day"), [], "one common word");
  assert.ok(K.selectPrompt(notes, "x ".repeat(5000)).length === 0);
});

test("the prompt query keeps the user's own words first and caps at 64 terms", () => {
  const q = K.promptQuery("fix the flaky checkout test\n```\n" + Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ") + "\n```", { own: "fix the flaky checkout test" });
  assert.ok(q.size <= K.MAX_QUERY_TERMS);
  assert.equal(q.get("checkout"), 1);
  assert.equal(q.get("word0"), 0.5, "pasted words count half");
});
