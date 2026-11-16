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

// Recall quality (L6 follow-up, 15 Nov; tuned on the dev set's v1 and v2 only).

test("a path in the prompt counts at half weight, and its folder noise not at all", () => {
  const prompt = "rename the iban field in common/src/main/java/com/acme/dto/StatementLine.java";
  const q = K.promptQuery(prompt, { own: prompt });
  assert.equal(q.get("iban"), 1, "the user's own words");
  assert.equal(q.get(K.stem("statement")), 0.5, "a word of the path counts half");
  assert.equal(q.get("dto"), 0.5);
  assert.equal(q.has("src"), false, "folder noise");
  assert.equal(q.has("main"), false, "folder noise");
  // a URL is not a path; a slash between plain words isn't either when nothing else is there
  const u = "see https://example.com/docs/setup for the setup steps";
  assert.equal(K.promptQuery(u, { own: u }).get("setup"), 2);
  assert.equal(K.promptQuery("client/server setup").get("client"), 1, "one slash between words: text");
  assert.equal(K.promptQuery("open ./deploy.sh").get("deploy"), 0.5, "one slash at the start: a path");
  // a long paste stays linear (one token, no spaces)
  const t0 = Date.now();
  K.promptQuery("fix " + "a/".repeat(40_000), { own: "fix " + "a/".repeat(40_000) });
  K.promptQuery("fix " + ".x".repeat(40_000));
  assert.ok(Date.now() - t0 < 1000, "linear in the prompt's length");
  // pasted parts still count half, their folder noise out as well
  const pasted = K.promptQuery("why does this fail\n```\nError in src/billing/invoice.ts\n```", { own: "why does this fail" });
  assert.equal(pasted.get("fail"), 1);
  assert.equal(pasted.get("invoic"), 0.5);
  assert.equal(pasted.has("src"), false);
  // a stack-trace location and smart quotes still read as a path; a date doesn't
  assert.equal(K.promptQuery("at src/billing/invoice.ts:10:5").has("src"), false);
  assert.equal(K.promptQuery("open \u201csrc/billing/invoice.ts\u201d").get("invoic"), 0.5);
  assert.equal(K.promptQuery("since 12/05/2026").get("2026"), 1);
});

test("a note that matches three or more of the prompt's words counts its note coverage twice", () => {
  const row = (matched) => ({ matched, covQ: 0.5, covD: 0.2 });
  assert.equal(K.promptScore(row(2)), 0.5 * Math.sqrt(0.2));
  assert.equal(K.promptScore(row(3)), 0.5 * Math.sqrt(0.4));
  assert.equal(K.promptScore({ matched: 4, covQ: 1, covD: 0.9 }), 1, "never above 1");
  // end to end: a long note that three of the prompt's words reach clears the threshold
  const notes = [
    n(1, "PspClient is a typed HttpClient with Polly: 3 retries with jitter on 5xx and timeouts, a circuit breaker after 5 failures, and refunds are excluded from retries because the PSP double-refunds on a replayed request; use the idempotency key header instead"),
    n(2, "Merchant settlements run nightly at 01:00 UTC through the SettlementJob in Worker"),
    n(3, "Money is decimal(19,4) everywhere; HasPrecision(19, 4) on every new property"),
    n(4, "Local secrets go in dotnet user-secrets on the Api project"),
    n(5, "CI runs dotnet format --verify-no-changes before the tests"),
  ];
  assert.deepEqual(K.selectPrompt(notes, "refund calls to the PSP time out now and then, should I add a Polly retry?").map((r) => r.note.id), [1]);
});

const QUIET = ["Admin dashboards use Chartkick with a 5 minute cache", "Lint with standardrb before pushing", "Search uses pg_search on products", "Emails go through Postmark templates", "Feature flags live in Flipper", "Product images are resized by ImageProcessing"];

