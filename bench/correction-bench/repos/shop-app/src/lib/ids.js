// Ids for orders, carts and users: sortable, prefixed.
let n = 0;
export function newId(prefix) {
  n = (n + 1) % 1000;
  return `${prefix}_${Date.now().toString(36)}${String(n).padStart(3, "0")}`;
}
