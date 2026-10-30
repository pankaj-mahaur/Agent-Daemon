// The EngineManager (P3.4): which engine process serves which account, per ad process.
//
//   createEngineManager({ factory, homeFor, envFor, argsFor, idleMs, onEvent }) → {
//     acquire(engineId, { cwd, pin, purpose }) → { engine, engineId, release(), busy(on) },
//     list(), stale(engineId), restartIfStale(engineId), restart(engineId), closeAll() }
//
// - One engine per id ("api", or an account id for a ChatGPT home), started on the first
//   acquire (in that acquire's cwd, kept for restarts); later acquires share it
//   (in-process leases).
// - An engine no lease holds stops after idleMs, unless an acquire pinned it (pin: the
//   engine then stays until closeAll, as the window's own engine does). An acquire or a
//   restart that arrives while that stop runs waits for the exit, then starts a new one:
//   never two engines on one id.
// - stale: the engine's start arguments (its gateway entries) differ from what argsFor
//   gives now. restartIfStale restarts only when no lease is busy (a turn runs).
// - homeFor, envFor and argsFor are injected, so engine/ imports nothing from auth/ or
//   gateway/; factory({ engineId, home, env, args, cwd }) → a started engine.
// A lease's `engine` follows restarts: it is the id's current engine.

const sameArgs = (a, b) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
const closedError = () => Object.assign(new Error("ad: the engine manager is closed"), { code: "MANAGER_CLOSED" });

export function createEngineManager({ factory, homeFor = () => null, envFor = () => ({}), argsFor = () => [], idleMs = 5 * 60_000, onEvent = () => {}, now = () => Date.now() } = {}) {
  const entries = new Map(); // engineId → entry
  let closed = false;

  const emit = (ev) => {
    try {
      onEvent(ev);
    } catch {
      // an observer's failure is its own
    }
  };

  async function spawn(entry) {
    const home = await homeFor(entry.id);
    const args = await argsFor(entry.id);
    const env = await envFor(entry.id);
    const engine = await factory({ engineId: entry.id, home, env, args, cwd: entry.cwd });
    if (closed) {
      // closeAll ran while this one started: it must not outlive the manager.
      await engine.close?.();
      throw closedError();
    }
    entry.engine = engine;
    entry.home = home;
    entry.args = args;
    entry.startedAt = now();
    // An engine that exits on its own leaves the table (leases keep the record, and
    // their next restart() starts a new one); the next acquire starts a new one.
    engine.once?.("exit", () => {
      if (entry.engine !== engine || entry.stopping || entry.starting) return;
      entry.engine = null;
      clearIdle(entry);
      if (!entry.leases.size) entries.delete(entry.id);
      emit({ type: "exited", engineId: entry.id });
    });
    emit({ type: "started", engineId: entry.id, home });
    return engine;
  }

  function clearIdle(entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  function armIdle(entry) {
    clearIdle(entry);
    if (entry.leases.size || entry.pinned || closed || !entry.engine) return;
    // idleMs 0 (one-shot commands): stop now, and let the caller wait for it.
    if (idleMs <= 0) return stop(entry, "idle");
    entry.idleTimer = setTimeout(() => stop(entry, "idle"), idleMs);
    entry.idleTimer.unref?.();
  }

  function stop(entry, why) {
    clearIdle(entry);
    if (entry.stopping) return entry.stopping;
    const engine = entry.engine;
    entry.stopping = (async () => {
      try {
        await engine?.close?.();
      } finally {
        entry.engine = null;
        entry.stopping = null;
        if (entries.get(entry.id) === entry && !entry.leases.size) entries.delete(entry.id);
        emit({ type: "stopped", engineId: entry.id, why });
      }
    })();
    return entry.stopping;
  }

  // Run a start (a spawn, or a restart's close-then-spawn) as the entry's only one.
  async function starting(entry, work) {
    entry.starting = work();
    try {
      return await entry.starting;
    } catch (err) {
      if (!entry.leases.size && entries.get(entry.id) === entry) entries.delete(entry.id);
      throw err;
    } finally {
      entry.starting = null;
    }
  }

  async function ready(id, cwd) {
    for (;;) {
      if (closed) throw closedError();
      let entry = entries.get(id);
      if (entry?.stopping) {
        await entry.stopping.catch(() => {});
        continue;
      }
      if (entry?.starting) {
        await entry.starting.catch(() => {});
        continue; // look again: it may have failed, or been closed
      }
      if (entry?.engine) return entry;
      entry ??= { id, cwd, engine: null, home: null, args: null, startedAt: null, leases: new Set(), pinned: false, busy: 0, idleTimer: null, starting: null, stopping: null };
      entries.set(id, entry);
      await starting(entry, () => spawn(entry));
      return entry;
    }
  }

  async function acquire(engineId, { cwd, pin = false, purpose = null } = {}) {
    const entry = await ready(engineId, cwd);
    clearIdle(entry);
    const lease = { purpose, busy: false, released: false };
    entry.leases.add(lease);
    if (pin) entry.pinned = true;
    return {
      engineId,
      purpose,
      get engine() {
        return entry.engine;
      },
      busy(on) {
        if (lease.released || Boolean(on) === lease.busy) return;
        lease.busy = Boolean(on);
        entry.busy += on ? 1 : -1;
      },
      /** → the stop's promise when this release stops the engine (idleMs 0), else undefined. */
      release() {
        if (lease.released) return;
        lease.released = true;
        if (lease.busy) entry.busy--;
        entry.leases.delete(lease);
        return armIdle(entry);
      },
    };
  }

  async function restart(engineId) {
    for (;;) {
      if (closed) throw closedError();
      const entry = entries.get(engineId);
      if (!entry) throw Object.assign(new Error(`ad: no engine ${engineId} to restart`), { code: "ENGINE_UNKNOWN" });
      if (entry.stopping || entry.starting) {
        await (entry.stopping ?? entry.starting).catch(() => {});
        continue; // an idle stop may have removed it; a start may have failed
      }
      clearIdle(entry);
      const old = entry.engine;
      try {
        const engine = await starting(entry, async () => {
          entry.engine = null;
          await old?.close?.();
          return spawn(entry);
        });
        emit({ type: "restarted", engineId });
        return engine;
      } finally {
        armIdle(entry);
      }
    }
  }

  async function stale(engineId) {
    const entry = entries.get(engineId);
    if (!entry?.engine) return false;
    return !sameArgs(entry.args, await argsFor(engineId));
  }

  return {
    acquire,
    restart,
    stale,
    async restartIfStale(engineId) {
      const entry = entries.get(engineId);
      if (!entry?.engine || entry.starting || entry.stopping) return false;
      if (!(await stale(engineId))) return false;
      // Checked again after argsFor, which may wait: a turn may have started, or a stop.
      if (entry.busy > 0) return false;
      if (entries.get(engineId) !== entry || !entry.engine || entry.starting || entry.stopping) return false;
      await restart(engineId);
      return true;
    },
    list() {
      return [...entries.values()].filter((e) => e.engine || e.starting).map((e) => ({ engineId: e.id, home: e.home, leases: e.leases.size, busy: e.busy > 0, startedAt: e.startedAt }));
    },
    async closeAll() {
      closed = true;
      await Promise.all(
        [...entries.values()].map(async (e) => {
          if (e.starting) await e.starting.catch(() => {});
          return stop(e, "close");
        }),
      );
      entries.clear();
    },
  };
}
