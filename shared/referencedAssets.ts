import { parseKey, readEntity, type EntityKey } from "./keys.ts";
import type { ImageRef, RoomState } from "./model.ts";
import { imageAssetId } from "./imageRef.ts";
import type { AssetKind } from "./permissions.ts";
import type { RestoreEntry } from "./protocol.ts";

/**
 * Every place the room's state names an image row (docs/design-v1-dm-tools.md
 * 2.6 and 3.19), with the kind of asset that place takes: scene maps, map
 * phases and thumbnails, token images and other images, character
 * portraits, monsters', SRD monsters' and companion blocks' default
 * images, stamps from the library, and every page of a handout and of a
 * document in the DM's library. Shipped icons name no row.
 *
 * Cleanup asks it which images a room still uses, and the permissions ask
 * it which images an undo would put back. Both must know every reference,
 * so a field that names an asset is added here in the same change that
 * adds it to the model (referencedAssets.test.ts fails until it is).
 */
export type AssetRef = { assetId: string; kind: AssetKind };

/** The images one entity's value names, by its key's collection. Anything else names none. */
export function entityAssetRefs(key: EntityKey, value: unknown): AssetRef[] {
  if (value === null || typeof value !== "object") return [];
  const parsed = parseKey(key);
  if (!parsed) return [];
  const out: AssetRef[] = [];
  const image = (ref: ImageRef | null | undefined) => {
    const assetId = imageAssetId(ref);
    if (assetId !== undefined) out.push({ assetId, kind: "token" });
  };
  // Every page of a handout or a document, each image once (docs/design-v1-pdf-handouts.md 3.5).
  const pages = (list: unknown, ...seen: unknown[]) => {
    if (!Array.isArray(list)) return;
    const named = new Set(seen);
    for (const page of list as { assetId?: unknown }[]) {
      if (typeof page?.assetId !== "string" || named.has(page.assetId)) continue;
      named.add(page.assetId);
      out.push({ assetId: page.assetId, kind: "handout" });
    }
  };
  const v = value as Record<string, unknown>;
  switch (parsed.kind) {
    case "scene": {
      const map = v.map as { assetId?: unknown } | undefined;
      if (typeof map?.assetId === "string") out.push({ assetId: map.assetId, kind: "map" });
      for (const phase of (v.phases as { assetId?: unknown }[] | undefined) ?? []) {
        if (typeof phase.assetId === "string") out.push({ assetId: phase.assetId, kind: "map" });
      }
      if (typeof v.thumb === "string") out.push({ assetId: v.thumb, kind: "thumb" });
      break;
    }
    case "token":
      image(v.image as ImageRef | undefined);
      for (const alt of (v.altImages as ImageRef[] | undefined) ?? []) image(alt);
      break;
    case "character":
    case "monster":
    case "companionBlock":
      image(v.defaultImage as ImageRef | undefined);
      break;
    case "srdImage":
      image(v.image as ImageRef | undefined);
      break;
    case "stamp": {
      const art = v.art as { assetId?: unknown } | undefined;
      if (typeof art?.assetId === "string") out.push({ assetId: art.assetId, kind: "token" });
      break;
    }
    case "handout":
      // `assetId` is the first page, so a handout of pages names it twice: each image is listed once.
      if (typeof v.assetId === "string") out.push({ assetId: v.assetId, kind: "handout" });
      pages(v.pages, v.assetId);
      break;
    case "handoutDoc":
      pages(v.pages);
      break;
    default:
      break;
  }
  return out;
}

/** The collections whose entities can name an image, with the key of each entity. */
const IMAGE_COLLECTIONS = [
  ["scenes", "scene"],
  ["tokens", "token"],
  ["characters", "character"],
  ["monsters", "monster"],
  ["srdImages", "srdImage"],
  ["stamps", "stamp"],
  ["handouts", "handout"],
  ["handoutDocs", "handoutDoc"],
  ["companionBlocks", "companionBlock"],
] as const satisfies readonly (readonly [keyof RoomState, string])[];

/** Every asset id the state names, whatever kind its place takes. A thumbnail of a scene counts as used while the scene names it. */
export function referencedAssetIds(state: RoomState): Set<string> {
  const ids = new Set<string>();
  for (const [collection, kind] of IMAGE_COLLECTIONS) {
    for (const [id, value] of Object.entries(state[collection] as Record<string, unknown>)) {
      for (const ref of entityAssetRefs(`${kind}:${id}`, value)) ids.add(ref.assetId);
    }
  }
  return ids;
}

/**
 * The images a restore would add: those its values name that the entities
 * do not name now, with the kind each place takes. A reference the state
 * holds now is in use, so cleanup cannot have deleted it. A scene's
 * thumbnail never comes back this way, since a restore keeps the current
 * one (shared/reducer/misc.ts keepThumb), so it is left out.
 */
export function restoreAddedAssets(entries: readonly RestoreEntry[], state: RoomState): AssetRef[] {
  const out: AssetRef[] = [];
  for (const entry of entries) {
    const now = new Set(entityAssetRefs(entry.key, readEntity(state, entry.key)).map((ref) => `${ref.kind}:${ref.assetId}`));
    for (const ref of entityAssetRefs(entry.key, entry.value)) {
      if (ref.kind !== "thumb" && !now.has(`${ref.kind}:${ref.assetId}`)) out.push(ref);
    }
  }
  return out;
}
