import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useUiScale } from "../features/device/settings.ts";
import { TAP_SLOP_PX } from "./gestures.ts";
import { REPEAT_DELAY_MS } from "./holdRepeat.ts";
import { theme } from "./theme.ts";

/*
 * Swipe a phone's bottom sheet down to close it, and the panel sheet up to
 * fill the screen (docs/design-v1-sheet-swipe.md). Three layers, each one
 * tested on its own:
 *
 * - SheetSwipe: one touch as a state machine with no DOM, as CameraGesture
 *   is the map's (gestures.ts): where it may start, the claim past the
 *   slop, where the surface stands, and the end on release (4.1 to 4.4).
 * - SwipeSession: a surface's touches over time, with the slide after a
 *   release and what follows it (4.5, 4.7). It acts through a SwipeHost,
 *   so the randomized test drives it with a record of the page.
 * - useSheetSwipe: the host on the DOM, which each surface that swipes
 *   calls, and the small DOM reads it starts from (startsOn, atTop,
 *   slideDistance), written over a node interface so they are tested too.
 *
 * Positions are screen px, the finger's own, below the surface's normal
 * place: 0 at rest, minus `up` when the panel sheet fills the screen.
 */

/** A slow drag closes past this share of the surface's normal height. */
export const SWIPE_SHARE = 1 / 4;
/** A flick, in screen px per ms, down positive. */
export const FLICK_SPEED = 0.5;
/** A flick closes once the surface has travelled this share of the floor (one touch target). */
export const FLICK_TRAVEL = 1 / 2;
/** The finger's speed at the lift is read over its moves in this window. */
export const SPEED_WINDOW_MS = 100;
/** The slide after a release. */
export const SLIDE_MS = 200;
/** A surface holding unsaved input follows the finger at this share below its normal top, a sign that it will not go. */
export const UNSAVED_FOLLOW = 1 / 2;
/** The upward claim waits for twice the slop, so a thumb that drifts up while it taps keeps its tap (4.2). */
export const UP_CLAIM_PX = 2 * TAP_SLOP_PX;
/** Marks a surface's grab area: its header, which moves the surface whatever its content's scroll (4.1, 4.6). */
export const GRAB_ATTR = "data-sheet-grab";
/** On the surface while a swipe moves it: what measures it, such as Room's sheet height, holds still (4.7). */
export const SWIPING_ATTR = "data-sheet-swipe";
/** On the surface during its slide: the position the slide ends at, for the e2e to check what it hides. */
export const SLIDE_TO_ATTR = "data-sheet-swipe-to";
/** Sent on the surface once a swipe is over and it stands at rest again, for whatever held its measure. */
export const SWIPE_REST_EVENT = "rvtt-sheet-swipe-rest";

/** The style that makes a header a grab area: no pan starts there, so every move is the page's to read, and pinch zoom still works where the page allows it. */
export const GRAB_STYLE = { touchAction: "pinch-zoom" } as const;

// ------------------------------------------------------------ one touch

/** Where a touch started (4.1): on a control that owns its touches, on the grab area, or on the content. */
export type SwipeOn = "grab" | "content" | "owned";
export type SwipeStand = "normal" | "full";
export type SwipeEnd = "full" | "normal" | "closed";

export type SwipeStart = {
  on: SwipeOn;
  /** The content was at its top as the touch started (atTop). */
  atTop: boolean;
  /** A field that takes typing inside the surface has focus. */
  typing: boolean;
  /** Fingers on the screen as it started, this one included. */
  fingers: number;
  /** The surface's normal height in screen px, in either stand (4.4). */
  height: number;
  /** The interface size. */
  scale: number;
  at: number;
  stand: SwipeStand;
  /** The travel to full screen in screen px, 0 for a surface that cannot fill it (4.7). */
  up: number;
};

export type SwipeMove = { dx: number; dy: number; at: number; cancelable: boolean };

export type SwipeStep = {
  /** Cancel this move (`preventDefault`), so the browser neither scrolls nor bounces for it. */
  cancel: boolean;
  /** Where to show the surface, or null to leave it be. */
  position: number | null;
  /** This move claimed the touch: cancel the press under the finger, as a browser does when it takes a touch (4.3). */
  press: boolean;
};

type Phase = "idle" | "slop" | "upward" | "claimed" | "free" | "over";

const LEAVE: SwipeStep = { cancel: false, position: null, press: false };

/** One sample of the finger, for its speed at the lift. */
type Sample = { at: number; dy: number };

/**
 * One touch on a surface. `start` says whether it may become a swipe at
 * all. Inside the slop it touches nothing, so a tap stays the browser's.
 * The first move past the slop decides once for the touch: it claims it,
 * or leaves it to the browser for good. The one exception is an upward
 * move in the grab area of a sheet that can fill the screen, which waits
 * until twice the slop (4.2).
 */
export class SheetSwipe {
  phase: Phase = "idle";
  private begun: SwipeStart | null = null;
  private samples: Sample[] = [];
  /** What the claim takes off the finger's travel, so the surface starts from where it stood: the slop down, twice it up. */
  private taken = 0;
  private raw = 0;
  private unsaved = false;
  /** This touch was claimed, so its later moves and its end stay cancelled whatever stops it: one owner per touch. */
  private took = false;
  /** The claim went up, toward full screen. */
  upward = false;

