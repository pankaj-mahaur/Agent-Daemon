// Shared stdin/stdout helpers for hook handlers.
// Claude Code hooks receive a JSON object on stdin describing the tool call
// and emit a JSON decision on stdout (or a non-zero exit to block).
//
// Decision shape:
//   { decision: "approve" }                 — explicit allow
//   { decision: "block",  reason: "..." }   — block with a message shown to the model
//   {}                                       — pass-through (default allow)

const MAX_STDIN = 1024 * 1024; // 1 MB safety cap

export async function readStdinJson() {
  return new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      if (raw.length < MAX_STDIN) raw += chunk.slice(0, MAX_STDIN - raw.length);
    });
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        resolve({});
      }
    });
    process.stdin.on("error", () => resolve({}));
  });
}

export function approve() {
  process.stdout.write(JSON.stringify({ decision: "approve" }));
}

export function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}

export function passthrough() {
  process.stdout.write("{}");
}

export function warn(message) {
  process.stderr.write(`[agent-daemon] ${message}\n`);
}

/** Inject text into Claude's context without blocking or approving the prompt. */
export function advise(additionalContext) {
  process.stdout.write(JSON.stringify({ additionalContext }));
}