test("a shown note whose newer replacement wasn't selected gives its slot to the replacement", () => {
  const filler = QUIET.map((t, i) => n(20 + i, t));
  const ctx = { branch: "feat/bulk-refunds", paths: ["app/jobs/bulk_refund_job.rb", "app/services/refunds/bulk_issuer.rb"], commits: ["bulk refunds: queue one job per batch"] };
  // the old note matches the work strongly; its replacement (same subject, 600 days
  // later) barely matches the context, so the ranking alone wouldn't select it
  const old = n(2, "Bulk refunds: BulkRefundJob calls the BulkIssuer for each refund in the batch, synchronously, one refund at a time", { days: 700 });
  const newer = n(1, "Each refund is now issued by its own RefundWorker with retries; nothing calls refunds synchronously anymore", { days: 100 });
  const without = K.selectBrief([...filler, old, newer], ctx, { now: NOW, opts: { ...K.BRIEF, swap: false } });
  assert.ok(without.work.some((r) => r.note.id === 2) && !without.work.some((r) => r.note.id === 1), "control: the ranking selects the old note only");
  const b = K.selectBrief([...filler, old, newer], ctx, { now: NOW });
  assert.deepEqual(b.work.map((r) => r.note.id).filter((id) => id < 20), [1], "the replacement takes the slot");
  assert.equal(b.superseded.get(2)?.by, 1);
  // the rules of who may replace whom still hold
  for (const status of ["provisional", "pending", "forget-requested"]) {
    const s = K.selectBrief([...filler, old, { ...newer, status }], ctx, { now: NOW });
    assert.ok(s.work.some((r) => r.note.id === 2), `${status}: the accepted note stays`);
    assert.ok(!s.work.some((r) => r.note.id === 1), `${status}: and isn't swapped out`);
  }
  const own = K.selectBrief([...filler, { ...old, own: true }, newer], ctx, { now: NOW });
  assert.ok(own.work.some((r) => r.note.id === 2), "the user's own words give way only to their own newer words");
  // a replacement already shown elsewhere isn't shown twice
  const both = K.selectBrief([...filler, old, { ...newer, text: newer.text + " (bulk refund job)" }], ctx, { now: NOW });
  assert.equal(both.work.filter((r) => r.note.id === 1).length, 1);
  assert.ok(!both.work.some((r) => r.note.id === 2));
});

test("a work note that shares no word with the branch or the commits needs half the top score", () => {
  const ctx = { branch: "feat/presence-typing", paths: ["assets/js/hooks/typing_hook.js", "lib/chat/presence.ex", "test/chat/presence_test.exs"], commits: ["track typing state in presence metas"] };
  const notes = [
    n(1, "Presence metas: update typing state with Presence.update, never track twice; typing_hook.js throttles pushes", { days: 30 }),
    n(2, "The typing indicator renders under the composer from presence metas", { days: 40 }),
    n(3, "Infinite scroll hook in assets/js/hooks loads 50 messages per page", { days: 60 }),
    n(4, "Run one file with mix test path:line; the chat suite seeds rooms in setup", { days: 1500 }),
    ...QUIET.map((t, i) => n(20 + i, t)),
  ];
  const ids = (b) => b.work.map((r) => r.note.id);
  const b = K.selectBrief(notes, ctx, { now: NOW });
  assert.ok(ids(b).includes(1) && ids(b).includes(2));
  assert.ok(!ids(b).includes(3), "only folder words in common: below half the top score");
  const loose = K.selectBrief(notes, ctx, { now: NOW, opts: { ...K.BRIEF, offTopic: K.BRIEF.relative } });
  assert.ok(ids(loose).includes(3), "control: at the plain bar it would be shown");
  // a branch whose words match nothing (a ticket number) and no commits: the plain bar
  const ticket = K.selectBrief(notes, { branch: "feat/ABC-1234", paths: ctx.paths, commits: [] }, { now: NOW });
  assert.ok(ids(ticket).includes(4), "the plain bar for every note (this one is under half the top score): the branch alone never thins the brief");
});

test("a commit's leading scope names an area: it doesn't put a note on the topic", () => {
  const notes = [
    n(1, "Presence metas: update typing state with Presence.update, never track twice", { days: 30 }),
    n(2, "The typing indicator renders under the composer from presence metas", { days: 40 }),
    n(3, "Chat infinite scroll in assets/js/hooks loads 50 messages per page", { days: 60 }),
    ...QUIET.map((t, i) => n(20 + i, t)),
  ];
  const paths = ["assets/js/hooks/typing_hook.js", "lib/live/presence.ex"];
  const ids = (commits) => K.selectBrief(notes, { branch: "feat/presence-typing", paths, commits }, { now: NOW }).work.map((r) => r.note.id);
  assert.ok(!ids(["chat: track typing state in presence metas", "fix(chat)!: typing presence"]).includes(3), "the scope 'chat' alone: off topic");
  assert.ok(ids(["track chat typing state in presence metas"]).includes(3), "control: 'chat' in the subject itself is on topic");
});