  start(s: SwipeStart): boolean {
    this.begun = s;
    this.samples = [{ at: s.at, dy: 0 }];
    this.unsaved = false;
    this.took = false;
    this.upward = false;
    this.raw = s.stand === "full" ? -s.up : 0;
    const may = s.fingers <= 1 && (s.on === "grab" || (s.on === "content" && s.atTop && !s.typing));
    this.phase = may ? "slop" : "free";
    return may;
  }

  move(m: SwipeMove): SwipeStep {
    const s = this.begun;
    if (!s) return LEAVE;
    if (this.phase === "over") return { cancel: this.took, position: null, press: false };
    if (this.phase !== "slop" && this.phase !== "upward" && this.phase !== "claimed") return LEAVE;
    this.sample(m);
    if (this.phase === "slop") {
      if (Math.hypot(m.dx, m.dy) <= TAP_SLOP_PX) return LEAVE;
      const across = Math.abs(m.dx);
      // A press held still in content is a hold, the browser's: text to select, a stepper to repeat (4.3).
      if (s.on === "content" && m.at - s.at >= REPEAT_DELAY_MS) return this.letGo();
      if (m.dy > 0 && m.dy >= across) return m.cancelable ? this.claim(m, TAP_SLOP_PX, false) : this.letGo();
      if (m.dy < 0 && -m.dy >= across && s.on === "grab" && s.stand === "normal" && s.up > 0) this.phase = "upward";
      else return this.letGo();
    }
    if (this.phase === "upward") {
      if (-m.dy < UP_CLAIM_PX) return LEAVE;
      return -m.dy >= Math.abs(m.dx) && m.cancelable ? this.claim(m, -UP_CLAIM_PX, true) : this.letGo();
    }
    this.raw = this.follow(m.dy);
    return { cancel: true, position: this.shown(), press: false };
  }

  /** The unsaved read at the claim (4.5). Returns the position to show with it. */
  claimed(unsaved: boolean): number {
    this.unsaved = unsaved;
    return this.shown();
  }

  /** Where the surface shows now. */
  get position(): number {
    return this.shown();
  }

  /**
   * The finger lifted. "tap" for a touch that never passed its claim
   * distance, null for one left to the browser or stopped, else the end.
   * `cancel` says whether to cancel the lift too, so a claimed touch makes
   * no click.
   */
  end(at: number): { end: SwipeEnd | "tap" | null; cancel: boolean } {
    const s = this.begun;
    const { phase, took } = this;
    this.phase = "idle";
    this.begun = null;
    if (!s) return { end: null, cancel: false };
    if (phase === "slop" || phase === "upward") return { end: "tap", cancel: false };
    if (phase !== "claimed") return { end: null, cancel: took };
    const end = swipeEnd({ stand: s.stand, position: this.raw, speed: speedAt(this.samples, at), height: s.height, up: s.up, scale: s.scale, unsaved: this.unsaved });
    return { end, cancel: true };
  }

  /** A second finger or a `touchcancel`: the touch never ends in anything. Returns whether it had moved the surface. */
  cancel(): boolean {
    const moved = this.phase === "claimed";
    if (this.phase !== "idle") this.phase = "over";
    return moved;
  }

  /** The surface shows something else now (4.5): as cancel, and the caller puts it back without motion. */
  replaced(): boolean {
    return this.cancel();
  }

  private claim(m: SwipeMove, taken: number, upward: boolean): SwipeStep {
    this.phase = "claimed";
    this.took = true;
    this.taken = taken;
    this.upward = upward;
    this.raw = this.follow(m.dy);
    return { cancel: true, position: this.shown(), press: true };
  }

  private letGo(): SwipeStep {
    this.phase = "free";
    return LEAVE;
  }

  /** The finger's travel less what the claim took, from where the touch's stand put the surface, never above full screen (or above its place, for a surface that cannot fill it). */
  private follow(dy: number): number {
    const s = this.begun!;
    const top = s.up > 0 ? -s.up : 0;
    return Math.max(top, (s.stand === "full" ? top : 0) + dy - this.taken);
  }

  private shown(): number {
    return this.unsaved && this.raw > 0 ? this.raw * UNSAVED_FOLLOW : this.raw;
  }

  private sample(m: SwipeMove): void {
    this.samples.push({ at: m.at, dy: m.dy });
    // Only the last window counts at the lift, and a lift comes after the last move.
    while (this.samples.length > 2 && this.samples[0]!.at < m.at - SPEED_WINDOW_MS) this.samples.shift();
  }
}

/**
 * The finger's speed at the lift, in screen px per ms, down positive: its
 * travel over its samples in the last 100 ms, from the first of them to the
 * lift. A finger that rested still at the end has none there, so 0.
 */
export function speedAt(samples: readonly Sample[], at: number): number {
  const recent = samples.filter((p) => p.at >= at - SPEED_WINDOW_MS && p.at <= at);
  const first = recent[0];
  const last = recent[recent.length - 1];
  if (!first || !last || first === last) return 0;
  return (last.dy - first.dy) / Math.max(1, at - first.at);
}

/**
 * Where a release leaves the surface (4.4, 4.7). The floor is one touch
 * target at the interface size, a flick's travel half of it. From either
 * stand a flick down closes, and a flick up goes up one stand from where
 * the release finds the surface. Otherwise the distance decides: the
 * surface moves on to the next stand in the direction it went once it has
 * travelled the larger of the floor and a quarter of the way there, and
 * closes once its top is the larger of the floor and a quarter of its
 * normal height below its normal top, from either stand. Unsaved input
 * blocks only the close, which then stops at normal.
 */
