// Money is integer cents everywhere. Never floats.
export const Money = {
  cents: (text) => {
    const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(text).trim());
    if (!m) throw new Error(`not an amount: ${text}`);
    return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  },
  format: (cents) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`,
};
