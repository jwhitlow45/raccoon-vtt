import { CLAIM_KINDS, MODULES, type ClaimKind } from "./registry.ts";
import { ownerOf } from "./gate.ts";

/**
 * The ownership map (docs/design/design-v1-features.md 14, D-261127-125):
 * every id each registry holds, with the part that owns it and the
 * condition it owns it under, or "core". ownership.golden.json records it,
 * so a new panel, tool, key, sheet row, top bar part, search entry or
 * builder mode shows up in review as core or a part's, and a claim whose
 * entry was renamed away fails instead of quietly hiding nothing.
 *
 * The registries come in from the caller, the test, so this file imports
 * none of them and stays free of the room.
 */

export type Registries = Readonly<Record<ClaimKind, readonly string[]>>;

/** Each registry's ids in order, each with its owner: "core", "spellSlots", or "floors when oneFloor". */
export type Ownership = Record<ClaimKind, Record<string, string>>;

export function ownershipOf(registries: Registries): Ownership {
  const out = {} as Ownership;
  for (const kind of CLAIM_KINDS) {
    const ids: Record<string, string> = {};
    for (const id of [...new Set(registries[kind])].sort()) {
      const owner = ownerOf(kind, id);
      ids[id] = owner ? (owner.when ? `${owner.module} when ${owner.when}` : owner.module) : "core";
    }
    out[kind] = ids;
  }
  return out;
}

/** Claims that name no id their registry holds: a search claim, a prefix, must start at least one. */
export function strayClaims(registries: Registries): string[] {
  const out: string[] = [];
  for (const m of MODULES) {
    for (const c of m.claims) {
      const ids = registries[c.kind];
      const found = c.kind === "search" ? ids.some((id) => id.startsWith(c.id)) : ids.includes(c.id);
      if (!found) out.push(`${m.id} claims ${c.kind} ${c.id}, which no registry entry is`);
    }
  }
  return out;
}
