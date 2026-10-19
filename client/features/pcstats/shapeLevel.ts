import type { StatBlockMonster } from "#shared/srd/monsters.ts";
import { monsterFacts } from "../tokens/monsterFilters.ts";

/**
 * What a Druid of a level may take as a Wild Shape form, by the Beast Shapes
 * table of the SRD 5.2.1 Druid. The picker uses it to narrow its list.
 * maxCr is null below level 2, where Wild Shape does not exist yet, so the
 * limit names no form at all.
 */
export type ShapeLimit = { maxCr: number | null; fly: boolean; label: string };

export const DRUID_LEVELS = Array.from({ length: 19 }, (_, i) => i + 2);

export function shapeLimit(level: number): ShapeLimit {
  if (level < 2) return { maxCr: null, fly: false, label: "No Wild Shape before level 2." };
  const [maxCr, cr] = level >= 8 ? [1, "1"] : level >= 4 ? [0.5, "1/2"] : [0.25, "1/4"];
  const fly = level >= 8;
  return { maxCr, fly, label: fly ? `Up to CR ${cr}.` : `Up to CR ${cr}, no Fly Speed.` };
}

/**
 * Why a Druid of the level may not take the creature's form, on its CR and
 * Fly Speed, or null when they may. Below level 2 every form misses on its
 * CR, since `maxCr` is null there. The Beast type is the picker's own
 * checkbox. A known form's mark and the level filter both read this, so
 * they never disagree (docs/design-v1-known-forms.md 5.1).
 */
export function shapeLimitMiss(limit: ShapeLimit, m: StatBlockMonster): "cr" | "fly" | null {
  if (limit.maxCr === null) return "cr";
  const f = monsterFacts(m);
  if (f.cr === null || f.cr > limit.maxCr) return "cr";
  return limit.fly || !f.movement.has("fly") ? null : "fly";
}

/** Whether a Druid of the level may take the creature's form, on its CR and Fly Speed. */
export function fitsShapeLimit(limit: ShapeLimit, m: StatBlockMonster): boolean {
  return shapeLimitMiss(limit, m) === null;
}

/** How many Beast forms a Druid of the level knows, by the Beast Shapes table: 4 from level 2, 6 from 4, 8 from 8, and none before Wild Shape. */
export function knownFormCount(level: number): number {
  return level >= 8 ? 8 : level >= 4 ? 6 : level >= 2 ? 4 : 0;
}

/** Highest CR first, then by name, so a Druid reads their options from the strongest down. A CR the app cannot read sorts last. */
export function byCrThenName(a: StatBlockMonster, b: StatBlockMonster): number {
  const ca = monsterFacts(a).cr ?? -1;
  const cb = monsterFacts(b).cr ?? -1;
  return cb - ca || a.name.localeCompare(b.name);
}