export function swipeEnd(i: { stand: SwipeStand; position: number; speed: number; height: number; up: number; scale: number; unsaved: boolean }): SwipeEnd {
  const floor = theme.touch * i.scale;
  const travel = floor * FLICK_TRAVEL;
  const from = i.stand === "full" ? -i.up : 0;
  const close = closeDistance(i.height, i.scale);
  const step = Math.max(floor, i.up * SWIPE_SHARE);
  const p = i.position;
  let end: SwipeEnd;
  if (i.speed >= FLICK_SPEED && p - from >= travel) end = "closed";
  else if (i.speed <= -FLICK_SPEED) end = i.up > 0 && p <= -travel ? "full" : "normal";
  else if (p >= close) end = "closed";
  else if (i.stand === "normal") end = i.up > 0 && -p >= step ? "full" : "normal";
  else end = p - from >= step ? "normal" : "full";
  return end === "closed" && i.unsaved ? "normal" : end;
}

/** How far below its normal top a slow drag closes the surface: a quarter of its normal height, and never less than one touch target. */
export function closeDistance(height: number, scale: number): number {
  return Math.max(height * SWIPE_SHARE, theme.touch * scale);
}

// ------------------------------------------------------------ the surface over time

/** Where the surface shows: its position, and for the whole screen's box, whether its foot stays at the toolbar's top (4.7). */
export type SwipeLook = { position: number; clip: boolean };

/** What a session does to the page. The hook does it with the DOM, the randomized test with a record. */
export type SwipeHost = {
  /** Shows the surface and its riders at `look`, easing there over SLIDE_MS with `ease`, or puts them at rest with null. */
  place(look: SwipeLook | null, ease: boolean): void;
  /** Gives the panel sheet the whole screen's box, still beside the map, for a drag above its normal top or a step down (4.7), or its own box back. */
  rise(on: boolean): void;
  /** Listens on the document for new touches, and for the last finger's lift, while a touch is followed (4.5). */
  watch(on: boolean): void;
  /** Cancels the press under the finger at the claim (4.3). */
  takePress(): void;
  /** Runs `fn` after `ms`, and returns its cancel. */
  later(ms: number, fn: () => void): () => void;
  /** The function the surface's Close button calls, with what it changes on the page done by its return. */
  close(): void;
  /** Sets the panel sheet's stand. */
  stand(full: boolean): void;
  /** Whether the surface still shows, once its close has run. */
  shows(): boolean;
  reducedMotion(): boolean;
  /** Whether the surface holds unsaved input now (4.5). */
  unsaved(): boolean;
};

/** A touch's start, with where a close slides the surface to: until it shows none of itself or its riders (4.5). */
export type SessionStart = SwipeStart & { closeAt: number };

export class SwipeSession {
  readonly touch = new SheetSwipe();
  private readonly host: SwipeHost;
  private begun: SessionStart | null = null;
  private watching = false;
  private risen = false;
  private placed = false;
  private stopMotion: (() => void) | null = null;

  constructor(host: SwipeHost) {
    this.host = host;
  }

  /** A slide is under way, during which the surface takes no touches. */
  get sliding(): boolean {
    return this.stopMotion !== null;
  }

  /** A touch went down on the surface or a rider. Returns whether it is followed. */
  begin(s: SessionStart): boolean {
    if (this.stopMotion) return false;
    const followed = this.touch.start(s);
    this.begun = followed ? s : null;
    if (followed && !this.watching) {
      this.watching = true;
      this.host.watch(true);
    }
    return followed;
  }

  /** The touch moved. Returns whether to cancel the move. */
  move(m: SwipeMove): boolean {
    const step = this.touch.move(m);
    const s = this.begun;
    if (step.position === null || !s) return step.cancel;
    let position = step.position;
    if (step.press) {
      this.host.takePress();
      position = this.touch.claimed(this.host.unsaved());
    }
    if (s.stand === "normal" && !this.risen && (position < 0 || this.touch.upward)) {
      this.risen = true;
      this.host.rise(true);
    }
    this.placed = true;
    this.host.place({ position, clip: s.stand === "normal" }, false);
    return step.cancel;
  }

  /** The touch lifted. Returns whether to cancel the lift. */
  end(at: number): boolean {
    const s = this.begun;
    this.begun = null;
    const { end, cancel } = this.touch.end(at);
    if (s && (end === "full" || end === "normal" || end === "closed")) this.settle(end, s, false);
    return cancel;
  }

  /** A second finger or a `touchcancel`: a surface that moved springs back, and the touch closes nothing. */
  cancel(): void {
    const s = this.begun;
    this.begun = null;
    if (this.touch.cancel() && s) this.settle(s.stand, s, true);
  }

  /** The last finger lifted. */
  lifted(): void {
    if (!this.watching) return;
    this.watching = false;
    this.host.watch(false);
  }

  /**
   * A new item, a change of mode, the surface hiding: the touch moves
   * nothing more, a slide stops and its close is dropped, and the surface
   * stands at rest at once, with no motion (4.5).
   */
  stop(): void {
    this.touch.replaced();
    this.begun = null;
    this.stopMotion?.();
    this.stopMotion = null;
    this.rest();
  }

