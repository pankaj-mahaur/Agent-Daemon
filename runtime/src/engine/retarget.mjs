// A thread asked to move to another provider or model (P3.4, S-THREADCFG Q5): the engine
// answers success even when it kept the old ones (a loaded, subscribed or running thread
// on resume), so the façade checks the answer of every resume and fork that names a
// provider or model (resumeThread, threads.fork).

// The façade's engineError (a re-export; the cycle with index.mjs is safe: used at call time).
import { engineError } from "./index.mjs";

export const RETARGET_IGNORED_TEXT = (old) => `The engine kept this conversation on ${old}. Start a new conversation, or switch with /model.`;
export const RETARGET_BUSY_TEXT = "This conversation is still busy (a turn or a background terminal runs). Wait for it to finish, then switch.";

/** A resume or fork answer that didn't take the requested provider or model → RETARGET_IGNORED. */
export function assertRetargeted(r, want) {
  const providerOk = want.modelProvider === undefined || r?.modelProvider === want.modelProvider;
  const modelOk = want.model === undefined || r?.model === want.model;
  if (providerOk && modelOk) return;
  throw engineError("RETARGET_IGNORED", RETARGET_IGNORED_TEXT(r?.modelProvider ?? "its account"), {
    kept: { modelProvider: r?.modelProvider ?? null, model: r?.model ?? null },
    wanted: { modelProvider: want.modelProvider ?? null, model: want.model ?? null },
  });
}
