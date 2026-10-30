import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { effectiveZoom } from "../features/device/layout.ts";
import { useUiScale } from "../features/device/settings.ts";
import { TAP_SLOP_PX } from "./gestures.ts";
import { REPEAT_DELAY_MS } from "./holdRepeat.ts";
import { cancelPress, FLICK_SPEED, FLICK_TRAVEL, SLIDE_MS, SNAP_SHARE, SPEED_WINDOW_MS, speedAt, stopsClaimed, SWIPING_ATTR, takesTyping, TypedValues, UNSAVED_FOLLOW, type DraftRegistry, type FieldNode } from "./sheetSwipe.ts";
import { theme } from "./theme.ts";

/*
 * Swipe right in a phone's panel to go back, as the Back in its header
 * does: from a panel to the list of panels, from a page inside a panel
 * (a subpage) to the panel. The sheet's own swipe (sheetSwipe.ts) takes
 * the touches that go down or up. This one takes those that go right,
 * and the two split each touch by its first move past the tap slop, so
 * no touch is ever both. The same three layers, each tested on its own:
 *
 * - BackSwipe: one touch as a state machine with no DOM.
 * - BackSession: the touches over time, with the slide after a release,
 *   acting through a BackHost so the randomized test drives it with a
 *   record of the page.
 * - useBackSwipe: the host on the DOM, and the reads it starts from
 *   (ownsSideways, inEdgeZone), written over a node interface.
 *
 * Positions are screen px, the finger's own: how far right of its place
 * the panel's body shows, 0 at rest.
 */

/**
 * The browser's and the system's own back swipe start this close to the
 * screen's left edge: iOS Safari's swipe through history, and Android's
 * Back gesture, which takes the touch from the page. A touch that starts
 * there is theirs.
 */
export const EDGE_ZONE_PX = 24;
/** Marks an element that takes sideways drags itself, so a back swipe never starts on it. */
export const SIDEWAYS_ATTR = "data-swipe-sideways";
/** On the surface while a back swipe moves its page. */
export const BACK_SWIPE_ATTR = "data-back-swipe";
/** On the surface during the slide after a release: the position it ends at, the page's width for a back and 0 for a spring back. */
export const BACK_TO_ATTR = "data-back-swipe-to";
/** The page is dimmed by at most this much as it reaches the surface's width, so it reads as leaving. */
const FADE = 0.4;

// ------------------------------------------------------------ one touch

export type BackStart = {
  /** Something under the finger takes sideways drags itself (ownsSideways), or the touch began in the system's edge zone. */
  owned: boolean;
  /** Fingers on the screen as it started, this one included. */
  fingers: number;
  at: number;
  /** The panel's width in screen px, which a slow release measures against. */
  width: number;
  /** The interface size. */
  scale: number;
};

export type BackMove = {
  dx: number;
  dy: number;
  at: number;
  cancelable: boolean;
  /** Another listener cancelled this move before the back swipe heard it: a roll button's fired hold, or the sheet's own swipe. The finger is theirs. */
  taken: boolean;
};

export type BackStep = {
  /** Cancel this move, so the browser neither scrolls nor selects for it. */
  cancel: boolean;
  /** Where to show the page, or null to leave it be. */
  position: number | null;
  /** This move claimed the touch: cancel the press under the finger. */
  press: boolean;
};

export type BackEnd = "back" | "rest";

type Phase = "idle" | "slop" | "claimed" | "free" | "over";

const LEAVE: BackStep = { cancel: false, position: null, press: false };

/**
 * One touch on a panel. Inside the slop it touches nothing, so a tap stays
 * the browser's. The first move past the slop locks the touch's axis for
 * good: more right than up or down, and the browser still able to cancel
 * it, it claims the touch. Anything else, a tie included, leaves it to the
 * browser and the sheet's own swipe, which claims a move that goes down at
 * least as much as sideways: the exact other side of the same line.
 */
export class BackSwipe {
  phase: Phase = "idle";
  private begun: BackStart | null = null;
  private samples: { at: number; dy: number }[] = [];
  private raw = 0;
  private unsaved = false;
  /** This touch was claimed, so its later moves and its end stay cancelled whatever stops it: one owner per touch. */
  private took = false;

