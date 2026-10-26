import type { JournalPage, Member, Pin } from "#shared/model.ts";
import { MAX_NAME, type PinInput } from "#shared/protocol.ts";
import { viewToScreen, type Camera, type Point } from "../../lib/camera.ts";
import { TOP_DOWN, toView } from "../../lib/view.ts";
import { TAP_SLOP_PX } from "../../lib/gestures.ts";
import type { OpAnswer, OpRefusal } from "../../state/types.ts";
import { cleanLabelText } from "../builder/labelEdit.ts";

/**
 * Map pins on this side (docs/design-v1-dm-tools.md 3.8): the marker's
 * shape and its tap target, what a tap with the Pin tool does, who will see
 * a pin, and the pane's draft with its one safety rule. Plain functions, so
 * they run under node --test.
 */

/** The marker's height on screen, tip to top, at any zoom. */
export const PIN_HEIGHT_PX = 28;
const HEAD_RADIUS_PX = 9;
/** From the tip up to the head's center. */
export const HEAD_CENTER_PX = PIN_HEIGHT_PX - HEAD_RADIUS_PX;
/** The marker answers a finger within this much of its middle: a 44 px target around a 28 px marker. */
const HIT_RADIUS_PX = 22;
/** A pin's label shows under it from this zoom up, where it reads as part of the map rather than clutter. */
export const LABEL_MIN_CELL_PX = 24;

/**
 * The marker's outline in screen pixels, the tip at the origin: a round
 * head over a point, as one closed line so its outline has no seam.
 */
export function pinOutline(steps = 20): number[] {
  const r = HEAD_RADIUS_PX;
  const h = HEAD_CENTER_PX;
  // The two points where lines from the tip touch the head.
  const alpha = Math.acos(r / h);
  const start = Math.PI / 2 + alpha;
  const sweep = 2 * Math.PI - 2 * alpha;
  const points: number[] = [];
  for (let i = 0; i <= steps; i++) {
    const a = start + (sweep * i) / steps;
    points.push(Math.round(r * Math.cos(a) * 100) / 100, Math.round((-h + r * Math.sin(a)) * 100) / 100);
  }
  points.push(0, 0);
  return points;
}

/** The pin under a screen point, the nearest when two overlap, or null. Pins are drawn at a fixed screen size, so this works in pixels. */
export function pinAt<P extends Pick<Pin, "id" | "x" | "y">>(pins: readonly P[], camera: Camera, screen: Point): P | null {
  let best: P | null = null;
  let bestDist = HIT_RADIUS_PX;
  for (const pin of pins) {
    const tip = viewToScreen(camera, toView(TOP_DOWN, pin));
    const d = Math.hypot(screen.x - tip.x, screen.y - (tip.y - PIN_HEIGHT_PX / 2));
    if (d <= bestDist) {
      best = pin;
      bestDist = d;
    }
  }
  return best;
}

/**
 * The pin of a scene under a screen point, as a tap with the Select tool
 * finds it (PinLayer.tsx useTapPin), or null. The height readout yields to
 * it, since the pin answers that tap itself.
 */
export function pinUnder(view: { pins: Readonly<Record<string, Pin | undefined>> } | null, sceneId: string, camera: Camera, screen: Point): Pin | null {
  if (!view) return null;
  const pins = Object.values(view.pins).filter((pin): pin is Pin => !!pin && pin.sceneId === sceneId);
  return pinAt(pins, camera, screen);
}

/**
 * Whether a lifted press is a tap on a pin with the Select tool: one finger
 * that lifts within the tap slop of where it landed, so a pan or a pinch
 * that starts on a pin does nothing, and one not held until the
 * hold-to-ping fired (features/pings/hold.ts), so a ping on a pin does not
 * open it.
 */
export function pinTapCounts(input: { start: Point; end: Point; several: boolean; held: boolean }): boolean {
  if (input.several || input.held) return false;
  return Math.hypot(input.end.x - input.start.x, input.end.y - input.start.y) <= TAP_SLOP_PX;
}

/** The marker's box on screen, for placing the pane beside it. */
export function pinScreenBox(pin: Pick<Pin, "x" | "y">, camera: Camera): { x0: number; y0: number; x1: number; y1: number } {
  const tip = viewToScreen(camera, toView(TOP_DOWN, pin));
  return { x0: tip.x - HEAD_RADIUS_PX, y0: tip.y - PIN_HEIGHT_PX, x1: tip.x + HEAD_RADIUS_PX, y1: tip.y };
}

export type PinToolTap =
  /** "Pin to the map" waits for this tap: place the pin linked to its page. */
  | { kind: "placeLinked"; pageId: string }
  | { kind: "open"; pinId: string }
  /** A tap away from the open pane closes it, placing nothing, as a label's pane does. */
  | { kind: "close" }
  | { kind: "place" };

/** What a tap with the Pin tool does. */
export function pinToolTap(input: { placing: { pageId: string } | null; hit: string | null; paneOpen: boolean }): PinToolTap {
  if (input.placing) return { kind: "placeLinked", pageId: input.placing.pageId };
  if (input.hit !== null) return { kind: "open", pinId: input.hit };
  return input.paneOpen ? { kind: "close" } : { kind: "place" };
}

type Pages = Readonly<Record<string, Pick<JournalPage, "title" | "access">>>;
type Members = Readonly<Record<string, Pick<Member, "name">>>;

/**
 * Who will see a pin, by the projection's rule (shared/project.ts): no one
 * but the DM when it is DM only or its page is, every player when it links
 * no page or a page for everyone, and otherwise the player its page is for.
 * The fog and the scene can still hide it, which the pane says apart.
 */
