// Every HTTP answer has the same shape: { ok, data } or { ok: false, error: { code, message } }.
export const ok = (res, data) => res.send(200, { ok: true, data });
export const fail = (res, status, code, message) => res.send(status, { ok: false, error: { code, message } });
