import { useMemo } from "react";
import { sightOf } from "#shared/keys.ts";
import type { FogTile, RoomState, SceneId, SightTile, Token } from "#shared/model.ts";
import { ownEntry } from "#shared/records.ts";
import type { AreaThrough } from "#shared/rules/aoe.ts";
import { linkDir, linkHeight, linksOn, type LinkEnd } from "#shared/rules/floorLinks.ts";
import { playersSee } from "#shared/rules/floors.ts";
import type { Ground } from "#shared/rules/held.ts";
import { useRoomView } from "../../state/view.ts";
import { liveGroundOf } from "./liveGround.ts";

/*
 * Areas through openings (docs/design/design-v1-floors.md phase 4, 9.2): an
 * area reaches the floor just above or below its own through each opening
 * whose two floors players see, vision on or off. That gate reads only what
 * every player holds (rules/floors.ts playersSee: a blackout, the floors
 * reached), so the DM's rows, a player's device and a group save page all
 * agree on which floors an area reaches. The reach itself is the DM's call:
 * no rule of the server's reads it, and walk costs, trap areas and
 * reminders stay on the area's floor.
 *
 * This file reads the whole copy, every floor it holds, not the floor cut
 * the board reads (canvas/floorViewReads.test.ts lists it): the creatures
 * the reach catches stand on another floor. A player's copy holds an end
 * only outside full fog, and its far floor (`to`, `rise`) only while the
 * player holds that floor, so a device reaches only through openings it
 * was sent.
 */

const NONE: readonly AreaThrough[] = [];

/**
 * The floors an area on `sceneId` reaches, one entry for each opening's end
 * there, in id order: its squares and the height the floor across adds to
 * a creature's elevation, minus the floors' separation for the floor below
 * (an upper end) and plus it for the floor above (a lower end). The
 * separation is the climb's height (rules/floorLinks.ts linkHeight, a
 * player's end's `rise`), never the grounds' difference, which would count
 * the ground twice (D-261119-109). Floors of another grid shape share no
 * squares, so they join none.
 */
export function openingsFrom(view: RoomState, sceneId: SceneId): readonly AreaThrough[] {
  const scene = ownEntry(view.scenes, sceneId);
  if (!scene || view.floorLinks === undefined || !playersSee(view, sceneId)) return NONE;
  const out: AreaThrough[] = [];
  for (const end of linksOn(view, sceneId) as (LinkEnd & { rise?: number; hidden?: true })[]) {
    if (end.kind !== "opening" || end.hidden === true || end.to === undefined) continue;
    const other = ownEntry(view.scenes, end.to);
    if (!other || (other.gridShape ?? "squares") !== (scene.gridShape ?? "squares") || !playersSee(view, end.to)) continue;
    const dir = linkDir(view, end);
    if (dir === null) continue;
    const rise = linkHeight(view, end);
    out.push({ sceneId: end.to, rect: end.rect, dz: dir === "down" ? -rise : rise });
  }
  return out.length > 0 ? out : NONE;
}

/**
 * A group save page's floors (D-261119-110): the area's own, then each
 * floor an opening joins to it by the gate, read as the page starts.
 */
export function pageFloors(view: RoomState, sceneId: SceneId): SceneId[] {
  return [...new Set([sceneId, ...openingsFrom(view, sceneId).map((j) => j.sceneId)])];
}

/**
 * What an area's caught list reads across its openings (coverage.ts
 * caughtTokens): the openings, the creatures the copy holds on the floors
 * across them, and on a player's device each such floor's live ground,
 * null where all of it is live (fog off) and for the DM.
 */
export type ThroughInputs = { list: readonly AreaThrough[]; tokens: readonly Token[]; grounds: ReadonlyMap<SceneId, Ground | null> };

export function throughInputs(view: RoomState, sceneId: SceneId, role: "dm" | "player"): ThroughInputs | undefined {
  const list = openingsFrom(view, sceneId);
  if (list.length === 0) return undefined;
  const floors = new Set(list.map((j) => j.sceneId));
  const tokens = Object.values(view.tokens).filter((t): t is Token => t !== undefined && floors.has(t.sceneId));
  const fogTiles: Readonly<Record<string, FogTile>> = view.fogTiles ?? {};
  const sight: Readonly<Record<string, SightTile>> = sightOf(view) ?? {};
  const grounds = new Map<SceneId, Ground | null>();
  for (const floor of floors) grounds.set(floor, liveGroundOf({ scene: ownEntry(view.scenes, floor), role, fogTiles, sight }));
  return { list, tokens, grounds };
}

/**
 * `throughInputs` for each area's floor from the room as this device holds
 * it, kept while the copy is: one answer a floor, so the caught lists'
 * caches hold across renders.
 */
export function useAreaThrough(role: "dm" | "player"): (sceneId: SceneId) => ThroughInputs | undefined {
  const view = useRoomView((s) => s.view);
  // Only what the gate, the creatures and the live grounds read: a chat line or a roll keeps every answer.
  const parts = [view?.scenes, view?.floorLinks, view?.tokens, view?.characters, view?.meta, view?.openFloors, view?.fogTiles, view ? sightOf(view) : undefined];
  return useMemo(() => {
    const kept = new Map<SceneId, ThroughInputs | undefined>();
    return (sceneId: SceneId) => {
      if (!view) return undefined;
      if (!kept.has(sceneId)) kept.set(sceneId, throughInputs(view, sceneId, role));
      return kept.get(sceneId);
    };
  }, [...parts, role]); // eslint-disable-line react-hooks/exhaustive-deps
}