  /** The surface goes: as stop, and the document is no longer watched. */
  dispose(): void {
    this.stop();
    this.lifted();
  }

  /** Slides to the end's place, then does what the end means. `back` is a spring back, which changes no stand. */
  private settle(end: SwipeEnd, s: SessionStart, back: boolean): void {
    this.stopMotion?.();
    this.stopMotion = null;
    if (end === "normal" && s.stand === "full" && !this.risen) {
      // A step down leaves the modal box as its slide starts (4.7), in the same box beside the map.
      this.risen = true;
      this.host.rise(true);
      this.placed = true;
      this.host.place({ position: this.touch.position, clip: false }, false);
    }
    const target: SwipeLook = end === "closed" ? { position: s.closeAt, clip: s.stand === "normal" } : end === "full" ? { position: -s.up, clip: false } : { position: 0, clip: true };
    const arrive = () => {
      this.stopMotion = null;
      this.arrive(end, s, back);
    };
    if (this.host.reducedMotion()) {
      arrive();
      return;
    }
    this.placed = true;
    this.host.place(target, true);
    this.stopMotion = this.host.later(SLIDE_MS, arrive);
  }

  private arrive(end: SwipeEnd, s: SessionStart, back: boolean): void {
    if (end === "closed") {
      this.host.close();
      // The owner may keep the surface open, and then it springs back: the swipe never skips a question an owner asks (4.5).
      if (this.host.shows()) this.settle(s.stand, s, true);
      else this.rest();
      return;
    }
    if (!back && end !== s.stand) this.host.stand(end === "full");
    this.rest();
  }

  /** At rest: no transform, no clip, the surface's own box. */
  private rest(): void {
    if (this.risen) {
      this.risen = false;
      this.host.rise(false);
    }
    if (this.placed) {
      this.placed = false;
      this.host.place(null, false);
    }
  }
}

// ------------------------------------------------------------ the DOM reads

/** The parts of an element the reads use, so they run over a fake tree in tests. */
export type SwipeNode = {
  readonly tagName: string;
  readonly parentElement: SwipeNode | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  readonly isContentEditable?: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  getBoundingClientRect(): { top: number; bottom: number; height: number };
};

/** The computed styles the reads need. */
export type SwipeStyle = (node: SwipeNode) => { touchAction: string; overflowY: string };

/** Input types that take no typing: a tap or a pick, never a keyboard. */
const NOT_TYPED = new Set(["checkbox", "radio", "button", "submit", "reset", "image", "file", "color", "range", "hidden"]);

/** A field that opens a keyboard: a text or number input, a textarea, editable text. */
export function takesTyping(node: SwipeNode): boolean {
  if (node.tagName === "TEXTAREA") return true;
  if (node.tagName === "INPUT") return !NOT_TYPED.has((node.getAttribute("type") ?? "text").toLowerCase());
  return node.isContentEditable === true;
}

/** A field that handles its own touches (4.1): one that takes typing, a select, a slider. */
function ownField(node: SwipeNode): boolean {
  if (node.tagName === "SELECT") return true;
  if (node.tagName === "INPUT" && (node.getAttribute("type") ?? "").toLowerCase() === "range") return true;
  return takesTyping(node);
}

/**
 * Where a touch on `target` starts (4.1), walking up to the surface: the
 * first match decides. A field or an element with `touch-action: none`
 * owns its touches. The grab area and every rider move the surface. The
 * rest is content. Null for a target outside the surface and its riders.
 */
export function startsOn(target: SwipeNode | null, surface: SwipeNode, riders: readonly SwipeNode[], style: SwipeStyle): SwipeOn | null {
  for (let n = target; n; n = n.parentElement) {
    if (ownField(n) || style(n).touchAction === "none") return "owned";
    if (n.hasAttribute(GRAB_ATTR) || riders.includes(n)) return "grab";
    if (n === surface) return "content";
  }
  return null;
}

/**
 * Whether the content under `target` is at its top (4.1): the surface's own
 * scroller, and every element between the finger and the surface that
 * scrolls up and down with more to show, each less than 1 px from its top.
 * Less than 1 px, since a scroll position can be fractional under the
 * interface size's zoom and iOS reports a negative one while it bounces.
 */
export function atTop(target: SwipeNode | null, surface: SwipeNode, scroller: SwipeNode | null, style: SwipeStyle): boolean {
  if (scroller && scroller.scrollTop >= 1) return false;
  for (let n = target; n && n !== surface; n = n.parentElement) {
    if (n.scrollTop < 1 || n.scrollHeight <= n.clientHeight) continue;
    const overflow = style(n).overflowY;
    if (overflow === "auto" || overflow === "scroll") return false;
  }
  return true;
}

/**
 * How far a close slides the surface: until the highest top edge among it
 * and its riders reaches the clip edge, where what covers the surface's
 * foot begins (4.5). The panel sheet and the panes are drawn under the
 * toolbar, so theirs is their own foot. A dialog's card and the roll card
 * are drawn over everything, so theirs is the screen's foot.
 */
export function slideDistance(surface: SwipeNode, riders: readonly SwipeNode[], clip: "foot" | "screen", screenFoot: number): number {
  const box = surface.getBoundingClientRect();
  const top = Math.min(box.top, ...riders.map((r) => r.getBoundingClientRect().top));
  const edge = clip === "foot" ? box.bottom : screenFoot;
  return Math.max(0, edge - top);
}

