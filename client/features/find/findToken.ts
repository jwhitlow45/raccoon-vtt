import type { MemberId, RoomState, SceneId, Token } from "#shared/model.ts";
import { cameraAt, fitRect, type Camera, type Insets, type Rect, type Size } from "../../lib/camera.ts";
import { TOP_DOWN, toView, viewBox, type View, type ViewBox } from "../../lib/view.ts";
import { footprint } from "../../lib/scene.ts";
import { liftIn, tokenBase, type BoardPick } from "../../canvas/boardPick.ts";
import type { FootprintToken } from "#shared/rules/footprint.ts";
import { ownsToken } from "../tokens/access.ts";

/**
 * "Find my token" (features section 5): a player's top bar button that
 * brings their own token into view, for a phone zoomed into the far corner
 * of a big map or a player who lost track of which token is theirs. Each
 * press goes on to the next token they own on the scene, so a player with a
 * familiar or a summoned creature reaches each in turn.
 */

/** Cells of room around a found token on each side, enough to see what stands next to it. */
export const FIND_ROOM_CELLS = 4;

const KIND_ORDER: Record<Token["kind"], number> = { pc: 0, npc: 1, monster: 1, object: 2 };

/**
 * The token a press finds: the next one this member owns on the scene after
 * the one found last, wrapping round. Player characters come first, then
 * other creatures, then objects, each in the order they were made (token
 * ids are UUIDv7). Ownership counts through a character, as on the server.
 * Null when they own none there.
 */
export function nextOwnToken(input: {
  view: Pick<RoomState, "tokens" | "characters">;
  sceneId: SceneId;
  memberId: MemberId;
  lastId: string | null;
}): Token | null {
  const own = Object.values(input.view.tokens)
    .filter((t) => t.sceneId === input.sceneId && ownsToken(input.view, input.memberId, t))
    .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (own.length === 0) return null;
  const last = own.findIndex((t) => t.id === input.lastId);
  return own[(last + 1) % own.length] ?? null;
}

/** What the camera fits for a found token: its footprint with room around it, so a press both pans and zooms. */
export function findRect(token: Pick<Token, "x" | "y" | "size" | "w" | "h">): Rect {
  const fp = footprint(token);
  return {
    x: token.x - FIND_ROOM_CELLS,
    y: token.y - FIND_ROOM_CELLS,
    width: fp.w + FIND_ROOM_CELLS * 2,
    height: fp.h + FIND_ROOM_CELLS * 2,
  };
}

/**
 * The camera for a found token: zoomed so the token and the room around it
 * fit between the bars, and the token centered in the part of the map a
 * phone's open sheet and the docked token action bar leave in view
 * (`cover`, past the bars, the larger of the two on each side,
 * canvas/barDock.ts barCover). The zoom ignores the cover, so a press with
 * the Log open shows the token as large as one without, with some of its
 * surroundings under the sheet. In the view the board shows
 * (docs/design-v1-isometric-view.md 4.2). A given `zoom` keeps that scale
 * and only centers.
 */
export function findCamera(viewport: Size, target: Rect, bars: Insets, cover: Insets, frame: FindFrame = FLAT_FRAME, zoom?: number): Camera {
  const { view } = frame;
  const middle = toView(view, { x: target.x + target.width / 2, y: target.y + target.height / 2 }, frame.z);
  // The box as the board draws it, grown evenly round the middle, which centers: a ring raised over the box's middle or down in a pit still leaves all of it in view.
  const box = viewBox(view, target, frame.lift);
  const hw = Math.max(middle.x - box.x, box.x + box.width - middle.x);
  const hh = Math.max(middle.y - box.y, box.y + box.height - middle.y);
  const scale = zoom ?? fitRect(viewport, { x: middle.x - hw, y: middle.y - hh, width: 2 * hw, height: 2 * hh } as ViewBox, 24, bars).scale;
  const left = bars.left + cover.left;
  const right = bars.right + cover.right;
  const top = bars.top + cover.top;
  const bottom = bars.bottom + cover.bottom;
  // A sheet that leaves no map at all (a very short landscape screen) cannot be kept clear of.
  const clear = viewport.width - left - right > 0 && viewport.height - top - bottom > 0;
  const cx = clear ? left + (viewport.width - left - right) / 2 : bars.left + (viewport.width - bars.left - bars.right) / 2;
  const cy = clear ? top + (viewport.height - top - bottom) / 2 : bars.top + (viewport.height - bars.top - bars.bottom) / 2;
  return cameraAt({ x: cx, y: cy }, middle, scale);
}

/**
 * How the board shows a found target, in cells of height: the view, the
 * highest drawn ground in its box, which raises the box's top as a fit's
 * does, and the height its middle draws at (a token's ring, or the ground
 * under an outline row's box), each from this viewer's drawn heights
 * (docs/design-v1-isometric-view.md 4.2).
 */
export type FindFrame = { view: View; lift: number; z: number };

const FLAT_FRAME: FindFrame = { view: TOP_DOWN, lift: 0, z: 0 };

/**
 * The camera that finds a token, its ring centered where it draws at the
 * zoom the fit picks (findCamera). A standee's lift is capped by the zoom
 * (relief/standee.ts cappedBase), so the fit runs on its uncapped base,
 * and its ring's base at the fitted zoom then centers at that zoom, as a
 * scene's fit reads its lift again at the zoom it found (Stage.tsx
 * fitScene). Outline rows for tokens share it.
 */
export function findTokenCamera(viewport: Size, target: Rect, bars: Insets, cover: Insets, pick: BoardPick, token: FootprintToken): Camera {
  const uncapped = tokenBase({ ...pick, canvasHeight: Infinity }, token);
  const fitted = findCamera(viewport, target, bars, cover, frameOf(pick, target, uncapped));
  const z = tokenBase({ ...pick, camera: fitted }, token);
  return z === uncapped ? fitted : findCamera(viewport, target, bars, cover, frameOf(pick, target, z), fitted.scale);
}

/** A target's frame on the board as `pick` shows it, its middle drawn at `z`. */
export function frameOf(pick: Pick<BoardPick, "view" | "heights">, target: Rect, z: number): FindFrame {
  return { view: pick.view, lift: pick.view.kind === "topDown" ? 0 : liftIn(pick.heights, target), z: pick.view.kind === "topDown" ? 0 : z };
}

/** A phone's open sheet as it stands on screen: at the bottom in portrait, docked on the right in landscape. */
export type OpenSheet = { placement: "bottom" | "right"; width: number; height: number };

/**
 * The part of the map an open sheet covers, on top of the bars: a bottom
 * sheet stands on the toolbar, and a landscape one takes its width on the
 * right. From 900 px up panels dock beside the map and cover none of it.
 */
export function sheetCover(sheet: OpenSheet | null): Insets {
  const none = { top: 0, right: 0, bottom: 0, left: 0 };
  if (sheet?.placement === "bottom") return { ...none, bottom: Math.round(sheet.height) };
  if (sheet?.placement === "right") return { ...none, right: Math.round(sheet.width) };
  return none;
}
