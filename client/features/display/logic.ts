import type { RoomState, Token } from "#shared/model.ts";
import { fitRect, type Camera, type Rect, type Size } from "../../lib/camera.ts";
import { drawnHeights, isometric, K, TOP_DOWN, toView, toWorld, viewBox, type DrawnHeights, type Turn, type View, type ViewBox, type ViewPoint } from "../../lib/view.ts";
import { fitTarget } from "../../lib/fitTarget.ts";
import type { FogMask } from "../../lib/fogTiles.ts";
import { footprint } from "../../lib/scene.ts";
import type { Ended } from "../../state/types.ts";

/**
 * A table display's rules (docs/design-v1-dm-tools.md 3.1), as pure
 * functions: the pairing code as people type it, the two camera modes, what
 * a tap does, and how a handout's pages step. The display's pages draw from
 * these.
 */

// ---------------------------------------------------------------- codes

/** Crockford's alphabet, as the server mints codes (server/auth/displaySessions.ts). */
const CODE = /^[0-9A-HJKMNP-TV-Z]{10}$/;

/**
 * The code as the server reads it, or null when it cannot be one. The DM's
 * screen groups it for typing with a remote ("K7QH 2MXA 4F"), so spaces and
 * hyphens go, any case is fine, and I and L read as 1 and O as 0, as the
 * server decodes them.
 */
export function normalizeDisplayCode(input: string): string | null {
  if (input.length > 40) return null;
  const code = input.replace(/[\s-]/g, "").toUpperCase().replace(/[IL]/g, "1").replaceAll("O", "0");
  return CODE.test(code) ? code : null;
}

/** "K7QH 2MXA 4F": groups of four, as the DM's screen shows it and a TV's field echoes it. */
export function formatDisplayCode(code: string): string {
  return code.replace(/[\s-]/g, "").toUpperCase().replace(/(.{4})(?=.)/g, "$1 ");
}

