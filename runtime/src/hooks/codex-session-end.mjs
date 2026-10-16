#!/usr/bin/env node
// Kept for hooks.json files written by ad 2.x, which name this script. ad 3
// writes hooks/engine-session-end.mjs instead; this shim goes in 4.0.
import { runSessionEnd } from "./engine-session-end.mjs";

runSessionEnd();