  start(s: BackStart): boolean {
    this.begun = s;
    this.samples = [{ at: s.at, dy: 0 }];
    this.raw = 0;
    this.unsaved = false;
    this.took = false;
    const may = s.fingers <= 1 && !s.owned;
    this.phase = may ? "slop" : "free";
    return may;
  }

  move(m: BackMove): BackStep {
    const s = this.begun;
    if (!s) return LEAVE;
    if (this.phase === "over") return { cancel: this.took, position: null, press: false };
    if (this.phase !== "slop" && this.phase !== "claimed") return LEAVE;
    if (m.taken) {
      this.phase = "over";
      return { cancel: false, position: null, press: false };
    }
    this.sample(m);
    if (this.phase === "slop") {
      if (Math.hypot(m.dx, m.dy) <= TAP_SLOP_PX) return LEAVE;
      // A press held still before it moves is a hold: text to select, a stepper to repeat, a roll's mode menu.
      if (m.at - s.at >= REPEAT_DELAY_MS) return this.letGo();
      if (m.dx > Math.abs(m.dy) && m.cancelable) {
        this.phase = "claimed";
        this.took = true;
        this.raw = this.follow(m.dx);
        return { cancel: true, position: this.shown(), press: true };
      }
      return this.letGo();
    }
    this.raw = this.follow(m.dx);
    return { cancel: true, position: this.shown(), press: false };
  }

  /** The unsaved read at the claim. Returns the position to show with it. */
  claimed(unsaved: boolean): number {
    this.unsaved = unsaved;
    return this.shown();
  }

  get position(): number {
    return this.shown();
  }

  /**
   * The finger lifted. "tap" for a touch that never passed the slop, null
   * for one left to the browser or stopped, else the end. `cancel` says
   * whether to cancel the lift, so a claimed touch makes no click.
   */
  end(at: number): { end: BackEnd | "tap" | null; cancel: boolean } {
    const s = this.begun;
    const { phase, took } = this;
    this.phase = "idle";
    this.begun = null;
    if (!s) return { end: null, cancel: false };
    if (phase === "slop") return { end: "tap", cancel: false };
    if (phase !== "claimed") return { end: null, cancel: took };
    return { end: backEnd({ position: this.raw, speed: speedAt(this.samples, at), width: s.width, scale: s.scale, unsaved: this.unsaved }), cancel: true };
  }

  /** A second finger, a `touchcancel` or a new page: the touch never ends in anything. Returns whether it had moved the page. */
  cancel(): boolean {
    const moved = this.phase === "claimed";
    if (this.phase !== "idle") this.phase = "over";
    return moved;
  }

  private letGo(): BackStep {
    this.phase = "free";
    return LEAVE;
  }

  /** The finger's travel past the slop, so the page starts from where it stood, and never left of its place. */
  private follow(dx: number): number {
    return Math.max(0, dx - TAP_SLOP_PX);
  }

  private shown(): number {
    return this.unsaved ? this.raw * UNSAVED_FOLLOW : this.raw;
  }

  /** The finger's sideways travel for the lift's speed, read as the sheet's swipe reads its own: only the last window counts. */
  private sample(m: BackMove): void {
    this.samples.push({ at: m.at, dy: m.dx });
    while (this.samples.length > 2 && this.samples[1]!.at <= m.at - SPEED_WINDOW_MS) this.samples.shift();
  }
}

/**
 * Where a release leaves the page. A flick right goes back once the page
 * has travelled half a touch target, and a flick left springs back from
 * anywhere. A slow release goes back past half the panel's width, and
 * never for less than one touch target. Unsaved input never goes back, as
 * it never closes the sheet.
 */
export function backEnd(i: { position: number; speed: number; width: number; scale: number; unsaved: boolean }): BackEnd {
  if (i.unsaved || i.speed <= -FLICK_SPEED) return "rest";
  if (i.speed >= FLICK_SPEED && i.position >= theme.touch * i.scale * FLICK_TRAVEL) return "back";
  return i.position >= backDistance(i.width, i.scale) ? "back" : "rest";
}

/** How far right a slow release must carry the page to go back: half the panel's width, and never less than one touch target. */
export function backDistance(width: number, scale: number): number {
  return Math.max(width * SNAP_SHARE, theme.touch * scale);
}

// ------------------------------------------------------------ the page over time

