// Chat Completions streaming → StreamEvents (P6.1). One `data:` payload at a time; the
// SSE framing is sse.mjs's.
//
//   chatEvents(data) → StreamEvent[]   data: one event's data ("[DONE]" → [{t:"done"}])
// Tool-call fragments are passed on by index as they come; responses-out.mjs joins them.

export function chatEvents(data) {
  if (data === "[DONE]") return [{ t: "done" }];
  if (!data.trim()) return []; // an empty data line (a keep-alive) carries nothing
  let j;
  try {
    j = JSON.parse(data);
  } catch {
    return [{ t: "error", error: { message: "the provider sent a malformed event" } }];
  }
  if (j?.error) return [{ t: "error", error: j.error }];
  // MiniMax answers some failures with HTTP 200 and base_resp { status_code, status_msg }.
  if (j?.base_resp && Number(j.base_resp.status_code) !== 0) return [{ t: "error", error: { code: String(j.base_resp.status_code), message: String(j.base_resp.status_msg ?? "") } }];
  const out = [];
  for (const c of j?.choices ?? []) {
    if ((c.index ?? 0) !== 0) continue; // n = 1 only
    const d = c.delta ?? c.message ?? {};
    const reasoning = d.reasoning_content ?? d.reasoning ?? null;
    if (typeof reasoning === "string" && reasoning) out.push({ t: "reasoning", delta: reasoning });
    if (typeof d.content === "string" && d.content) out.push({ t: "text", delta: d.content });
    for (const tc of d.tool_calls ?? []) {
      out.push({ t: "tool", index: Number.isInteger(tc.index) ? tc.index : null, ...(tc.id ? { id: tc.id } : {}), ...(tc.function?.name ? { name: tc.function.name } : {}), ...(typeof tc.function?.arguments === "string" ? { args: tc.function.arguments } : {}), ...(tc.extra_content ? { extra: tc.extra_content } : {}) });
    }
    if (c.finish_reason) out.push({ t: "finish", reason: c.finish_reason });
  }
  if (j?.usage) out.push({ t: "usage", usage: j.usage });
  return out;
}
