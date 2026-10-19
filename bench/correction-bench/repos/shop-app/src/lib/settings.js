// The one place that reads the environment.
const values = {
  "services.payments": process.env.PAYMENTS_URL ?? "http://localhost:4001",
  "services.mail": process.env.MAIL_URL ?? "http://localhost:4002",
  "orders.maxItems": Number(process.env.ORDERS_MAX_ITEMS ?? 50),
};
export const settings = { get: (key) => values[key] };