/** What a session does to the page. The hook does it with the DOM, the randomized test with a record. */
export type BackHost = {
  /** Shows the page `x` screen px right of its place, easing over SLIDE_MS with `ease`, or at rest with null. */
  place(x: number | null, ease: boolean): void;
  /** Listens on the document for new touches, and for the last finger's lift, while a touch is followed. */
  watch(on: boolean): void;
  /** Cancels the press under the finger at the claim. */
  takePress(): void;
  /** Runs `fn` after `ms`, and returns its cancel. */
  later(ms: number, fn: () => void): () => void;
  /** What the header's Back does, with what it changes on the page done by its return. Returns whether the page left: an owner that asks first, such as "Discard changes?", keeps it. */
  back(): boolean;
  reducedMotion(): boolean;
  /** Whether the panel holds unsaved input now. */
  unsaved(): boolean;
};

export class BackSession {
  readonly touch = new BackSwipe();
  private readonly host: BackHost;
  private begun: BackStart | null = null;
  private watching = false;
  private placed = false;
  /** The slide under way: its cancel, and whether it ends in a back. */
  private slide: { stop: () => void; back: boolean } | null = null;

  constructor(host: BackHost) {
    this.host = host;
  }

  get sliding(): boolean {
    return this.slide !== null;
  }

  /**
   * A touch went down on the panel. A slide under way ends at once, as it
   * would have: a back goes back, and the touch lands on what that leaves.
   * Returns whether the touch is followed.
   */
  begin(s: BackStart): boolean {
    if (this.slide) {
      const { back } = this.slide;
      this.finish();
      if (back) return false;
    }
    const followed = this.touch.start(s);
    this.begun = followed ? s : null;
    if (followed && !this.watching) {
      this.watching = true;
      this.host.watch(true);
    }
    return followed;
  }

  /** The touch moved. Returns whether to cancel the move. */
  move(m: BackMove): boolean {
    const wasClaimed = this.touch.phase === "claimed";
    const step = this.touch.move(m);
    if (wasClaimed && this.touch.phase === "over") {
      // Taken from under a claim: back to its place, going nowhere.
      this.begun = null;
      this.settle(false);
      return step.cancel;
    }
    if (step.position === null || !this.begun) return step.cancel;
    let x = step.position;
    if (step.press) {
      this.host.takePress();
      x = this.touch.claimed(this.host.unsaved());
    }
    this.placed = true;
    this.host.place(x, false);
    return step.cancel;
  }

  /** The touch lifted. Returns whether to cancel the lift. */
  end(at: number): boolean {
    const s = this.begun;
    this.begun = null;
    const { end, cancel } = this.touch.end(at);
    if (s && (end === "back" || end === "rest")) this.settle(end === "back", s.width);
    return cancel;
  }

  /** A second finger or a `touchcancel`: a page that moved springs back, and the touch goes nowhere. */
  cancel(): void {
    this.begun = null;
    if (this.touch.cancel()) this.settle(false);
  }

  /** The last finger lifted. */
  lifted(): void {
    if (!this.watching) return;
    this.watching = false;
    this.host.watch(false);
  }

  /** A new page or panel, or the panel hiding: the touch moves nothing more, a slide stops and its back is dropped, and the page stands at rest at once. */
  stop(): void {
    this.touch.cancel();
    this.begun = null;
    this.slide?.stop();
    this.slide = null;
    this.rest();
  }

  dispose(): void {
    this.stop();
    this.lifted();
  }

  /** Slides to the end's place, then does what it means. */
  private settle(back: boolean, width = 0): void {
    this.slide?.stop();
    this.slide = null;
    if (this.host.reducedMotion()) {
      this.arrive(back);
      return;
    }
    this.placed = true;
    this.host.place(back ? width : 0, true);
    this.slide = { stop: this.host.later(SLIDE_MS, () => this.finish()), back };
  }

  /** The slide is over, at its time or cut short by a new touch. */
  private finish(): void {
    const slide = this.slide;
    if (!slide) return;
    slide.stop();
    this.slide = null;
    this.arrive(slide.back);
  }

  private arrive(back: boolean): void {
    // A page its owner kept springs back, as the sheet does when its close is kept.
    if (back && !this.host.back()) {
      this.settle(false);
      return;
    }
    this.rest();
  }

  private rest(): void {
    if (!this.placed) return;
    this.placed = false;
    this.host.place(null, false);
  }
}

// ------------------------------------------------------------ the DOM reads