/** The code a "Open on this device" link carries in its fragment (`/display#code=...`), or null. */
export function codeFromHash(hash: string): string | null {
  const m = /(?:^#|&)code=([^&]*)/.exec(hash);
  if (!m) return null;
  try {
    return normalizeDisplayCode(decodeURIComponent(m[1]!));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the camera

/** How the display's camera moves, chosen on the display and kept on the device. */
export type DisplayMode = "follow" | "fit";

/**
 * A DM device's visible map area: its center and size, in cells (the `view`
 * event). An Isometric DM's adds its turn and its canvas's size in view
 * units (docs/design-v1-isometric-view.md ISO-D17).
 */
export type ViewRect = { x: number; y: number; w: number; h: number; iso?: { turn: number; vw: number; vh: number } };

/**
 * Follow the DM: the area a DM device sees, fitted to this screen, so a TV
 * shows the same area as the DM's phone, not the same pixels per cell. The
 * whole area stays in view: a narrow phone's view on a wide TV shows more
 * on each side.
 *
 * In the display's own view (`shown`, ISO-D16). A display in Isometric at
 * an Isometric DM's turn frames the DM's view rectangle exactly. Any other
 * fits the world box followGround gives through its own projection, its
 * top raised by the highest ground it has seen inside (`seen`, 4.2).
 */
export function followCamera(viewport: Size, view: ViewRect, shown: View = TOP_DOWN, seen: DrawnHeights | null = null): Camera {
  if (view.iso && shown.kind === "isometric" && shown.turn === view.iso.turn) {
    const mid = toView(shown, { x: view.x, y: view.y });
    return fitRect(viewport, { x: mid.x - view.iso.vw / 2, y: mid.y - view.iso.vh / 2, width: view.iso.vw, height: view.iso.vh } as ViewBox, 0);
  }
  const ground = followGround(view, seen);
  return fitRect(viewport, viewBox(shown, ground, shown.kind === "isometric" && seen ? highestIn(seen, ground) : 0), 0);
}

/**
 * The heights a display may see, whatever its zoom (4.2): the ground under
 * its shared fog where the scene has fog, every height read through it
 * (lib/view.ts drawnHeights), so a fit never shows terrain the players
 * have not seen.
 */
export function displaySeen(input: { room: Pick<RoomState, "buildChunks" | "fogTiles" | "meta">; scene: { id: string; bounds: { w: number; h: number } }; fog: boolean }): DrawnHeights {
  const { room, scene } = input;
  return drawnHeights({ chunks: room.buildChunks, sceneId: scene.id, bounds: scene.bounds, fog: input.fog ? room.fogTiles : null, stand: true }, room.meta.settings.feetPerCell);
}

/**
 * The world box a display fits to follow the DM (4.2): the DM's area, and
 * for an Isometric DM the ground at 0 under its view rectangle, grown by
 * every raised cell of the display's own seen ground (`seen`, its shared
 * fog's heights) whose full projected bounds at the DM's turn meet the
 * rectangle. A column's top reaches up the screen K a cell of height, so
 * one whose ground lies below the rectangle can still show in it: the
 * search covers the rectangle grown downward by K times the highest seen
 * height. It reads only the DM's camera and the display's seen ground, so
 * hidden terrain changes neither the event nor the fit.
 */
export function followGround(view: ViewRect, seen: DrawnHeights | null): Rect {
  if (!view.iso) return { x: view.x - view.w / 2, y: view.y - view.h / 2, width: view.w, height: view.h };
  const dm = isometric((view.iso.turn % 4) as Turn);
  const mid = toView(dm, { x: view.x, y: view.y });
  const r = { x0: mid.x - view.iso.vw / 2, x1: mid.x + view.iso.vw / 2, y0: mid.y - view.iso.vh / 2, y1: mid.y + view.iso.vh / 2 };
  const boxOf = (y1: number) => worldBox([toWorld(dm, at(r.x0, r.y0)), toWorld(dm, at(r.x1, r.y0)), toWorld(dm, at(r.x0, y1)), toWorld(dm, at(r.x1, y1))]);
  let box = boxOf(r.y1);
  if (!seen || seen.high <= 0) return rect(box);
  const search = boxOf(r.y1 + K * seen.high);
  const { w, h } = seen.bounds;
  for (let y = Math.max(0, Math.floor(search.y0)); y < Math.min(h, Math.ceil(search.y1)); y++) {
    for (let x = Math.max(0, Math.floor(search.x0)); x < Math.min(w, Math.ceil(search.x1)); x++) {
      const g = seen.at(x, y);
      if (g <= 0) continue;
      const corners = [toView(dm, { x, y }), toView(dm, { x: x + 1, y }), toView(dm, { x, y: y + 1 }), toView(dm, { x: x + 1, y: y + 1 })];
      const vx0 = Math.min(...corners.map((c) => c.x));
      const vx1 = Math.max(...corners.map((c) => c.x));
      const vy0 = Math.min(...corners.map((c) => c.y)) - K * g;
      const vy1 = Math.max(...corners.map((c) => c.y));
      if (vx1 < r.x0 || vx0 > r.x1 || vy1 < r.y0 || vy0 > r.y1) continue;
      box = { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x + 1), y1: Math.max(box.y1, y + 1) };
    }
  }
  return rect(box);
}

const at = (x: number, y: number) => ({ x, y }) as ViewPoint;

function worldBox(points: readonly { x: number; y: number }[]): { x0: number; y0: number; x1: number; y1: number } {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function rect(b: { x0: number; y0: number; x1: number; y1: number }): Rect {
  return { x: b.x0, y: b.y0, width: b.x1 - b.x0, height: b.y1 - b.y0 };
}

/** The highest seen ground inside a world box, in cells, at least 0. */
function highestIn(seen: DrawnHeights, box: Rect): number {
  let top = 0;
  const { w, h } = seen.bounds;
  for (let y = Math.max(0, Math.floor(box.y)); y < Math.min(h, Math.ceil(box.y + box.height)); y++) {
    for (let x = Math.max(0, Math.floor(box.x)); x < Math.min(w, Math.ceil(box.x + box.width)); x++) top = Math.max(top, seen.at(x, y));
  }
  return top;
}

/**
 * Fit the map: what players can see, the revealed ground under fog (a
 * vision scene's explored layer is already merged into a player's fog) and
 * the party's tokens on the scene, since a display owns none. With fog off,
 * the whole scene. The party is the derived `party` flag every player-class
 * projection of a token carries.
 */
export function fitMapTarget(input: {
  bounds: { w: number; h: number };
  revealed: FogMask | null;
  tokens: Iterable<(Pick<Token, "sceneId" | "x" | "y" | "size" | "w" | "h"> & { party?: true }) | undefined>;
  sceneId: string;
}): Rect {
  const party: Rect[] = [];
  for (const t of input.tokens) {
    if (!t || t.sceneId !== input.sceneId || t.party !== true) continue;
    const fp = footprint(t);
    party.push({ x: t.x, y: t.y, width: fp.w, height: fp.h });
  }
  return fitTarget({ bounds: input.bounds, revealed: input.revealed, own: party });
}

export function sameRect(a: Rect | null, b: Rect | null): boolean {
  return a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height);
}

/** Fit the map refits at most this often, so a reveal brings the new room into view without the TV jumping on every brush stroke. */
export const REFIT_MS = 2_000;

/**
 * When a changed fit target is applied: at once if the last fit was long
 * enough ago, else when REFIT_MS have passed since it. Null when there is
 * nothing new to fit.
 */
export function refitAt(input: { target: Rect; applied: Rect | null; appliedAt: number; now: number }): number | null {
  if (sameRect(input.target, input.applied)) return null;
  if (input.applied === null) return input.now;
  return Math.max(input.now, input.appliedAt + REFIT_MS);
}

// ---------------------------------------------------------------- taps

/** What covers the map that a tap closes first: a handout shown to everyone, or the X-card. */
export type Overlay = "handout" | "xcard" | null;

/**
 * A handout of two or more pages on the display (docs/design-v1-pdf-handouts.md
 * 7): how many pages it has, the one showing, counted from 0, and whether its
 * bar of Previous page, Next page and Close shows.
 */
export type DisplayPaging = { pages: number; page: number; bar: boolean };

export type DisplayAction =
  | "closeOverlay"
  | "openMenu"
  | "closeMenu"
  | "menuKey"
  | "nextPage"
  | "previousPage"
  | "openBar"
  | "hideBar"
  /** An arrow while the bar shows: focus moves to the bar's next or previous button. */
  | "barFocusNext"
  | "barFocusPrevious"
  /** Any other key while the bar shows. It keeps the bar up, and Enter or Space presses the button with focus. */
  | "barKey"
  /** A page key at the end it steps toward. */
  | "none";

/**
 * What a tap, a click or a key does on the display. `key` is the key's name,
 * or null for a tap or a click. A handout or the X-card closes and nothing
 * else happens, so the next tap opens the menu. Without them a tap shows
 * the menu, or hides it when it shows. A key while the menu shows belongs
 * to the menu (a remote's arrows and OK).
 *
 * A handout of pages answers for itself (`paging`): the page keys step,
 * Escape closes it, and any other key, a tap or a click shows its bar.
 * While the bar shows, a tap hides it, the arrows move between its
 * buttons, PageUp and PageDown still step, and Escape hides the bar before
 * a second one closes the handout. The X-card over it still closes first.
 */
export function displayPress(input: { overlay: Overlay; menu: boolean; key: string | null; paging?: DisplayPaging | null }): DisplayAction {
  if (input.overlay === "handout" && input.paging && input.paging.pages > 1) return pagingPress(input.paging, input.key);
  if (input.overlay) return "closeOverlay";
  if (input.menu) return input.key !== null ? "menuKey" : "closeMenu";
  return "openMenu";
}

function pagingPress(paging: DisplayPaging, key: string | null): DisplayAction {
  if (key === null) return paging.bar ? "hideBar" : "openBar";
  if (key === "Escape") return paging.bar ? "hideBar" : "closeOverlay";
  const by = pageKey(key);
  if (by === 0) return paging.bar ? "barKey" : "openBar";
  // While the bar shows, the arrows are its own, as a remote's arrows are the menu's.
  if (paging.bar && key.startsWith("Arrow")) return by > 0 ? "barFocusNext" : "barFocusPrevious";
  if (stepPage(paging.page, paging.pages, by) === paging.page) return "none";
  return by > 0 ? "nextPage" : "previousPage";
}

/** Which way a key steps a handout's pages: 1 to the next, -1 to the one before, 0 for any other key. */
function pageKey(key: string): 1 | -1 | 0 {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
    case "PageDown":
      return 1;
    case "ArrowLeft":
    case "ArrowUp":
    case "PageUp":
      return -1;
    default:
      return 0;
  }
}

/** The page `by` steps to from `page`, stopping at the first and the last. */
export function stepPage(page: number, pages: number, by: number): number {
  return Math.max(0, Math.min(pages - 1, page + by));
}

/** "Page 2 of 5", the line under a handout's title. */
export function pageLine(page: number, pages: number): string {
  return `Page ${page + 1} of ${pages}`;
}

/** The bar's buttons, in their order on screen. */
export const BAR_BUTTONS = ["previous", "next", "close"] as const;
export type BarButton = (typeof BAR_BUTTONS)[number];

/** The buttons that work on this page: Previous page is disabled on the first, and Next page on the last. */
export function barEnabled(page: number, pages: number): BarButton[] {
  return BAR_BUTTONS.filter((b) => (b === "previous" ? page > 0 : b === "next" ? page < pages - 1 : true));
}

/**
 * Where focus goes when a key opens the bar: Next page, or Close on the
 * last page. The menu's rule, its first button, would land on Previous
 * page, which is disabled on page 1.
 */
export function barFirstFocus(page: number, pages: number): BarButton {
  return page < pages - 1 ? "next" : "close";
}

/**
 * Where an arrow moves focus among the bar's enabled buttons, around the
 * ends as in the menu. With focus outside the bar, as after a tap opened
 * it, the first arrow goes where a key opening the bar would have put it.
 */
export function barMove(page: number, pages: number, focused: BarButton | null, by: 1 | -1): BarButton {
  const enabled = barEnabled(page, pages);
  const at = focused === null ? -1 : enabled.indexOf(focused);
  if (at < 0) return barFirstFocus(page, pages);
  return enabled[(at + by + enabled.length) % enabled.length] ?? barFirstFocus(page, pages);
}

/**
 * Where focus goes after the page changes, when the page button holding it
 * is now disabled: to the other page button, as the handout viewer hands it
 * on. Never to Close, or OK pressed again and again to page through would
 * close the handout at the end. Null when focus can stay.
 */
export function barFocusAfter(focused: BarButton | null, page: number, pages: number): BarButton | null {
  if (focused === "next" && page >= pages - 1) return page > 0 ? "previous" : "close";
  if (focused === "previous" && page <= 0) return pages > 1 ? "next" : "close";
  return null;
}

/** Where a picture of `size` draws in `box` when fitted whole and centered, as `object-fit: contain` draws it. */
export function containRect(box: Size, size: Size): Rect {
  if (box.width <= 0 || box.height <= 0 || size.width <= 0 || size.height <= 0) return { x: 0, y: 0, width: box.width, height: box.height };
  const scale = Math.min(box.width / size.width, box.height / size.height);
  const width = size.width * scale;
  const height = size.height * scale;
  return { x: (box.width - width) / 2, y: (box.height - height) / 2, width, height };
}

/** The menu, and a handout's bar, hide this long after their last use. */
export const MENU_MS = 5_000;

/** "Turn: Thorn": whose turn, when the room is in a fight and the display may see who acts. */
export function turnText(input: { encounter: RoomState["encounter"]; tokens: RoomState["tokens"]; characters: RoomState["characters"] }): string | null {
  const e = input.encounter;
  if (!e || e.activeEntryId === null) return null;
  const row = e.entries.find((r) => r.id === e.activeEntryId);
  if (!row) return null;
  const token = row.tokenId !== undefined ? input.tokens[row.tokenId] : undefined;
  const name = token ? (token.number === undefined ? token.name : `${token.name} ${token.number}`) : row.characterId !== undefined ? input.characters[row.characterId]?.name : row.label;
  return name ? `Turn: ${name}` : null;
}

// ---------------------------------------------------------------- the end

/**
 * What the display says when its room closes it for good. `movedTo` is the
 * room this browser shows as a display now, when that is another room: a
 * display shows one room, so pairing it again from another tab or window
 * signs it out here (server/http/display.ts), and that is no sign-out by the
 * DM or a new password.
 */
export function endedText(kind: Ended["kind"], movedTo: string | null): { title: string; body: string } {
  if (kind === "deleted") return { title: "This room was deleted", body: "There is nothing left to show here." };
  if (kind === "denied") return { title: "The room refused this display", body: "Set it up again with a new code from the DM." };
  if (movedTo !== null) {
    return {
      title: "This display now shows another room",
      body: "It was set up for another room in another tab or window, and a display shows one room at a time. To show this room here again, the DM makes a new code.",
    };
  }
  return { title: "This display was signed out", body: "The DM signed it out, or the player password changed. Set it up again with a new code from the DM." };
}
