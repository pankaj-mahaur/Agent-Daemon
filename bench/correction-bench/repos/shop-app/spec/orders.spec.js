import { test } from "node:test";
import assert from "node:assert/strict";
import { placeOrder, getOrder } from "#app/orders.js";

test("an order keeps its total in cents", () => {
  const o = placeOrder("usr_1", [{ price: "2.50", qty: 2 }]);
  assert.equal(o.total, 500);
  assert.equal(getOrder(o.id).status, "placed");
});
