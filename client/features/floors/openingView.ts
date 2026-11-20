import type { BuildChunk, CellRect, RoomState, Scene, SceneId, Token } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import { fallDrop, linkDir, linkHeight, linksOn, rectGround, rectKeys, rectsOverlap, type LinkEnd } from "#shared/rules/floorLinks.ts";
import { footprintRect, occupiedHexes } from "#shared/rules/footprint.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { hexKey } from "#shared/rules/hex.ts";
import { rectHexes } from "#shared/rules/traps.ts";
import { createStore } from "zustand/vanilla";
import { hexOutline } from "../../lib/scene.ts";
import { scopeSlot } from "../../state/scope.ts";

/*
 * What an opening shows of the floor below it (docs/design/design-v1-floors.md
 * phase 4, 7.4): the window in each upper end on the floor shown, and the
 * height chip beside it. Every read of the far floor goes through here, on
 * the device's whole copy, which holds each floor the device holds: the
 * board's own readers take the floor shown's cut (canvas/floorViewReads.test.ts),
 * and this file lies outside the folders that test guards.
 *
 * A player's copy holds a floor only once players reach it or the DM shows
 * it, and an end only outside full fog, so a window draws nothing of a
 * floor not held and a chip names no height a player was not sent.
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
 * (7.4): the floor's height, which a player's end carries as `rise`, plus
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

/** The far floor's build, as the copy holds it: a player's only what they have seen there. */
export function farChunks(view: Pick<RoomState, "buildChunks">, farId: SceneId): BuildChunk[] {
  return Object.values(view.buildChunks).filter((c): c is BuildChunk => c !== undefined && c.sceneId === farId);
}

/**
 * The creatures and objects on the far floor whose space meets the hole's
 * squares, as the copy holds them, bottom first by elevation then id, so
 * the window draws them in a fixed order. A player's copy holds only those
 * the server sends them.
 */
export function farTokensIn(view: Pick<RoomState, "scenes" | "tokens">, farId: SceneId, rect: CellRect): Token[] {
  const scene = ownEntry(view.scenes, farId);
  if (scene === undefined) return [];
  const g = sceneGrid(scene);
  const held = new Set(rectKeys(rect));
  const meets = (t: Token) => (isHex(g) ? occupiedHexes(g, t).some((h) => held.has(hexKey(h))) : rectsOverlap(footprintRect(g, t), rect));
  return Object.values(view.tokens)
    .filter((t): t is Token => t !== undefined && t.sceneId === farId && meets(t))
    .sort((a, b) => a.elevation - b.elevation || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * A hole's squares where the board draws them, in cells: the box round
 * them, and on hexes the outline of their hexes, which the window and the
 * drop are clipped to.
 */
export type HoleOutline = { x: number; y: number; w: number; h: number; loop: number[] | null };

export function holeOutline(g: Grid, rect: CellRect): HoleOutline {
  if (!isHex(g)) return { ...rect, loop: null };
  const loop = hexOutline(g, rectHexes([rect]));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < loop.length; i += 2) {
    x0 = Math.min(x0, loop[i]!);
    x1 = Math.max(x1, loop[i]!);
    y0 = Math.min(y0, loop[i + 1]!);
    y1 = Math.max(y1, loop[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, loop };
}

/** The most pixels a window's crop takes a side (7.4, 13): at most 512 by 512, so 16 windows hold at most 16 MiB. */
export const WINDOW_MAX_PX = 512;

/** Pixels a cell in a window's crop: 64, fewer where the hole is long enough to pass WINDOW_MAX_PX. */
export function windowPxPerCell(rect: Pick<CellRect, "w" | "h">): number {
  return Math.max(1, Math.min(64, Math.floor(WINDOW_MAX_PX / Math.max(rect.w, rect.h, 1))));
}

/**
 * The far floors whose images the windows are decoding, by name, once each
 * a floor being drawn: the scene's loading notice says "Loading Ground
 * floor…" while any is (canvas/SceneLoading.tsx), so a window never sits
 * black with nothing said. One per Room page.
 */
export const windowLoadSlot = scopeSlot(() => createStore<{ loading: readonly string[] }>(() => ({ loading: [] })));