/** The parts of an element the reads use, so they run over a fake tree in tests. */
export type SidewaysNode = {
  readonly tagName: string;
  readonly parentElement: SidewaysNode | null;
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  readonly isContentEditable?: boolean;
  readonly scrollLeft: number;
  readonly scrollWidth: number;
  readonly clientWidth: number;
};

/** The computed styles the reads need. */
export type SidewaysStyle = (node: SidewaysNode) => { touchAction: string; overflowX: string };

/**
 * Whether something between `target` and the surface takes a sideways drag
 * itself, so a back swipe from there never starts: a field (a caret to
 * move, text to scroll, a select, a slider), a roll's mode menu, an
 * element marked with SIDEWAYS_ATTR or whose `touch-action` leaves no
 * up-and-down pan to the browser while it reads its own moves, and a
 * scroller that can scroll left. A scroller at its left edge hands over:
 * a swipe right cannot move it, so the swipe is the panel's. Less than
 * 1 px counts as the edge, since a scroll position can be fractional under
 * the interface size's zoom and iOS reports a negative one as it bounces.
 */
export function ownsSideways(target: SidewaysNode | null, surface: SidewaysNode, style: SidewaysStyle): boolean {
  for (let n = target; n && n !== surface; n = n.parentElement) {
    if (n.hasAttribute(SIDEWAYS_ATTR) || n.hasAttribute("data-roll-mode-menu") || ownField(n)) return true;
    const { touchAction, overflowX } = style(n);
    if (touchAction === "none" || (touchAction.includes("pan-x") && !touchAction.includes("pan-y"))) return true;
    if ((overflowX === "auto" || overflowX === "scroll") && n.scrollWidth > n.clientWidth && n.scrollLeft >= 1) return true;
  }
  return false;
}

function ownField(node: SidewaysNode): boolean {
  if (node.tagName === "SELECT") return true;
  if (node.tagName === "INPUT" && (node.getAttribute("type") ?? "").toLowerCase() === "range") return true;
  return takesTyping(node as unknown as Parameters<typeof takesTyping>[0]);
}

/** Whether a touch at `x`, in the viewport's px, starts in the system's edge zone. */
export function inEdgeZone(x: number): boolean {
  return x < EDGE_ZONE_PX;
}

// ------------------------------------------------------------ the hook

export type BackSwipeOptions = {
  /** The panel shows, with a Back in its header. */
  enabled: boolean;
  /** What the header's Back does. */
  onBack(): void;
  /** What moves with the finger: the panel's body, inside the surface's frame and under its header, which stays. */
  page: RefObject<HTMLElement | null>;
  /** What it shows: a change ends a drag at once and drops a slide's back. */
  item: string;
  drafts?: DraftRegistry | null;
};

const EASE = "cubic-bezier(0, 0, 0.2, 1)";

/**
 * Makes a phone's panel swipe back: native listeners while `enabled`,
 * since React's touch listeners are passive and cannot cancel a move.
 * Touch only, so a mouse never swipes. Its body moves rather than the
 * surface, whose own transform belongs to the sheet's swipe, and the
 * header stays, grabber and all.
 */
