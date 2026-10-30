// The shop's logger: every message goes through here.
const write = (level, msg, fields = {}) => process.stdout.write(JSON.stringify({ level, msg, ...fields, at: Date.now() }) + "\n");

export const logInfo = (msg, fields) => write("info", msg, fields);
export const logWarn = (msg, fields) => write("warn", msg, fields);
export const logError = (msg, fields) => write("error", msg, fields);
