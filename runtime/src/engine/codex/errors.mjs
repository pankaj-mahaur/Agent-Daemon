/**
 * An error ad recognises by its code. The message is ad's words and never
 * names the engine; the façade turns codes into what the user reads.
 * Codes: ENGINE_NOT_INSTALLED, ENGINE_SPAWN_FAILED, ENGINE_EXITED,
 * ENGINE_NOT_STARTED, ENGINE_TIMEOUT, HOME_* (the engine's folder),
 * SANDBOX_NOT_STARTED, or the engine's numeric JSON-RPC code.
 */
export function engineError(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  return err;
}
