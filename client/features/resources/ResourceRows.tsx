import type { CharacterId } from "#shared/model.ts";

/**
 * Where a character's class resource rows stand
 * (docs/design-v1-combat-controls.md 7.2): `card` in its turn card, and
 * `list` in its tracker row's Uses group and its token bar's Uses drawer,
 * the off-turn list.
 */
export type ResourceRowsForm = "card" | "list";

/**
 * A character's class resources as rows, each with its count and Use, Use…
 * for a pool, and Give one back (docs/design-v1-combat-controls.md 7.2).
 * The combat surfaces render it, and the class resources lane fills it in.
 * Until then it renders nothing.
 */
export function ClassResourceRows(_props: { characterId: CharacterId; form: ResourceRowsForm }) {
  return null;
}
