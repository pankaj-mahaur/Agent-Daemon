// Memory files and recall (MCP launch plan L6, design decision 7). The store is the
// only source of learnings: every lesson line a memory file holds (review.mjs
// acceptMemory and checklist-apply.mjs append one per accepted note, with its evidence
// on the "  > " lines below) is taken out of the injected copy, so a note reaches the
// agent only through the brief — ranked, tagged, or not at all.

import fs from "node:fs";
import path from "node:path";
import { PROJECT_FOLDER, outsideDir } from "./project-dir.mjs";

// The lesson line appendToMemory writes (metrics.mjs FILE_LINE): "- **type** (conf 0.80): text".
const LESSON = /^-\s+\*\*[a-z-]+\*\*\s+\(conf\s+\d+(?:\.\d+)?\)\s*:/;
const EVIDENCE = /^\s+>\s?/;

/** The file's text without lesson lines and the evidence lines under them. */
export function withoutLessons(text) {
  const out = [];
  let inLesson = false;
  for (const line of String(text ?? "").split(/(?<=\n)/)) {
    if (LESSON.test(line)) {
      inLesson = true;
      continue;
    }
    if (inLesson && EVIDENCE.test(line)) continue;
    inLesson = false;
    out.push(line);
  }
  return out.join("").replace(/\n{3,}/g, "\n\n");
}

/**
 * The project's data folder, looked up without side effects: its own `.agent-daemon`
 * folder when it has one, else the folder outside it. Never projectDataDir, which
 * adopts (moves) the outside folder into the repository.
 */
export function memoryFolder(cwd) {
  const own = path.join(path.resolve(cwd), PROJECT_FOLDER);
  try {
    if (fs.statSync(own).isDirectory()) return own;
  } catch {
    // no folder of its own
  }
  return outsideDir(cwd, { create: false });
}