// ------------------------------------------------------------ unsaved input

/**
 * The drafts a swiping surface's content reports (4.6): text or a choice
 * typed or picked that only a later button sends, while it differs from
 * where it started. Each surface keeps one and provides it to what it shows.
 */
export class DraftRegistry {
  private readonly on = new Set<symbol>();
  report(key: symbol, unsaved: boolean): void {
    if (unsaved) this.on.add(key);
    else this.on.delete(key);
  }
  any(): boolean {
    return this.on.size > 0;
  }
}

const DraftContext = createContext<DraftRegistry | null>(null);

/** Provides a surface's drafts to what it shows. */
export const DraftScope = DraftContext.Provider;

/** One registry for the life of a surface. */
export function useDraftRegistry(): DraftRegistry {
  const [registry] = useState(() => new DraftRegistry());
  return registry;
}

/**
 * Reports a draft that a swipe's close would throw away, so the surface
 * springs back instead (4.5). Outside a swiping surface, as in the side
 * panel, it does nothing.
 */
export function useUnsavedInput(unsaved: boolean): void {
  const registry = useContext(DraftContext);
  const [key] = useState(() => Symbol("draft"));
  useEffect(() => {
    if (!registry) return;
    registry.report(key, unsaved);
    return () => registry.report(key, false);
  }, [registry, key, unsaved]);
}

/** A field as the focus rule reads it: its value, or its text when it is editable text. */
export type FieldNode = SwipeNode & { readonly value?: string; readonly textContent: string | null };

/**
 * The focus half of unsaved input (4.5): a field that takes typing holds
 * unsaved input while it has focus and its value differs from its value
 * when it took focus, since a field that saves on blur may hold a change
 * not yet saved. A focused field with nothing typed into it counts for
 * nothing, and so does a search, a view of the list whose loss loses no
 * work. A select or a slider sends its value as it changes, so it never
 * counts. Each value is read as the field takes focus, and the field
 * focused when the surface's listeners attach is read then (W6-P-21).
 */
export class TypedValues {
  private readonly start = new WeakMap<object, string>();

  remember(node: FieldNode | null): void {
    if (node && takesTyping(node)) this.start.set(node, fieldValue(node));
  }

  changed(active: FieldNode | null): boolean {
    if (!active || !takesTyping(active) || (active.getAttribute("type") ?? "").toLowerCase() === "search") return false;
    const was = this.start.get(active);
    return was !== undefined && was !== fieldValue(active);
  }
}

function fieldValue(node: FieldNode): string {
  return node.value ?? node.textContent ?? "";
}

/**
 * The normal stand of a sheet that fills the screen, in screen px (4.7):
 * its height when it last stood normal, held at the expand, and its foot
 * where it stood then. After a change of layout size since (a rotation, a
 * resize, an interface size) the height is the sheet's cap for the layout
 * now, since the content's own height there is not known until it stands
 * normal again. `up`, the normal top's distance from the screen's top,
 * comes from the same height.
 */
export function normalFromHeld(held: Held | null, now: { scale: number; screen: number; cap: number }): { height: number; normalTop: number; normalBottom: number; up: number } {
  const fresh = held !== null && !held.stale && held.scale === now.scale;
  const height = fresh ? held.height : now.cap * now.scale;
  const foot = held ? (held.foot * now.scale) / held.scale : theme.layout.toolbar * now.scale;
  const normalBottom = now.screen - foot;
  const normalTop = Math.max(0, normalBottom - height);
  return { height: normalBottom - normalTop, normalTop, normalBottom, up: normalTop };
}

// ------------------------------------------------------------ the hook

export type SheetSwipeOptions = {
  /** The surface stands at the screen's foot as a sheet (section 3). */
  enabled: boolean;
  /** The function its Close button calls. */
  onClose(): void;
  /** Its one scroller, when that is not the surface itself. */
  scroller?: RefObject<HTMLElement | null>;
  /** What rides its top edge: the dock on the panel sheet. Part of its grab area, and moved with it. */
  riders?: readonly (HTMLElement | null)[];
  /** What it shows: a change ends a drag and drops a slide's close (4.5). */
  item: string;
  /** Where what covers its foot begins: its own foot under the toolbar, or the screen's (4.5). */
  clip: "foot" | "screen";
  /** The panel sheet's stand and its setter, and its cap for the layout now in layout px, for a long swipe after a change of layout (4.7). */
  full?: { on: boolean; set(on: boolean): void; cap: number };
  drafts?: DraftRegistry | null;
  /** Its close keeps everything, as the roll card's Later does, so unsaved input never holds it. */
  keeps?: boolean;
};

/** The normal stand's height and foot from the screen's foot, in screen px at the interface size it was read at, held while the sheet fills the screen (4.7). */
export type Held = { height: number; foot: number; scale: number; stale: boolean };

/** A touch's geometry in screen px, read as it starts. */
export type SwipeGeometry = {
  normalTop: number;
  normalBottom: number;
  up: number;
  scale: number;
  /** The whole screen's box: its top at rest, its height, and the header's offset inside it, the top safe area. */
  boxTop: number;
  boxHeight: number;
  off: number;
  /** The box the surface has: its own, or the whole screen's. */
  wholeScreen: boolean;
};

const EASE = "cubic-bezier(0, 0, 0.2, 1)";
const NO_RIDERS: readonly HTMLElement[] = [];

