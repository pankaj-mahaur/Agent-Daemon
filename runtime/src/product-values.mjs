// The value that names ad's own engine in --engine, --llm, --host and their
// env vars is "ad". ad 2.x wrote the old value; it is read forever (design C11).

import { LEGACY } from "./engine/attribution.mjs";

/** "ad" for ad's engine, whatever spelling was used; any other value unchanged. */
export const productValue = (v) => (v === LEGACY.productValue ? "ad" : v);
