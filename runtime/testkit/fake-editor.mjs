#!/usr/bin/env node
// A stand-in for $EDITOR in tests (P2.4): appends " EDITED-BY-FAKE" to the
// file it is given (its last argument) and exits 0.
//   --fail       exits 3 without touching the file
//   --leave-alt  writes ?1049h … ?1049l first, like a terminal editor

import { appendFileSync, writeSync } from "node:fs";

const args = process.argv.slice(2);
const file = args.at(-1);
if (args.includes("--fail")) process.exit(3);
if (args.includes("--leave-alt")) writeSync(1, "\x1b[?1049h fake editor \x1b[?1049l");
appendFileSync(file, " EDITED-BY-FAKE");
process.exit(0);