/**
 * Makes a surface swipe (4.6): native listeners while `enabled`, since
 * React's own touch listeners are passive and cannot cancel a move. A
 * touch that cannot swipe returns at once. `rising` is the panel sheet's
 * box change for a drag above its normal top, and `expand` is what its
 * "Full screen" button does.
 */
export function useSheetSwipe(surface: RefObject<HTMLElement | null>, options: SheetSwipeOptions): { rising: boolean; expand(on: boolean): void } {
  const scale = useUiScale();
  const latest = useRef({ options, scale });
  latest.current = { options, scale };
  const [rising, setRising] = useState(false);
  const session = useRef<SwipeSession | null>(null);
  const held = useRef<Held | null>(null);
  /** The pointer of the claimed touch, whose later events the window stops (4.3). */
  const claimed = useRef<number | null>(null);
  const riders = options.riders?.filter((r): r is HTMLElement => r !== null) ?? NO_RIDERS;
  const riderKey = useRiderKey(riders);
  const ridersNow = useRef(riders);
  ridersNow.current = riders;
  /** Set while an effect stops the session: React flushes its render itself there, so the box changes wait for it. */
  const inEffect = useRef(false);

  // On the window from the mount, so it runs before every window listener added later and every listener below the window.
  useEffect(() => {
    const stop = (e: Event) => {
      if (!stopsClaimed(claimed.current, e as Event & { pointerId?: number })) return;
      e.stopImmediatePropagation();
      if (e.type === "click") e.preventDefault();
    };
    const types = ["pointermove", "pointerup", "click"] as const;
    for (const type of types) window.addEventListener(type, stop, true);
    return () => {
      for (const type of types) window.removeEventListener(type, stop, true);
    };
  }, []);

  // A change of layout since the expand leaves the held height unknown: the content's own height there shows only once the sheet stands normal again (4.7).
  useEffect(() => {
    const seen = { w: window.innerWidth, h: window.innerHeight };
    const onResize = () => {
      if (window.innerWidth === seen.w && window.innerHeight === seen.h) return;
      seen.w = window.innerWidth;
      seen.h = window.innerHeight;
      if (held.current) held.current.stale = true;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const { enabled } = options;
  useEffect(() => {
    const el = surface.current;
    if (!enabled || !el) return;
    const list = ridersNow.current;
    const css: SwipeStyle = (node) => getComputedStyle(node as unknown as Element);
    let geometry: SwipeGeometry | null = null;
    let followed: { id: number; x: number; y: number } | null = null;
    let lastDown: { id: number; target: EventTarget | null } | null = null;
    let captured: Element | null = null;
    let releaseLater: ReturnType<typeof setTimeout> | null = null;
    const values = new TypedValues();
    const remember = (node: Element | null) => {
      if (node && el.contains(node)) values.remember(node as unknown as FieldNode);
    };
    // A field the surface's own opening focused, before these listeners existed, still has a start to compare with (W6-P-21).
    remember(document.activeElement);

    const moving = [el, ...list] as HTMLElement[];
    const clearStyle = (node: HTMLElement) => {
      node.style.transform = "";
      node.style.clipPath = "";
      node.style.transition = "";
      node.style.willChange = "";
    };
    const measureBox = () => {
      if (!geometry) return;
      const box = el.getBoundingClientRect();
      const header = el.querySelector(`[${GRAB_ATTR}]`)?.getBoundingClientRect();
      geometry.boxTop = box.top;
      geometry.boxHeight = box.height;
      geometry.off = header ? Math.max(0, header.top - box.top) : 0;
    };

    const host: SwipeHost = {
      place(look, ease) {
        const g = geometry;
        if (look === null || !g) {
          for (const node of moving) clearStyle(node);
          el.removeAttribute(SLIDE_TO_ATTR);
          if (el.hasAttribute(SWIPING_ATTR)) {
            el.removeAttribute(SWIPING_ATTR);
            el.dispatchEvent(new Event(SWIPE_REST_EVENT));
          }
          return;
        }
        el.setAttribute(SWIPING_ATTR, "");
        if (ease) {
          // The browser takes the current place as the slide's start only once it has a style for it.
          void el.offsetHeight;
          el.setAttribute(SLIDE_TO_ATTR, String(Math.round(look.position)));
        }
        const transition = ease ? `transform ${SLIDE_MS}ms ${EASE}, clip-path ${SLIDE_MS}ms ${EASE}` : "none";
        const { transform, clip } = drawnAt(look, g);
        el.style.transition = transition;
        el.style.willChange = "transform";
        el.style.transform = transform;
        el.style.clipPath = clip;
        for (const rider of list) {
          rider.style.transition = transition;
          rider.style.willChange = "transform";
          rider.style.transform = `translateY(${look.position / g.scale}px)`;
        }
      },
      rise(on) {
        if (geometry) {
          // Its own box's transform would be read against the whole screen's box.
          if (on) el.style.transform = "";
          geometry.wholeScreen = on || geometry.wholeScreen;
        }
        if (inEffect.current) setRising(on);
        else flushSync(() => setRising(on));
        if (on) {
          measureBox();
          if (latest.current.options.full && !latest.current.options.full.on && geometry) holdNormal(geometry);
        } else if (geometry) geometry.wholeScreen = latest.current.options.full?.on === true;
      },
      watch(on) {
        if (on) {
          document.addEventListener("touchstart", onDocStart, { capture: true, passive: true });
          document.addEventListener("touchend", onDocEnd, { capture: true, passive: true });
          document.addEventListener("touchcancel", onDocEnd, { capture: true, passive: true });
        } else {
          document.removeEventListener("touchstart", onDocStart, { capture: true });
          document.removeEventListener("touchend", onDocEnd, { capture: true });
          document.removeEventListener("touchcancel", onDocEnd, { capture: true });
        }
      },
      takePress() {
        const down = lastDown;
        if (!down) return;
        claimed.current = down.id;
        cancelPress({ id: down.id, target: down.target instanceof Element ? down.target : null }, captured, (pointerId) => new PointerEvent("pointercancel", { pointerId, pointerType: "touch", isPrimary: true, bubbles: true }));
      },
      later(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      close() {
        // Rendered at once, so whether the owner kept the surface open shows as soon as the close returns.
        const { onClose } = latest.current.options;
        if (inEffect.current) onClose();
        else flushSync(onClose);
      },
      stand(full) {
        const f = latest.current.options.full;
        if (!f) return;
        if (inEffect.current) f.set(full);
        else flushSync(() => f.set(full));
        if (geometry) geometry.wholeScreen = full;
      },
      shows() {
        return el.isConnected && el.getClientRects().length > 0;
      },
      reducedMotion() {
        return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      },
      unsaved() {
        const o = latest.current.options;
        if (o.keeps) return false;
        if (o.drafts?.any()) return true;
        const active = document.activeElement;
        return active !== null && el.contains(active) && values.changed(active as unknown as FieldNode);
      },
    };
    const swipe = new SwipeSession(host);
    session.current = swipe;

    const holdNormal = (g: SwipeGeometry) => {
      held.current = { height: g.normalBottom - g.normalTop, foot: window.innerHeight - g.normalBottom, scale: g.scale, stale: false };
    };

    /** The normal stand's geometry for this touch, read from the sheet as it stands, or from what was held while it fills the screen (4.7). */
    const readGeometry = (stand: SwipeStand): { geometry: SwipeGeometry; height: number; closeAt: number } => {
      const o = latest.current.options;
      const s = latest.current.scale;
      const screen = window.innerHeight;
      if (stand === "normal") {
        const r = el.getBoundingClientRect();
        const g: SwipeGeometry = { normalTop: r.top, normalBottom: r.bottom, up: o.full ? Math.max(0, r.top) : 0, scale: s, boxTop: 0, boxHeight: screen, off: 0, wholeScreen: false };
        return { geometry: g, height: r.height, closeAt: slideDistance(el as unknown as SwipeNode, list as unknown as SwipeNode[], o.clip, screen) };
      }
      const normal = normalFromHeld(held.current, { scale: s, screen, cap: o.full?.cap ?? 0 });
      const g: SwipeGeometry = { normalTop: normal.normalTop, normalBottom: normal.normalBottom, up: normal.up, scale: s, boxTop: 0, boxHeight: screen, off: 0, wholeScreen: true };
      geometry = g;
      measureBox();
      // From full screen it is drawn over everything, so a close slides it past the screen's foot.
      return { geometry: g, height: normal.height, closeAt: screen - normal.normalTop + g.off + 1 };
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      lastDown = { id: e.pointerId, target: e.target };
      captured = null;
      if (claimed.current !== null && claimed.current !== e.pointerId) claimed.current = null;
    };
    const onCapture = (e: PointerEvent) => {
      if (lastDown && e.pointerId === lastDown.id && e.target instanceof Element) captured = e.target;
    };
    const onFocusIn = (e: FocusEvent) => remember(e.target instanceof Element ? e.target : null);

    const onStart = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (!t || followed || swipe.sliding) return;
      const target = e.target instanceof Element ? (e.target as unknown as SwipeNode) : null;
      const node = el as unknown as SwipeNode;
      const on = startsOn(target, node, list as unknown as SwipeNode[], css);
      if (on === null || on === "owned") return;
      const o = latest.current.options;
      const top = on === "grab" || atTop(target, node, (o.scroller?.current ?? el) as unknown as SwipeNode, css);
      const active = document.activeElement;
      const typing = active !== null && el.contains(active) && takesTyping(active as unknown as SwipeNode);
      if (on === "content" && (!top || typing)) return;
      const stand: SwipeStand = o.full?.on ? "full" : "normal";
      const read = readGeometry(stand);
      geometry = read.geometry;
      const started = swipe.begin({ on, atTop: top, typing, fingers: e.touches.length, height: read.height, scale: latest.current.scale, at: e.timeStamp, stand, up: read.geometry.up, closeAt: read.closeAt });
      if (started) followed = { id: t.identifier, x: t.clientX, y: t.clientY };
    };
    const onMove = (e: TouchEvent) => {
      if (!followed) return;
      const t = touchOf(e.touches, followed.id);
      if (!t) return;
      const cancel = swipe.move({ dx: t.clientX - followed.x, dy: t.clientY - followed.y, at: e.timeStamp, cancelable: e.cancelable });
      if (cancel && e.cancelable) e.preventDefault();
    };
    const onEnd = (e: TouchEvent) => {
      if (!followed || !touchOf(e.changedTouches, followed.id)) return;
      followed = null;
      if (swipe.end(e.timeStamp) && e.cancelable) e.preventDefault();
      // A claimed pointer's last events, and a click that would follow them, are stopped until the next press.
      if (releaseLater) clearTimeout(releaseLater);
      releaseLater = setTimeout(() => {
        releaseLater = null;
        claimed.current = null;
      }, 0);
    };
    const onCancel = (e: TouchEvent) => {
      if (!followed || !touchOf(e.changedTouches, followed.id)) return;
      followed = null;
      swipe.cancel();
    };
    // Any new touch while one is followed, wherever it lands, cancels the swipe for good (4.5).
    const onDocStart = () => {
      if (followed) swipe.cancel();
    };
    const onDocEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) swipe.lifted();
    };

    for (const node of moving) {
      node.addEventListener("touchstart", onStart, { passive: true });
      node.addEventListener("touchmove", onMove, { passive: false });
      node.addEventListener("touchend", onEnd, { passive: false });
      node.addEventListener("touchcancel", onCancel, { passive: true });
      node.addEventListener("pointerdown", onPointerDown, true);
      node.addEventListener("gotpointercapture", onCapture, true);
    }
    el.addEventListener("focusin", onFocusIn);
    return () => {
      inEffect.current = true;
      swipe.dispose();
      inEffect.current = false;
      for (const node of moving) {
        node.removeEventListener("touchstart", onStart);
        node.removeEventListener("touchmove", onMove);
        node.removeEventListener("touchend", onEnd);
        node.removeEventListener("touchcancel", onCancel);
        node.removeEventListener("pointerdown", onPointerDown, true);
        node.removeEventListener("gotpointercapture", onCapture, true);
      }
      el.removeEventListener("focusin", onFocusIn);
      if (releaseLater) clearTimeout(releaseLater);
      claimed.current = null;
      if (session.current === swipe) session.current = null;
    };
  }, [surface, enabled, riderKey]);

  // A new item ends a drag at once, without motion, and drops a slide's close (4.5).
  const { item } = options;
  const shownItem = useRef(item);
  useLayoutEffect(() => {
    if (shownItem.current === item) return;
    shownItem.current = item;
    inEffect.current = true;
    session.current?.stop();
    inEffect.current = false;
  }, [item]);

  const expand = useCallback(
    (on: boolean) => {
      const f = latest.current.options.full;
      const el = surface.current;
      if (!f) return;
      if (on && !f.on && el) {
        const r = el.getBoundingClientRect();
        held.current = { height: r.height, foot: window.innerHeight - r.bottom, scale: latest.current.scale, stale: false };
      }
      f.set(on);
    },
    [surface],
  );

  return { rising, expand };
}

/**
 * The transform and clip that show the surface at `look`. In its own box a
 * transform moves it. In the whole screen's box its visible top meets the
 * position, and the top safe area above its header is uncovered as it
 * rises, so the header stays under the finger at the start and the box
 * meets the screen's top at full. With `clip`, its foot stays at the
 * toolbar's top, as its own box's does (4.7).
 */
export function drawnAt(look: SwipeLook, g: SwipeGeometry): { transform: string; clip: string } {
  if (!g.wholeScreen) return { transform: `translateY(${look.position / g.scale}px)`, clip: "" };
  const share = look.position >= 0 || g.up <= 0 ? 1 : Math.max(0, 1 + look.position / g.up);
  const band = g.off * share;
  const top = g.normalTop + look.position - band;
  const foot = look.clip ? Math.max(0, top + g.boxHeight - g.normalBottom) : 0;
  return { transform: `translateY(${(top - g.boxTop) / g.scale}px)`, clip: `inset(${band / g.scale}px 0 ${foot / g.scale}px 0)` };
}

/** The parts of the pressed control and of what holds its pointer capture that cancelPress uses. */
export type PressTarget = { readonly isConnected: boolean; dispatchEvent(e: Event): boolean };
export type CaptureHolder = { hasPointerCapture(id: number): boolean; releasePointerCapture(id: number): void };

/**
 * Does to the control under the finger what the browser does when it takes
 * a touch for a scroll (4.3): it hears a `pointercancel`, and whatever holds
 * the pointer's capture lets it go. A stepper that stepped on its press
 * puts its value back, as under a scroll.
 */
export function cancelPress(down: { id: number; target: PressTarget | null }, captured: CaptureHolder | null, make: (pointerId: number) => Event): void {
  if (down.target?.isConnected) down.target.dispatchEvent(make(down.id));
  try {
    if (captured?.hasPointerCapture(down.id)) captured.releasePointerCapture(down.id);
  } catch {
    // The pointer is gone already.
  }
}

/** Whether the window stops this pointer event: one of the claimed touch's, after its cancel, so no control hears a move, an up or a click (4.3). */
export function stopsClaimed(claimed: number | null, e: { pointerId?: number }): boolean {
  return claimed !== null && e.pointerId === claimed;
}

function touchOf(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && t.identifier === id) return t;
  }
  return null;
}

/** A number that changes whenever the riders do, for the listeners' effect. */
function useRiderKey(riders: readonly HTMLElement[]): number {
  const last = useRef<{ list: readonly HTMLElement[]; key: number }>({ list: riders, key: 0 });
  const same = last.current.list.length === riders.length && last.current.list.every((r, i) => r === riders[i]);
  if (!same) last.current = { list: riders, key: last.current.key + 1 };
  return last.current.key;
}
