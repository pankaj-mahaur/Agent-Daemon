import { newId } from "#app/lib/ids.js";
import { Money } from "#app/lib/money.js";
import { settings } from "#app/lib/settings.js";

const orders = new Map();

export function placeOrder(userId, items) {
  if (items.length > settings.get("orders.maxItems")) throw new Error("too many items");
  const total = items.reduce((sum, it) => sum + Money.cents(it.price) * it.qty, 0);
  const order = { id: newId("ord"), userId, items, total, createdAt: Date.now(), status: "placed" };
  orders.set(order.id, order);
  return order;
}

export const getOrder = (id) => orders.get(id) ?? null;
export const listOrders = (userId) => [...orders.values()].filter((o) => o.userId === userId);
