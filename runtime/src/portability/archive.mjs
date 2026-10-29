// The bundle file (P7.1b): a tar (ustar; a pax "x" header only for a long name or size) inside
// gzip, extension .adstate. No dependency: node's zlib and this file.
//
//   writeArchive(entries) → Buffer           entries: [{ name, data: Buffer|string } | { name, dir: true }]
//   readArchive(buffer)   → [{ name, dir, data }]
//
// The writer is deterministic: regular files and directories only, mode 0600 / 0700, mtime 0,
// owner 0, names sorted, NFC. The reader is strict: it accepts a file, a directory, and a pax
// "x" header with only `path` and `size`; anything else (a link, a device, a global pax header,
// another key) is an error. Every effective name (pax path, else ustar prefix + "/" + name) goes
// through validateEntryName before it is returned. A truncated or corrupt bundle is an error,
// never a partial list.

import { gunzipSync, gzipSync } from "node:zlib";
import { validateEntryName } from "./names.mjs";

const BLOCK = 512;
export const ARCHIVE_EXT = ".adstate";

export class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.code = "ARCHIVE_INVALID";
  }
}

const octal = (n, width) => `${n.toString(8).padStart(width - 1, "0")}\0`;

function header({ name, size, type, mode }) {
  const h = Buffer.alloc(BLOCK);
  const put = (s, off, len) => Buffer.from(s, "utf8").copy(h, off, 0, len);
  put(name, 0, 100);
  put(octal(mode, 8), 100, 8);
  put(octal(0, 8), 108, 8); // uid
  put(octal(0, 8), 116, 8); // gid
  put(octal(size, 12), 124, 12);
  put(octal(0, 12), 136, 12); // mtime
  h.fill(0x20, 148, 156); // checksum placeholder
  put(type, 156, 1);
  put("ustar\0", 257, 6);
  put("00", 263, 2);
  let sum = 0;
  for (const b of h) sum += b;
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return h;
}

const pad = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

// A pax record: "<len> key=value\n", where len counts the whole record itself.
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body);
  let total = len + String(len).length;
  if (String(total).length !== String(len).length) total = len + String(total).length;
  return `${total}${body}`;
}

export function writeArchive(entries) {
  const list = entries.map((e) => ({ ...e, name: String(e.name).normalize("NFC") })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const seen = new Set();
  const parts = [];
  for (const e of list) {
    const name = e.dir && !e.name.endsWith("/") ? `${e.name}/` : e.name;
    const why = validateEntryName(name, { dir: Boolean(e.dir) });
    if (why) throw new ArchiveError(`${JSON.stringify(e.name)}: ${why}`);
    if (seen.has(name)) throw new ArchiveError(`${JSON.stringify(name)} appears twice`);
    seen.add(name);
    const data = e.dir ? Buffer.alloc(0) : Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data ?? ""), "utf8");
    const long = Buffer.byteLength(name) > 99;
    const big = data.length > 0o77777777777;
    if (long || big) {
      const pax = Buffer.from((long ? paxRecord("path", name) : "") + (big ? paxRecord("size", String(data.length)) : ""), "utf8");
      parts.push(header({ name: "PaxHeader", size: pax.length, type: "x", mode: 0o600 }), pax, pad(pax.length));
    }
    parts.push(header({ name: long ? name.slice(0, 99) : name, size: big ? 0 : data.length, type: e.dir ? "5" : "0", mode: e.dir ? 0o700 : 0o600 }));
    if (!e.dir) parts.push(data, pad(data.length));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  // A fixed header: no name, no time, the same OS byte everywhere (deterministic output).
  const gz = gzipSync(Buffer.concat(parts), { level: 9 });
  gz[9] = 255; // OS: unknown
  return gz;
}

const str = (b, off, len) => {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z === -1 ? s : s.subarray(0, z)).toString("utf8");
};
const num = (b, off, len) => {
  const s = str(b, off, len).trim();
  if (!/^[0-7]*$/.test(s)) throw new ArchiveError("a header field that isn't an octal number");
  return s ? parseInt(s, 8) : 0;
};

// Records counted in bytes ("<len> key=value\n"), so a multi-byte name never shifts the next one.
function parsePax(buf) {
  const out = {};
  let i = 0;
  while (i < buf.length) {
    const sp = buf.indexOf(0x20, i);
    const len = sp === -1 ? NaN : Number(buf.subarray(i, sp).toString("latin1"));
    if (!Number.isInteger(len) || len <= 0 || i + len > buf.length) throw new ArchiveError("a broken pax header");
    const m = /^([^=]+)=([\s\S]*)\n$/.exec(buf.subarray(sp + 1, i + len).toString("utf8"));
    if (!m) throw new ArchiveError("a broken pax record");
    if (m[1] !== "path" && m[1] !== "size") throw new ArchiveError(`a pax key the bundle doesn't use: ${m[1]}`);
    out[m[1]] = m[2];
    i += len;
  }
  return out;
}

export function readArchive(buffer) {
  let tar;
  try {
    tar = gunzipSync(buffer);
  } catch (e) {
    throw new ArchiveError(`the bundle isn't a complete gzip file (${e.code ?? e.message})`);
  }
  const out = [];
  const seen = new Set();
  let off = 0;
  let pax = null;
  let ended = false;
  while (off + BLOCK <= tar.length) {
    const h = tar.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) {
      ended = true;
      break;
    }
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== num(h, 148, 8)) throw new ArchiveError("a header whose checksum doesn't match");
    if (str(h, 257, 5) !== "ustar") throw new ArchiveError("a header that isn't ustar");
    const type = String.fromCharCode(h[156] || 0x30);
    let size = num(h, 124, 12);
    off += BLOCK;
    if (type === "x") {
      if (pax) throw new ArchiveError("two pax headers in a row");
      if (off + size > tar.length) throw new ArchiveError("the bundle is cut short");
      pax = parsePax(tar.subarray(off, off + size));
      off += size + pad(size).length;
      continue;
    }
    if (type !== "0" && type !== "5") throw new ArchiveError(`an entry that is neither a file nor a folder (type ${JSON.stringify(type)})`);
    const prefix = str(h, 345, 155);
    const name = pax?.path ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100));
    if (pax?.size !== undefined) size = Number(pax.size);
    pax = null;
    const dir = type === "5";
    const why = validateEntryName(name, { dir });
    if (why) throw new ArchiveError(`${JSON.stringify(name)}: ${why}`);
    const key = dir && !name.endsWith("/") ? `${name}/` : name;
    if (seen.has(key)) throw new ArchiveError(`${JSON.stringify(name)} appears twice`);
    seen.add(key);
    if (off + size > tar.length) throw new ArchiveError("the bundle is cut short");
    out.push({ name: key, dir, data: dir ? null : Buffer.from(tar.subarray(off, off + size)) });
    off += size + pad(size).length;
  }
  if (!ended || pax) throw new ArchiveError("the bundle is cut short");
  return out;
}
