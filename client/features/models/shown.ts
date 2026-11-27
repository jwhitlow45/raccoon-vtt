import type { Actor, Character, ModelRef, Token } from "#shared/model.ts";
import { shownLife } from "#shared/rules/hp.ts";
import type { SheetImage, Sheets } from "./sheets.ts";

/**
 * Whether a creature stands as its 3D model in Isometric
 * (docs/design/design-v1-token-models.md 3.2 and 6, D-261127-177, 376, 380).
 * Every reader of a standee's shape asks `modelShown`: the board's layout,
 * a drag, another member's ghost, the kept picture's test rig and the
 * standee's drawing, which reads the layout's answer. So the shape laid out
 * is the shape drawn, and both change together when a sheet arrives or goes.
 *
 * It keeps its picture until its sheet is decoded, so a slow link never
 * shows a blank, and while it is dead, dying or stable, so its state reads
 * as Top-down's marks show it. The life is `shownLife`, what the token's
 * body reads, so a creature with no HP to show, or one whose HP the viewer
 * may not read, keeps its model. An object keeps it too, as no HP rule
 * draws a mark on one.
 */

/** What the predicate reads of a token. */
export type ModelToken = Pick<Token, "image" | "kind" | "companion">;

/** What it reads of the token's creature: its life and its HP's maximum, through shownLife. */
export type ModelActor = Pick<Partial<Actor>, "hp" | "life"> | undefined;

/** A model a creature stands as: its ref, and its sheet decoded. */
export type ShownModel = { ref: ModelRef; image: SheetImage };

/** The model a token's image carries, when its creature's life lets it stand as one: what the board asks the sheet cache for. */
export function modelWanted(token: ModelToken, actor: ModelActor): ModelRef | null {
  const ref = token.image?.model;
  if (!ref) return null;
  if (token.kind === "object") return ref;
  const life = shownLife(actor, token);
  return life === "dead" || life === "dying" || life === "stable" ? null : ref;
}

/** The model a creature stands as, or null when it stands as its picture. */
export function modelShown(token: ModelToken, actor: ModelActor, sheets: Pick<Sheets, "image">): ShownModel | null {
  const ref = modelWanted(token, actor);
  const image = ref ? sheets.image(ref.assetId) : null;
  return ref && image ? { ref, image } : null;
}

/** The creature a token holds: its own, or its character's for a token that names one. */
export function tokenActor(token: { actor: { ref: string } | { inline: Partial<Actor> } }, characters: Readonly<Record<string, { actor: Partial<Actor> } | undefined>> | undefined): Partial<Actor> | undefined {
  return "inline" in token.actor ? token.actor.inline : characters?.[token.actor.ref]?.actor;
}

/**
 * Whether each token that names a character and wears a model may stand as
 * it now, as one string. A token's own creature changes the token, but a
 * character's changes only the character, so a board keys its layout on
 * this to lay out again when a character dies or rises, and not for its
 * other edits.
 */
export function characterModelsKey(tokens: readonly (ModelToken & Pick<Token, "id" | "actor">)[], characters: Readonly<Record<string, Pick<Character, "actor"> | undefined>> | undefined): string {
  let key = "";
  for (const t of tokens) {
    if (!t.image?.model || "inline" in t.actor) continue;
    key += `${t.id}:${modelWanted(t, tokenActor(t, characters)) ? 1 : 0};`;
  }
  return key;
}
