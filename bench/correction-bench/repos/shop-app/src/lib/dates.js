// Dates shown to people or stored as text.
export function fmtDate(d, style = "day") {
  const x = d instanceof Date ? d : new Date(d);
  const day = `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}-${String(x.getUTCDate()).padStart(2, "0")}`;
  return style === "day" ? day : `${day} ${String(x.getUTCHours()).padStart(2, "0")}:${String(x.getUTCMinutes()).padStart(2, "0")} UTC`;
}
