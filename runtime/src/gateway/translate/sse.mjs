// Server-sent events, byte-safe (P6.1). The parser takes raw chunks (a multi-byte
// character or a line may be split anywhere), accepts CRLF, LF and CR line ends, joins
// multi-line `data:` fields, skips comments, and hands over a final event that ends at EOF
// without its blank line. The writer emits the one form the engine reads.
//
//   createSseParser({ onEvent, maxEventBytes }) → { push(chunk), end() }
//     onEvent({ event, data, id })   data: the joined data lines (a string)
//     push/end throw SSE_EVENT_TOO_LARGE past the cap (default 16 MiB)
//   sseEvent(obj)                  "event: <obj.type>\ndata: <json>\n\n"

const DEFAULT_CAP = 16 * 2 ** 20;

export function createSseParser({ onEvent, maxEventBytes = DEFAULT_CAP } = {}) {
  const decoder = new TextDecoder("utf-8");
  let buf = "";
  let started = false;
  let skipLf = false; // a CR ended the last line: a following LF belongs to it
  let ev = { event: "", data: [], id: null, size: 0 };

  const dispatch = () => {
    if (ev.data.length) onEvent({ event: ev.event || "message", data: ev.data.join("\n"), id: ev.id });
    ev = { event: "", data: [], id: null, size: 0 };
  };
  const line = (l) => {
    if (l === "") return dispatch();
    if (l.startsWith(":")) return;
    const c = l.indexOf(":");
    const field = c < 0 ? l : l.slice(0, c);
    let value = c < 0 ? "" : l.slice(c + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    ev.size += value.length;
    if (ev.size > maxEventBytes) throw Object.assign(new Error("an upstream event is larger than ad accepts"), { code: "SSE_EVENT_TOO_LARGE" });
    if (field === "data") ev.data.push(value);
    else if (field === "event") ev.event = value;
    else if (field === "id") ev.id = value;
  };
  const drain = (final) => {
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf.charCodeAt(i);
      if (skipLf) {
        skipLf = false;
        if (ch === 10) {
          start = i + 1;
          continue;
        }
      }
      if (ch === 10 || ch === 13) {
        line(buf.slice(start, i));
        start = i + 1;
        if (ch === 13) skipLf = true;
      }
    }
    buf = buf.slice(start);
    if (buf.length > maxEventBytes) throw Object.assign(new Error("an upstream event is larger than ad accepts"), { code: "SSE_EVENT_TOO_LARGE" });
    if (final) {
      if (buf) line(buf);
      buf = "";
      dispatch();
    }
  };
  return {
    push(chunk) {
      buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
      if (!started && buf) {
        started = true;
        if (buf.charCodeAt(0) === 0xfeff) buf = buf.slice(1); // a leading byte-order mark
      }
      drain(false);
    },
    end() {
      buf += decoder.decode();
      drain(true);
    },
  };
}

export const sseEvent = (obj) => `event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`;