export function pinAudience(pin: { visibility: Pin["visibility"]; pageId: string | null }, pages: Pages, members: Members): string {
  if (pin.visibility === "dm") return "Only the DM";
  if (pin.pageId === null) return "Every player";
  const page = pages[pin.pageId];
  if (!page || page.access === "dm") return "Only the DM";
  if (page.access === "all") return "Every player";
  return `Players who can read ${page.title}: ${members[page.access.member]?.name ?? "a player"}`;
}

export type PinDraft = {
  label: string;
  pageId: string | null;
  color: string;
  dmOnly: boolean;
  /**
   * Why DM only was turned on for the DM rather than by them, so the pane
   * names the real reason: a change away from a restricted page (withPage),
   * or the linked page's deletion on another device (withPageGone).
   */
  autoDmOnly: false | "restricted" | "deleted";
};

export function pinDraftOf(pin: Pin): PinDraft {
  return { label: pin.label ?? "", pageId: pin.pageId ?? null, color: pin.color, dmOnly: pin.visibility === "dm", autoDmOnly: false };
}

/**
 * The draft with its linked page changed. A pin linked to a page that is
 * DM only or private to one player reaches at most that page's readers, so
 * dropping that link, or moving it to another page, could show the pin to
 * people who never saw it. Such a change turns DM only on in the same save,
 * and the DM can turn it off again before saving. Going back to the stored
 * page undoes what this did.
 */
export function withPage(stored: Pick<Pin, "pageId" | "visibility">, draft: PinDraft, pageId: string | null, pages: Pages): PinDraft {
  const old = stored.pageId === undefined ? undefined : pages[stored.pageId];
  const restricted = old !== undefined && old.access !== "all";
  const leaving = pageId !== (stored.pageId ?? null);
  if (leaving && restricted && !draft.dmOnly) return { ...draft, pageId, dmOnly: true, autoDmOnly: "restricted" };
  if (!leaving && draft.autoDmOnly === "restricted") return { ...draft, pageId, dmOnly: stored.visibility === "dm", autoDmOnly: false };
  return { ...draft, pageId };
}

/**
 * The draft once its linked page is gone, deleted on another DM device
 * while the pane was open. The deletion unlinked the stored pin and made it
 * DM only (shared/reducer/journal.ts), so the draft takes that state and
 * keeps the label and color typed. Otherwise the page picker would show "No
 * page" while the draft still named the deleted page, Done would be refused,
 * and a save made by picking around it would publish a pin the deletion had
 * hidden (LP5-NOTES-1). A draft whose page still exists comes back as it was.
 * The deletion hides the pin whatever the page's access, so the reason is
 * the deletion, and a draft the DM had already made DM only names none.
 */
export function withPageGone(draft: PinDraft, pages: Readonly<Record<string, unknown>>): PinDraft {
  if (draft.pageId === null || pages[draft.pageId] !== undefined) return draft;
  const turnedOn = !draft.dmOnly || draft.autoDmOnly !== false;
  return { ...draft, pageId: null, dmOnly: true, autoDmOnly: turnedOn ? "deleted" : false };
}

export function withDmOnly(draft: PinDraft, dmOnly: boolean): PinDraft {
  return { ...draft, dmOnly, autoDmOnly: false };
}

export type PinCommit = { kind: "put"; pin: PinInput } | { kind: "unchanged" } | { kind: "tooLong" };

/** What Done sends: the pin as it stands now (a drag may have moved it since the pane opened) with the draft's fields. */
export function pinCommit(stored: Pin, draft: PinDraft): PinCommit {
  const label = cleanLabelText(draft.label);
  if (label.length > MAX_NAME) return { kind: "tooLong" };
  const pin: PinInput = { id: stored.id, sceneId: stored.sceneId, x: stored.x, y: stored.y, color: draft.color, visibility: draft.dmOnly ? "dm" : "all" };
  if (label !== "") pin.label = label;
  if (draft.pageId !== null) pin.pageId = draft.pageId;
  const same = pin.label === stored.label && pin.pageId === stored.pageId && pin.color === stored.color && pin.visibility === stored.visibility;
  return same ? { kind: "unchanged" } : { kind: "put", pin };
}

/** What the pane does once the server has answered its Done. */
export type PinSaveAnswer = { kind: "closed" } | { kind: "kept"; problem: string };

/**
 * The pane closes only once the server has taken the pin. A refused put
 * snaps the pin back on the map, so closing at once would drop what was
 * typed. A refusal, or an answer lost with the connection, keeps the pane
 * open with its draft and the reason.
 */
export function pinSaveAnswer(answer: OpAnswer, refusal?: OpRefusal): PinSaveAnswer {
  if (answer === "taken") return { kind: "closed" };
  if (answer === "unknown") return { kind: "kept", problem: "The connection dropped before the server answered, so this pin may not be saved. Your changes are still here. Tap Done to save them again." };
  if (refusal?.code === "gone") return { kind: "kept", problem: "Not saved. The page it links to was deleted while you edited. Pick another page, or none." };
  return { kind: "kept", problem: refusal?.text ?? "Not saved. Your changes are still here." };
}

/** A pin players can never receive, which the DM's map draws faded: DM only, or linked to a page only the DM reads. */
export function dmOnlyPin(pin: Pick<Pin, "visibility" | "pageId">, pages: Readonly<Record<string, Pick<JournalPage, "access">>>): boolean {
  if (pin.visibility === "dm") return true;
  return pin.pageId !== undefined && pages[pin.pageId]?.access === "dm";
}
