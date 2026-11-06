// Tests that mean a note to be in use accept it the way `ad review` does: through the
// review service, with a token from a stand-in terminal (memory/review-service.mjs).
// Every writer stores a new note as pending (MCP launch plan D3), so a seed is
// unaccepted until a test accepts it here.

import { acceptFact, acceptLearning, checkReviewToken } from "../src/memory/review-service.mjs";
import { pendingSql } from "../src/memory/trust.mjs";

/** The ancestry probe's answer in the user's own terminal, for tests that stand in for one. */
export const TERMINAL = () => ({ verdict: "terminal", root: "test" });

/** A review token as the user's own terminal gets one. */
export function testReviewToken() {
  const { token } = checkReviewToken({ env: {}, isTTY: () => true, ancestry: TERMINAL });
  return token;
}

const runner = (handle) => (handle.run ? handle : { run: (sql, params = []) => handle.prepare(sql).run(...params), all: (sql, params = []) => handle.prepare(sql).all(...params) });

/** Accept learnings by id; a null id (a re-observation inserts nothing) is skipped. */
export function acceptLearnings(handle, ids, opts) {
  const token = testReviewToken();
  for (const id of [ids].flat()) if (id !== null && id !== undefined) acceptLearning(runner(handle), token, Number(id), opts);
}

/** Accept user facts by id. */
export function acceptFacts(handle, ids) {
  const token = testReviewToken();
  for (const id of [ids].flat()) if (id !== null && id !== undefined) acceptFact(runner(handle), token, Number(id));
}

/** Accept every pending learning and fact: a seeded store the user reviewed in full. */
export function acceptAllPending(handle) {
  const h = runner(handle);
  acceptLearnings(h, h.all(`SELECT id FROM learnings WHERE ${pendingSql()}`).map((r) => r.id), { appliedTo: null });
  acceptFacts(h, h.all(`SELECT id FROM user_facts WHERE ${pendingSql()}`).map((r) => r.id));
}
