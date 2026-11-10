/**
 * A player's copy in the form this build sends it, from a copy any build
 * made: every rev 0, and each stamp's `z` its rank among the stamps of its
 * scene that the copy holds, by `z`, then id (project.ts rankedStamps). A
 * copy this build made comes back the same. The golden tests hash a
 * player's copy through it, so their fixtures, recorded through it on the
 * build before copies took this form, still say that nothing else changed.
 */
export function asPlayerCopy<T>(copy: T): T {
  const out = zeroRevs(copy) as T;
  const stamps = (out as { stamps?: Record<string, { sceneId: string; z: number }> } | null)?.stamps;
  if (!stamps) return out;
  const byScene = new Map<string, string[]>();
  for (const [id, stamp] of Object.entries(stamps)) {
    const ids = byScene.get(stamp.sceneId) ?? [];
    ids.push(id);
    byScene.set(stamp.sceneId, ids);
  }
  for (const ids of byScene.values()) {
    ids.sort((a, b) => stamps[a]!.z - stamps[b]!.z || (a < b ? -1 : a > b ? 1 : 0));
    for (const [rank, id] of ids.entries()) stamps[id] = { ...stamps[id]!, z: rank };
  }
  return out;
}

function zeroRevs(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(zeroRevs);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = k === "rev" && typeof v === "number" ? 0 : zeroRevs(v);
  return out;
}