test("the swap: only a replacement that matches the work and says things changed; chains; never twice", () => {
  const filler = QUIET.map((t, i) => n(20 + i, t));
  const ctx = { branch: "feat/bulk-refunds", paths: ["app/jobs/bulk_refund_job.rb", "app/services/refunds/bulk_issuer.rb"], commits: ["bulk refunds: queue one job per batch"] };
  // one slot, so a replacement can only come in through the swap
  const work = (notes) => K.selectBrief([...filler, ...notes], ctx, { now: NOW, opts: { ...K.BRIEF, maxWork: 1 } }).work.map((r) => r.note.id);
  const old = n(2, "Bulk refunds: BulkRefundJob calls the BulkIssuer for each refund in the batch, synchronously, one refund at a time", { days: 700 });
  // same words, much newer, no change cue: not a replacement the ranking didn't pick
  const generic = n(1, "Each refund in a batch is logged, one line per refund, with the batch id", { days: 100 });
  assert.deepEqual(work([old, generic]), [2], "no change cue: the old note keeps its slot");
  assert.deepEqual(work([old, { ...generic, text: generic.text + "; refunds are now issued in batches instead" }]), [1], "control: with a change cue it takes the slot");
  // a newer note on the same subject that says things changed but shares no word with the work: no swap
  const offWork = n(7, "Batches are now handled asynchronously instead of synchronously, one time window per batch", { days: 100 });
  const ctxNoCommits = { ...ctx, commits: [] };
  const only = (notes) => K.selectBrief([...filler, ...notes], ctxNoCommits, { now: NOW, opts: { ...K.BRIEF, maxWork: 1 } }).work.map((r) => r.note.id);
  assert.deepEqual(only([old, offWork]), [2], "a replacement must match the work itself");
  assert.ok(K.supersededNotes(K.indexNotes([...filler, old, offWork]), { only: new Set([2]), by: new Set([2, 7]) }).has(2), "control: it would replace the old note if both were selected");
  // a long newer note that contains a short own-words note's words: no swap (the
  // near-duplicate rule is only for notes the ranking selected)
  const own = n(3, "Bulk refunds: never retry a refund batch", { days: 400, own: true });
  const checklist = n(4, "Release checklist: tag the release, never retry a failed deploy, check the refund batch dashboards for bulk anomalies, post in the channel, and now also update the status page", { days: 5 });
  assert.deepEqual(work([own, checklist]), [3], "the user's own correction stays");
  // a chain: each newer note says things changed; the newest takes the slot
  const b = n(5, "Bulk refunds now go through the RefundQueue consumer instead of calling the BulkIssuer synchronously", { days: 450 });
  const c = n(6, "Refunds from the RefundQueue are now issued by the RefundWorker instead of the consumer", { days: 100 });
  const chain = K.selectBrief([...filler, old, b, c], { ...ctx, commits: [] }, { now: NOW, opts: { ...K.BRIEF, maxWork: 1 } });
  assert.deepEqual(chain.work.map((r) => r.note.id), [6], "two replacements followed");
  assert.equal(chain.superseded.get(2)?.by, 5);
  assert.equal(chain.superseded.get(5)?.by, 6);
  // a replacement already sent every session isn't shown again in the work tier
  const standing = K.selectBrief([...filler, old, { ...c, standing: true }, b], { ...ctx, commits: [] }, { now: NOW, opts: { ...K.BRIEF, maxWork: 1 } });
  const shown = [...standing.standing, ...standing.work].map((r) => r.note.id);
  assert.equal(shown.filter((id) => id === 6).length, 1);
  assert.ok(!shown.includes(2), "the old note is still replaced");
});

test("a swapped-in note replaces other shown notes only by the swap's own rule", () => {
  const filler = QUIET.map((t, i) => n(20 + i, t));
  const ctx = { branch: "feat/bulk-refunds", paths: ["app/jobs/bulk_refund_job.rb", "app/services/refunds/bulk_issuer.rb"], commits: [] };
  const stale = n(1, "Bulk refunds: BulkRefundJob calls the BulkIssuer for each refund in the batch, synchronously, one refund at a time", { days: 700 });
  // long, newer, says things changed, and contains every word of the user's correction below
  const current = n(2, "Each refund is now issued by its own RefundWorker with retries; nothing calls refunds synchronously anymore; never retry a refund batch from the admin; Sidekiq queues: refunds, mailers, default; weights 5/2/1; dead jobs alert in Slack #payments; retry budget 25", { days: 10 });
  const own = n(3, "Never retry a refund batch from the admin", { days: 30, own: true });
  for (const extra of [{}, { standing: true }]) {
    const b = K.selectBrief([...filler, stale, current, { ...own, ...extra }], ctx, { now: NOW });
    const shown = [...b.standing, ...b.work].map((r) => r.note.id);
    assert.ok(shown.includes(3), `the user's own correction stays (${extra.standing ? "every session" : "work"})`);
    assert.ok(!shown.includes(1), "the stale note is still replaced");
  }
  // by the swap's rule it does replace: an every-session note written long before it on
  // the same subject (accepted recently, so it is sent every session)
  const oldStanding = n(4, "Refund batches are issued synchronously by BulkRefundJob, refunds one at a time", { days: 1, written: ago(500), standing: true, status: "provisional" });
  const b = K.selectBrief([...filler, stale, current, oldStanding], ctx, { now: NOW });
  const shown = [...b.standing, ...b.work].map((r) => r.note.id);
  assert.ok(shown.includes(2) && !shown.includes(4), "the swapped-in note replaces it");
  assert.equal(b.superseded.get(4)?.by, 2);
});
