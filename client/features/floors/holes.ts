import type { CellRect, RoomState, Scene, SceneId } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { fallDrop, linkDir, linkHeight, linksOn, rectGround, type LinkEnd } from "#shared/rules/floorLinks.ts";

/*
 * The holes openings make in a floor, as the device's copy reads them
 * (docs/design/design-v1-floors.md phase 4, 7.4 and 9.1): the upper ends
 * on a floor, the far end each leads to, and how far below its rim the
 * floor below lies. The window, its height chip and Isometric's drop
 * (lib/view.ts floorHoles) all read them here, so no two tell different
 * depths. A player's copy holds a floor only once players reach it or the
 * DM shows it, and an end only outside full fog, so nothing here names a
 * height a player was not sent.
 */

type Copy = Pick<RoomState, "scenes" | "floorLinks">;

/** The hole an opening makes in the floor shown, and the floor below it where the copy holds that floor, else null: the hole is then a black drop. */
export type HoleSpec = { link: LinkEnd; far: Scene | null };

/**
 * The upper ends of openings on a floor, by id, each with the floor below
 * where the copy holds it. A lower end leads up and draws no hole.
 */
export function holesOn(view: Copy, sceneId: SceneId): HoleSpec[] {
  const out: HoleSpec[] = [];
  for (const link of linksOn(view, sceneId) as LinkEnd[]) {
    if (link.kind !== "opening" || linkDir(view, link) !== "down") continue;
    const far = link.to === undefined ? undefined : ownEntry(view.scenes, link.to);
    out.push({ link, far: far ?? null });
  }
  return out;
}

/**
 * The other end of an opening as the copy holds it: the end on the far
 * floor over the same squares that leads back. A player's copy names no
 * pair, and holds the far end only while it is projected to them.
 */
export function farEnd(view: Copy, link: LinkEnd): LinkEnd | null {
  if (link.to === undefined) return null;
  const same = (a: CellRect, b: CellRect) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
  return (linksOn(view, link.to) as LinkEnd[]).find((l) => l.kind === "opening" && same(l.rect, link.rect) && (l.to === undefined || l.to === link.sceneId)) ?? null;
}

/**
 * How far a creature would fall through an upper end (4.2), for its chip
 * (7.4) and for the hole's bottom in Isometric (lib/view.ts floorHoles,
 * 9.1): the floor's height, which a player's end carries as `rise`, plus
 * the ground under the hole less the ground under the far end, read from
 * the copy's own build. Null where the copy lacks the far floor or the far
 * end, or either ground is not one height there.
 */
export function holeDrop(view: Copy & Pick<RoomState, "buildChunks">, link: LinkEnd & { rise?: number }): number | null {
  // A copy holds an end only on a floor it holds, so the far end stands for the far floor too.
  const far = farEnd(view, link);
  if (far === null) return null;
  const upper = rectGround(view.buildChunks, link.sceneId, link.rect);
  const lower = rectGround(view.buildChunks, far.sceneId, far.rect);
  if (upper === null || lower === null) return null;
  return fallDrop(linkHeight(view, link), upper, lower);
}

/**
 * Each hole's drop on a floor, as the copy reads it (`holeDrop`), as one
 * string, "o1=10 o3=15", so the board's selector keeps one value while no
 * height changes. A hole whose drop the copy cannot tell is left out.
 */
export function holeDrops(view: Copy & Pick<RoomState, "buildChunks">, sceneId: SceneId): string {
  return holesOn(view, sceneId)
    .flatMap(({ link }) => {
      const ft = holeDrop(view, link);
      return ft === null ? [] : [`${link.id}=${ft}`];
    })
    .join(" ");
}
