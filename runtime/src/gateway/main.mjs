// The gateway child process (P3.3): its own process (and, on POSIX, its own process
// group), so Ctrl+Z on ad's terminal never stalls an API turn. The table and the keys
// arrive over IPC from ad (client.mjs), never in this process's env or argv; events go
// back the same way. It ends when ad's pipe or IPC channel closes, or on "close".
// Windows: not detached, so it ignores SIGINT/SIGBREAK (a Ctrl+C meant for ad).

import { createGatewayServer } from "./server.mjs";
import { registerSecret } from "../auth/redact.mjs";

for (const sig of ["SIGINT", "SIGBREAK"]) process.on(sig, () => {});
let gw = null;
const quit = async () => {
  try {
    await gw?.close();
  } finally {
    process.exit(0);
  }
};
process.on("disconnect", quit);
process.stdin.on("end", quit);
process.stdin.on("error", quit);
process.stdin.resume();

process.on("message", async (m) => {
  if (m?.type === "init" && !gw) {
    registerSecret(m.token, "gateway token");
    for (const k of Object.values(m.keys ?? {})) registerSecret(k, "key");
    gw = createGatewayServer({ token: m.token, table: new Map(m.table), keys: m.keys, onUpstream: (event) => process.connected && process.send({ type: "upstream", event }), ...(m.opts ?? {}) });
    const port = await gw.listen();
    process.send({ type: "ready", port });
  } else if (m?.type === "table" && gw) {
    for (const k of Object.values(m.keys ?? {})) registerSecret(k, "key");
    gw.setTable(new Map(m.table), m.keys);
    process.send({ type: "table-set", n: m.table.length });
  } else if (m?.type === "close") await quit();
});
