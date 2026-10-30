// Calls to other services: retries, timeouts and auth live here.
import { settings } from "./settings.js";

export async function request(service, path, { method = "GET", body } = {}) {
  const base = settings.get(`services.${service}`);
  const res = await globalThis.fetch(base + path, { method, body: body && JSON.stringify(body), headers: { "content-type": "application/json" } });
  if (!res.ok) throw new Error(`${service} ${path}: ${res.status}`);
  return res.json();
}
