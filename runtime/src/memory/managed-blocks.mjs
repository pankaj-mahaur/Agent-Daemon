// The text ad itself wrote into a user's instruction file (plan L4b, 04 + 07 T-L):
// `ad init`'s block (<!-- agent-daemon:start --> … <!-- agent-daemon:end -->) and
// the learnings mirror 3.x's digest wrote into CLAUDE.md
// (<!-- agent-daemon:learnings:start --> … <!-- agent-daemon:learnings:end -->).
// It is product text, never the user's rules, so imports and counts skip it.
//
// Fail closed: a block that is never closed runs to the end of the file (a cut
// block is still ad's text), and blocks that overlap or nest end only when every
// block opened inside them is closed. A stray end marker is dropped on its own.

const MARKER = /<!--\s*agent-daemon:(learnings:)?(start|end)\s*-->/gi;

/**
 * The text with every ad-managed block removed, markers included. Line endings
 * are kept; a removed block leaves the line break before it.
 * @param {string} text
 * @returns {string}
 */
export function stripManaged(text) {
  const s = String(text ?? "");
  let out = "";
  let at = 0; // where the kept text starts
  const open = new Set(); // block kinds open at this point
  for (const m of s.matchAll(MARKER)) {
    const kind = m[1] ? "learnings" : "init";
    if (m[2].toLowerCase() === "start") {
      if (open.size === 0) out += s.slice(at, m.index);
      open.add(kind);
      continue;
    }
    if (open.size === 0) {
      // A stray end marker: drop it, keep the text around it.
      out += s.slice(at, m.index);
      at = m.index + m[0].length;
      continue;
    }
    open.delete(kind);
    if (open.size === 0) at = m.index + m[0].length;
  }
  // A block still open runs to the end of the file.
  return open.size > 0 ? out : out + s.slice(at);
}

/** Does the text hold any ad-managed marker? */
export const hasManaged = (text) => new RegExp(MARKER.source, "i").test(String(text ?? ""));
