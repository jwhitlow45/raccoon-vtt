/**
 * What a player's copy may never hold (docs/design-v1-per-player-vision.md
 * section 9, rule 3): the holder list, the explored layers apart from the
 * merged fog, and every list of who saw. A reader's copy of a mark says
 * `seen: true` and holds no list. Tests walk a parsed frame or state with
 * it, so a snapshot's properties, an event's entity keys and an ephemeral
 * frame's payload are all read, whatever their spelling in the raw text.
 */
const PRIVATE_KEYS = new Set(["holders", "exploredBy", "exploredAny", "seenBy", "toSeenBy"]);
/** Entity keys an `ev` names these by (shared/keys.ts). */
const PRIVATE_ENTITY_PREFIXES = ["holders:", "exploredBy:", "exploredAny:"];

/** Where `value` holds anything private, as paths such as `$.state.holders`, or none. */
export function privateFieldsIn(value: unknown): string[] {
  const found: string[] = [];
  walk(value, "$", found);
  return found;
}

function walk(value: unknown, path: string, found: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, found));
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (PRIVATE_KEYS.has(key)) found.push(at);
    else if (key === "seen" && Array.isArray(child)) found.push(`${at}, a list`);
    else if (key === "key" && typeof child === "string" && PRIVATE_ENTITY_PREFIXES.some((p) => child.startsWith(p))) found.push(`${at} ${child}`);
    walk(child, at, found);
  }
}
