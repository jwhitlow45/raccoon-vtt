import type { RoomState, Token } from "#shared/model.ts";
import { fitRect, type Camera, type Rect, type Size } from "../../lib/camera.ts";
import { fitTarget } from "../../lib/fitTarget.ts";
import type { FogMask } from "../../lib/fogTiles.ts";
import { footprint } from "../../lib/scene.ts";
import type { Ended } from "../../state/types.ts";

/**
 * A table display's rules (docs/design-v1-dm-tools.md 3.1), as pure
 * functions: the pairing code as people type it, the two camera modes, and
 * what a tap does. The display's pages draw from these.
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

/** A DM device's visible map area: its center and size, in cells (the `view` event). */
export type ViewRect = { x: number; y: number; w: number; h: number };

/**
 * Follow the DM: the area a DM device sees, fitted to this screen, so a TV
 * shows the same area as the DM's phone, not the same pixels per cell. The
 * whole area stays in view: a narrow phone's view on a wide TV shows more
 * on each side.
 */
export function followCamera(viewport: Size, view: ViewRect): Camera {
  return fitRect(viewport, { x: view.x - view.w / 2, y: view.y - view.h / 2, width: view.w, height: view.h }, 0);
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
 * What a tap, a click or a key does on the display. A handout or the X-card
 * closes and nothing else happens, so the next tap opens the menu. Without
 * them a tap shows the menu, or hides it when it shows. A key while the
 * menu shows belongs to the menu (a remote's arrows and OK).
 */
export function displayPress(input: { overlay: Overlay; menu: boolean; key: boolean }): "closeOverlay" | "openMenu" | "closeMenu" | "menuKey" {
  if (input.overlay) return "closeOverlay";
  if (input.menu) return input.key ? "menuKey" : "closeMenu";
  return "openMenu";
}

/** The menu hides this long after its last use. */
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