export function useBackSwipe(surface: RefObject<HTMLElement | null>, options: BackSwipeOptions): void {
  const scale = useUiScale();
  const latest = useRef({ options, scale });
  latest.current = { options, scale };
  const session = useRef<BackSession | null>(null);
  /** The pointer of the claimed touch, whose later events the window stops. */
  const claimed = useRef<number | null>(null);

  // On the window from the mount, so it runs before every listener below the window.
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

  const { enabled } = options;
  useEffect(() => {
    const el = surface.current;
    if (!enabled || !el) return;
    const css: SidewaysStyle = (node) => getComputedStyle(node as unknown as Element);
    let followed: { id: number; x: number; y: number } | null = null;
    let lastDown: { id: number; target: EventTarget | null } | null = null;
    let captured: Element | null = null;
    let releaseLater: ReturnType<typeof setTimeout> | null = null;
    /** The page's own px per screen px, read as a touch starts. */
    let zoom = 1;
    let width = 0;
    const values = new TypedValues();
    const remember = (node: Element | null) => {
      if (node && el.contains(node)) values.remember(node as unknown as FieldNode);
    };
    remember(document.activeElement);

    const host: BackHost = {
      place(x, ease) {
        const page = latest.current.options.page.current;
        if (!page) return;
        if (x === null) {
          page.style.transform = "";
          page.style.opacity = "";
          page.style.transition = "";
          page.style.willChange = "";
          el.removeAttribute(BACK_SWIPE_ATTR);
          el.removeAttribute(BACK_TO_ATTR);
          return;
        }
        el.setAttribute(BACK_SWIPE_ATTR, "");
        if (ease) {
          // The browser takes the current place as the slide's start only once it has a style for it.
          void page.offsetHeight;
          el.setAttribute(BACK_TO_ATTR, String(Math.round(x)));
        }
        page.style.transition = ease ? `transform ${SLIDE_MS}ms ${EASE}, opacity ${SLIDE_MS}ms ${EASE}` : "none";
        page.style.willChange = "transform";
        page.style.transform = `translateX(${x / zoom}px)`;
        page.style.opacity = String(1 - FADE * Math.min(1, width > 0 ? x / width : 0));
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
      back() {
        const from = latest.current.options.item;
        // Rendered at once, so the page never shows at rest for a frame before the list or the panel's first page replaces it.
        flushSync(() => latest.current.options.onBack());
        return !el.isConnected || latest.current.options.item !== from;
      },
      reducedMotion() {
        return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      },
      unsaved() {
        if (latest.current.options.drafts?.any()) return true;
        const active = document.activeElement;
        return active !== null && el.contains(active) && values.changed(active as unknown as FieldNode);
      },
    };
    const swipe = new BackSession(host);
    session.current = swipe;

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
      if (!t || followed) return;
      // The sheet's own swipe has it, or its slide runs.
      if (el.hasAttribute(SWIPING_ATTR)) return;
      const target = e.target instanceof Element ? e.target : null;
      const page = latest.current.options.page.current;
      if (!page || !target || !el.contains(target)) return;
      const selection = document.getSelection();
      const selecting = selection !== null && !selection.isCollapsed && selection.anchorNode !== null && el.contains(selection.anchorNode);
      const owned = inEdgeZone(t.clientX) || selecting || ownsSideways(target as unknown as SidewaysNode, el as unknown as SidewaysNode, css);
      zoom = effectiveZoom(page);
      width = el.getBoundingClientRect().width;
      const started = swipe.begin({ owned, fingers: e.touches.length, at: e.timeStamp, width, scale: latest.current.scale });
      if (started) followed = { id: t.identifier, x: t.clientX, y: t.clientY };
    };
    const onMove = (e: TouchEvent) => {
      if (!followed) return;
      const t = touchOf(e.touches, followed.id);
      if (!t) return;
      const cancel = swipe.move({ dx: t.clientX - followed.x, dy: t.clientY - followed.y, at: e.timeStamp, cancelable: e.cancelable, taken: e.defaultPrevented });
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
    // Any new touch while one is followed, wherever it lands, cancels the swipe for good. The touch stays followed, so a claimed one's later moves and lift stay cancelled.
    const onDocStart = () => {
      if (followed) swipe.cancel();
    };
    const onDocEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) swipe.lifted();
    };

    el.addEventListener("touchstart", onStart, { passive: true });
    el.addEventListener("touchmove", onMove, { passive: false });
    el.addEventListener("touchend", onEnd, { passive: false });
    el.addEventListener("touchcancel", onCancel, { passive: true });
    el.addEventListener("pointerdown", onPointerDown, true);
    el.addEventListener("gotpointercapture", onCapture, true);
    el.addEventListener("focusin", onFocusIn);
    return () => {
      swipe.dispose();
      el.removeEventListener("touchstart", onStart);
      el.removeEventListener("touchmove", onMove);
      el.removeEventListener("touchend", onEnd);
      el.removeEventListener("touchcancel", onCancel);
      el.removeEventListener("pointerdown", onPointerDown, true);
      el.removeEventListener("gotpointercapture", onCapture, true);
      el.removeEventListener("focusin", onFocusIn);
      if (releaseLater) clearTimeout(releaseLater);
      claimed.current = null;
      if (session.current === swipe) session.current = null;
    };
  }, [surface, enabled]);

  // A new page or panel ends a drag at once, without motion, and drops a slide's back.
  const { item } = options;
  const shownItem = useRef(item);
  useLayoutEffect(() => {
    if (shownItem.current === item) return;
    shownItem.current = item;
    session.current?.stop();
  }, [item]);
}

function touchOf(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    if (t && t.identifier === id) return t;
  }
  return null;
}
