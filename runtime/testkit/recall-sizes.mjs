// Size variants of the dev brief set (L6 design decision 3): the same project with
// 3, 10 or 300 notes, so the thresholds are seen to hold across project sizes.
// 3 and 10 take the first relevant, other-area and neutral notes in label order; larger
// sizes add every other dev note (other projects' notes are irrelevant here), then
// distinct invented notes about other areas.
export function sizeVariant(project, others, size) {
  const byId = new Map(project.notes.map((n) => [n.id, n]));
  const take = (ids, k) => ids.slice(0, k).map((id) => byId.get(id)).filter(Boolean);
  const e = project.expected;
  // Stale notes are left out of the small variants: without the note that replaced
  // them they are current notes, and nothing could tell them apart.
  const otherArea = e.irrelevant.filter((id) => !/^\s*(?:stale|superseded)/i.test(e.reasons?.[id] ?? ""));
  if (size === 3) return { ...project, notes: [...take(e.relevant, 1), ...take(otherArea, 1), ...take(e.neutral, 1)] };
  if (size === 10) return { ...project, notes: [...take(e.relevant, 4), ...take(otherArea, 4), ...take(e.neutral, 2)] };
  const extra = [];
  for (const n of others) {
    if (project.notes.length + extra.length >= size) break;
    extra.push({ ...n, id: `x-${n.id}` });
  }
  // Beyond the other projects' notes: distinct invented notes about other areas (a real
  // store holds no identical duplicates: capture deduplicates per project).
  const A = ["ledger", "harbor", "quartz", "meadow", "falcon", "ember", "cobalt", "tundra", "saffron", "willow", "beacon", "granite"];
  const B = ["parser", "scheduler", "exporter", "gateway", "indexer", "renderer", "importer", "notifier", "sampler", "planner"];
  const C = ["uses a 30 second timeout", "is owned by the platform team", "writes to the archive bucket", "needs the feature flag on", "runs nightly at 02:00", "keeps a local LRU cache", "logs in JSON lines", "retries five times"];
  for (let i = 0; project.notes.length + extra.length < size; i++) {
    const a = A[i % A.length];
    const b = B[Math.floor(i / A.length) % B.length];
    const c = C[Math.floor(i / (A.length * B.length)) % C.length];
    extra.push({ id: `f-${i}`, text: `The ${a}${Math.floor(i / 960) || ""} ${b} in services/${a}/${b}.go ${c}.`, created: `2026-0${1 + (i % 9)}-1${i % 10}`, kind: "fact" });
  }
  return { ...project, notes: [...project.notes, ...extra], expected: { ...e, irrelevant: [...e.irrelevant, ...extra.map((n) => n.id)] } };
}
