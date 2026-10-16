// Tests for the product value (src/product-values.mjs): ad's own engine is
// "ad" however it was spelled; anything else passes through.

import { test } from "node:test";
import assert from "node:assert/strict";
import { LEGACY } from "../src/engine/attribution.mjs";
import { productValue } from "../src/product-values.mjs";

test("productValue maps the old spelling to ad and leaves the rest alone", () => {
  assert.equal(productValue("ad"), "ad");
  assert.equal(productValue(LEGACY.productValue), "ad");
  assert.equal(productValue("claude"), "claude");
  assert.equal(productValue(undefined), undefined);
});
