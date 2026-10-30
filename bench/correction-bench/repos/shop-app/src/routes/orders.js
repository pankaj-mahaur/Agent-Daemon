import { ok, fail } from "#app/lib/envelope.js";
import { getOrder, listOrders } from "#app/orders.js";

export function handleGetOrder(req, res) {
  const order = getOrder(req.params.id);
  if (!order) return fail(res, 404, "not_found", "No such order");
  return ok(res, order);
}

export const handleListOrders = (req, res) => ok(res, listOrders(req.user.id));
