// A small JSON Schema (2020-12) validator for the vendored host-package schemas:
// type, properties, required, additionalProperties (false or a schema), const,
// enum, minLength, maxLength, pattern, items, oneOf, not, propertyNames and
// local $ref ("#/$defs/…"). An unknown keyword throws, so a schema update that
// needs more is noticed instead of silently passing.
//
//   validate(schema, value) → [] when valid, else ["<path>: <problem>", …]

const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "$defs", "$comment"]);
const KEYWORDS = new Set(["type", "properties", "required", "additionalProperties", "const", "enum", "minLength", "maxLength", "pattern", "items", "oneOf", "not", "propertyNames", "$ref"]);

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => (t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

function resolve(root, ref) {
  if (!ref.startsWith("#/")) throw new Error(`only local $ref is supported: ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => {
      if (!node || !(key in node)) throw new Error(`unresolved $ref ${ref}`);
      return node[key];
    }, root);
}

function check(root, schema, value, at, out) {
  for (const k of Object.keys(schema)) if (!ANNOTATIONS.has(k) && !KEYWORDS.has(k)) throw new Error(`json-schema-lite: unsupported keyword "${k}" at ${at || "/"}`);
  if (schema.$ref) check(root, resolve(root, schema.$ref), value, at, out);
  if (schema.type !== undefined && ![].concat(schema.type).some((t) => isType(value, t))) {
    out.push(`${at || "/"}: expected ${[].concat(schema.type).join(" or ")}, got ${typeOf(value)}`);
    return;
  }
  if ("const" in schema && JSON.stringify(value) !== JSON.stringify(schema.const)) out.push(`${at || "/"}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) out.push(`${at || "/"}: must be one of ${JSON.stringify(schema.enum)}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) out.push(`${at || "/"}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) out.push(`${at || "/"}: longer than ${schema.maxLength}`);
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) out.push(`${at || "/"}: doesn't match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => check(root, schema.items, v, `${at}/${i}`, out));
  if (typeOf(value) === "object") {
    for (const r of schema.required ?? []) if (!(r in value)) out.push(`${at || "/"}: missing "${r}"`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.propertyNames) {
        const sub = [];
        check(root, schema.propertyNames, k, `${at}/${k}`, sub);
        if (sub.length) out.push(`${at}/${k}: property name not allowed`);
      }
      if (schema.properties && k in schema.properties) check(root, schema.properties[k], v, `${at}/${k}`, out);
      else if (schema.additionalProperties === false) out.push(`${at || "/"}: unknown property "${k}"`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") check(root, schema.additionalProperties, v, `${at}/${k}`, out);
    }
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter((s) => {
      const sub = [];
      check(root, s, value, at, sub);
      return sub.length === 0;
    }).length;
    if (passing !== 1) out.push(`${at || "/"}: must match exactly one schema in oneOf (matches ${passing})`);
  }
  if (schema.not) {
    const sub = [];
    check(root, schema.not, value, at, sub);
    if (!sub.length) out.push(`${at || "/"}: must not match the "not" schema`);
  }
}

/** → [] when `value` is valid against `schema`, else a list of problems. */
export function validate(schema, value) {
  const out = [];
  check(schema, schema, value, "", out);
  return out;
}
