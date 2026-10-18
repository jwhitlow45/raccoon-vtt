import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { ScrollForMore } from "../canvas/TokenActionBar.tsx";
import { subscribeUiScale, uiScale } from "../features/device/settings.ts";
import { useBackClose } from "../lib/backClose.ts";
import { stopIndex, tabStops, type RadioMark } from "../lib/modalDialog.ts";
import { theme } from "../lib/theme.ts";
import { useScoped } from "../state/scope.ts";
import { isTextField } from "../state/shortcuts.ts";
import { sectionLabelLook } from "./Panel.tsx";
import { chromeRect, needsPlace, popoverPlace, type PlaceFrame, type PopoverSide, type Rect } from "./popoverPlace.ts";
import {
  closesAfterTab,
  escapeCloses,
  focusAfterLeave,
  focusMoveCloses,
  focusOnClose,
  isMapTarget,
  openFocus,
  openingStop,
  popoverSlot,
  tabOut,
  type CloseReason,
  type FocusAt,
  type OpenHow,
  type PopoverEntry,
  type PopoverRoom,
  type PressWhere,
} from "./popoverRules.ts";

export type { CloseReason, OpenHow } from "./popoverRules.ts";
export type { PopoverSide, Rect } from "./popoverPlace.ts";

/**
 * The shared popover base (docs/design-v1-tool-options.md 7.1): one
 * non-modal popover for the whole room, with the rules in
 * components/popoverRules.ts and the placement in popoverPlace.ts. A
 * consumer takes a handle from usePopover, spreads `anchorProps` on its
 * anchor, and renders <Popover> right after the anchor in the page, so the
 * popover is next in Tab order. "dialog" popovers hold a tool's choices
 * and settings (role="dialog", named by their title). "menu" popovers hold
 * a <Menu> (components/Menu.tsx): the side panel's More, Setup and Tools.
 *
 * Non-modal: no scrim, no inert room, no focus trap, so the map and every
 * control outside keep working. One popover is open in the room at a
 * time, whoever owns it. A press outside closes it as the press starts
 * and goes on to its target, while a press on the map only closes it,
 * once the press ends as one pointer, so a pinch keeps it open. Focus
 * goes in only when a key opened it. Escape, Tab, Shift+Tab, Android's
 * Back, focus moving away and its anchor leaving close it.
 *
 * The box stands at `theme.z.popover` in its stacking context. While it
 * is open, the consumer raises the element that holds it (the options
 * row, the toolbar, the side panel) to `theme.z.popover` too (7.6), so it
 * stands over notices and toasts.
 */

export type PopoverKind = "dialog" | "menu";

type FocusInside = (from: "first" | "last") => void;

export type PopoverHandle = {
  readonly kind: PopoverKind;
  /** The id of what the anchor controls while open: the dialog's box, or the menu. */
  readonly contentId: string;
  readonly open: boolean;
  /** How the open popover was opened. */
  readonly how: OpenHow;
  readonly anchor: RefObject<HTMLElement | null>;
  readonly box: RefObject<HTMLDivElement | null>;
  /** Moves focus into the open popover, as a key open does: a menu's checked item, else its first (or with "last", its last), or a dialog's chosen option, else its first control. */
  readonly focusInside: RefObject<FocusInside | null>;
  show(how: OpenHow): void;
  close(reason: CloseReason): void;
  /** The anchor's click: opens it, by a key when the click came from no pointer (`detail` 0), or closes it. */
  onAnchorClick(e: { detail: number }): void;
  /** Down and Up on a menu's anchor open it with focus in it, or move focus into it while open. Whether it used the key. */
  onAnchorKeyDown(e: ReactKeyboardEvent): boolean;
  /** Spread on the anchor, or take the parts a consumer composes with its own (More's tab keys). */
  readonly anchorProps: {
    ref(el: HTMLElement | null): void;
    "aria-haspopup": PopoverKind;
    "aria-expanded": boolean;
    "aria-controls": string | undefined;
    onClick(e: { detail: number }): void;
    onKeyDown(e: ReactKeyboardEvent): void;
  };
};

const POINTER_OPEN: OpenHow = { by: "pointer", from: "first" };

export function usePopover(options: {
  kind: PopoverKind;
  /** After it closed, with why. */
  onClose?(reason: CloseReason): void;
  /** Where focus goes on a close that would put it on the anchor, once the anchor has gone: ⋯ for a tool popover. */
  fallbackFocus?(): HTMLElement | null;
}): PopoverHandle {
  const room = useScoped(popoverSlot);
  const key = useId();
  const latest = useRef(options);
  latest.current = options;
  const anchor = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const how = useRef<OpenHow>(POINTER_OPEN);
  const focusInside = useRef<FocusInside | null>(null);
  /** The consumer is unmounting, and its anchor with it: focus goes to what the consumer names. */
  const leaving = useRef(false);
  const open = useSyncExternalStore(
    room.subscribe,
    () => room.current()?.key === key,
    () => false,
  );

  const entry = useMemo<PopoverEntry>(
    () => ({
      key,
      where: (target) => pressWhere(target, box.current, anchor.current),
      close(reason) {
        if (room.current()?.key !== key && reason !== "replaced") return;
        // Focus moves before the popover goes, so it never falls to the page on the way.
        if (focusOnClose(reason, focusAt(document.activeElement, box.current, anchor.current)) === "anchor") focusAnchor(leaving.current ? null : anchor.current, latest.current.fallbackFocus);
        room.release(key);
        latest.current.onClose?.(reason);
      },
    }),
    [room, key],
  );

  const show = useCallback(
    (h: OpenHow) => {
      attachRoom(room);
      how.current = h;
      room.open(entry);
      if (openFocus(h) === "anchor") anchor.current?.focus({ preventScroll: true });
    },
    [room, entry],
  );

  const anchorRef = useCallback(
    (el: HTMLElement | null) => {
      anchor.current = el;
      if (el) return;
      // Checked once the commit is done: React's development double mount detaches a ref and attaches it again.
      queueMicrotask(() => {
        if (anchor.current === null) entry.close("gone");
      });
    },
    [entry],
  );

  // A layout effect, so focus inside moves on before the popover's nodes leave the page.
  useLayoutEffect(
    () => () => {
      leaving.current = true;
      entry.close("gone");
      leaving.current = false;
    },
    [entry],
  );

  const kind = options.kind;
  const onAnchorClick = (e: { detail: number }) => {
    if (room.current()?.key === key) entry.close("anchor");
    else show(e.detail === 0 ? { by: "key", from: "first" } : POINTER_OPEN);
  };
  const onAnchorKeyDown = (e: ReactKeyboardEvent): boolean => {
    if (kind !== "menu" || e.altKey || e.ctrlKey || e.metaKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return false;
    e.preventDefault();
    const from = e.key === "ArrowUp" ? "last" : "first";
    if (room.current()?.key === key) focusInside.current?.(from);
    else show({ by: "key", from });
    return true;
  };
  const contentId = `${key}-popover`;
  return {
    kind,
    contentId,
    open,
    how: how.current,
    anchor,
    box,
    focusInside,
    show,
    close: entry.close,
    onAnchorClick,
    onAnchorKeyDown,
    anchorProps: {
      ref: anchorRef,
      "aria-haspopup": kind,
      "aria-expanded": open,
      "aria-controls": open ? contentId : undefined,
      onClick: onAnchorClick,
      onKeyDown: onAnchorKeyDown,
    },
  };
}

type PopoverContextValue = { handle: PopoverHandle; setInsideFocus(focus: FocusInside | null): void };

const PopoverContext = createContext<PopoverContextValue | null>(null);

/** The box's padding, which its "Scroll for more" sticks past to lie on the foot. */
const POPOVER_PAD = theme.space(3);

/** The popover a component renders in, for a <Menu>. */
export function usePopoverContext(): PopoverContextValue {
  const value = useContext(PopoverContext);
  if (!value) throw new Error("This component renders inside a Popover");
  return value;
}

export type PopoverProps = {
  handle: PopoverHandle;
  /** The side of its anchor it opens on. */
  side: PopoverSide;
  /**
   * The rectangle it keeps inside, in the chrome's own px, or a function
   * that measures it, read as it opens, at each render of its consumer and
   * whenever its anchor moves or the window resizes.
   */
  bound: Rect | (() => Rect);
  /** A taller rectangle it may grow into where the bound leaves less than `minHeight`. */
  rise?: Rect | (() => Rect) | null;
  /**
   * From its anchor's edge, or worked out from the anchor's rectangle where
   * the popover opens from a line other than that edge: a tool popover
   * stands 6 px above its options row or the toolbar, whatever the chip's
   * place inside them (docs/design-v1-tool-options.md 7.3).
   */
  gap?: number | ((anchor: Rect) => number);
  margin?: number;
  /** Below this the popover rises into `rise`: a tool popover's title and one 44 px row. */
  minHeight?: number;
  /** Drawn in the section label's look, and a dialog's name unless `label` gives another. */
  title?: string;
  /** A dialog's name where it draws no title, or where its name says more than its title: ⋯'s "More" is "More Area options". */
  label?: string;
  children: ReactNode;
};

/**
 * Whether an element stands inside an open popover. Focus there is the
 * popover's to keep: when its control goes, the popover moves focus to its
 * next control, else to its anchor. A consumer that keeps focus for its
 * own controls, such as the options row, leaves such focus alone, so it
 * never pulls it out to a control behind the popover.
 */
export function inPopoverBox(el: Element | null): boolean {
  return el?.closest("[data-rvtt-popover]") != null;
}

/** Drawn while its handle is open. */
export function Popover(props: PopoverProps) {
  return props.handle.open ? <OpenPopover {...props} /> : null;
}

function OpenPopover(props: PopoverProps) {
  const { handle } = props;
  const dialog = handle.kind === "dialog";
  const titleId = useId();
  const [more, setMore] = useState(false);
  const latest = useRef(props);
  latest.current = props;
  const frame = useRef<PlaceFrame | null>(null);
  const menuFocus = useRef<FocusInside | null>(null);
  const context = useMemo<PopoverContextValue>(() => ({ handle, setInsideFocus: (focus) => void (menuFocus.current = focus) }), [handle]);

  const updateMore = useCallback(() => {
    const box = latest.current.handle.box.current;
    if (box) setMore(box.scrollTop + box.clientHeight < box.scrollHeight - 1);
  }, []);

  /*
   * Placed as it opens, and again only when the anchor, the bound or the
   * rise region changes, never when its own content does: past its box
   * the content scrolls, so nothing under a finger moves because a choice
   * inside it added a line.
   */
  const place = useCallback(
    (force: boolean) => {
      const p = latest.current;
      const box = p.handle.box.current;
      const anchor = p.handle.anchor.current;
      if (!box || !anchor) return;
      const a = anchor.getBoundingClientRect();
      if (a.width === 0 && a.height === 0) {
        // Its surface hid: the options under a sheet, the side panel hidden.
        p.handle.close("gone");
        return;
      }
      const scale = uiScale();
      const next: PlaceFrame = { anchor: chromeRect(a, scale), bound: resolve(p.bound), rise: p.rise ? resolve(p.rise) : null };
      const gap = typeof p.gap === "function" ? p.gap(next.anchor) : (p.gap ?? theme.layout.popover.gap);
      if (!force && !needsPlace(frame.current, next)) return;
      frame.current = next;
      const margin = p.margin ?? theme.layout.popover.margin;
      const widest = Math.max(0, next.bound.right - next.bound.left - 2 * margin);
      const scrolled = box.scrollTop;
      // The content's natural size, wrapped at the widest the bound allows and at least the anchor's width.
      Object.assign(box.style, { left: "0px", top: "0px", height: "auto", width: "max-content", maxWidth: `${widest}px`, minWidth: `${Math.min(a.width / scale, widest)}px` });
      const natural = box.getBoundingClientRect();
      const at = popoverPlace({
        ...next,
        side: p.side,
        gap,
        margin,
        minHeight: p.minHeight ?? 0,
        content: { width: natural.width / scale, height: natural.height / scale },
      });
      Object.assign(box.style, { maxWidth: "", minWidth: "", left: `${at.left}px`, top: `${at.top}px`, width: `${at.width}px`, height: `${at.height}px` });
      box.scrollTop = scrolled;
      updateMore();
    },
    [updateMore],
  );

  useLayoutEffect(() => {
    const h = latest.current.handle;
    h.focusInside.current = (from) => {
      const box = h.box.current;
      if (menuFocus.current) menuFocus.current(from);
      else if (box) focusFirstStop(box);
    };
    place(true);
    if (openFocus(h.how) === "inside") h.focusInside.current(h.how.from);
    return () => {
      h.focusInside.current = null;
    };
    // Once as it opens. Later placements follow the frame (below and the listeners).
  }, [place]);

  // A consumer's render may carry a new bound or rise region: placed again only if the frame changed.
  useLayoutEffect(() => place(false));

  useEffect(() => {
    const h = latest.current.handle;
    const box = h.box.current;
    if (!box) return;
    /** The focused control inside, and the controls as they stood then, for when it leaves. A key open has already put focus inside, before this runs. */
    const first = document.activeElement;
    let held: { control: HTMLElement; controls: HTMLElement[] } | null = first instanceof HTMLElement && first !== box && box.contains(first) ? { control: first, controls: controlsIn(box) } : null;

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const at = focusAt(e.target, box, h.anchor.current);
      if (!escapeCloses({ textField: isTextField(e.target), inside: at === "inside" || at === "anchor", modalOver: modalOver(box) })) return;
      // Used, so the room's Escape, the map panes and the shortcuts, which all skip a used key, leave it alone.
      e.preventDefault();
      h.close("escape");
    };
    const onFocusIn = (e: FocusEvent) => {
      const at = focusAt(e.target, box, h.anchor.current);
      if (at === "inside" && e.target instanceof HTMLElement && e.target !== box) held = { control: e.target, controls: controlsIn(box) };
      if (focusMoveCloses(at)) h.close("focus");
    };
    const onMutate = () => {
      updateMore();
      if (!held || held.control.isConnected) return;
      const { control, controls } = held;
      held = null;
      if (focusAt(document.activeElement, box, h.anchor.current) !== "page") return;
      const next = focusAfterLeave(controls, control, (el) => el.isConnected && box.contains(el));
      if (next) next.focus({ preventScroll: true });
      else focusAnchor(h.anchor.current, null);
    };
    const onMoved = () => place(false);
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && box.contains(e.target)) return;
      place(false);
    };

    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocusIn, true);
    window.addEventListener("resize", onMoved);
    window.visualViewport?.addEventListener("resize", onMoved);
    document.addEventListener("scroll", onScroll, true);
    const unsubscribeScale = subscribeUiScale(onMoved);
    const resized = new ResizeObserver(onMoved);
    if (h.anchor.current) resized.observe(h.anchor.current);
    const mutated = new MutationObserver(onMutate);
    mutated.observe(box, { childList: true, subtree: true, characterData: true });
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocusIn, true);
      window.removeEventListener("resize", onMoved);
      window.visualViewport?.removeEventListener("resize", onMoved);
      document.removeEventListener("scroll", onScroll, true);
      unsubscribeScale();
      resized.disconnect();
      mutated.disconnect();
    };
  }, [place, updateMore]);

  useBackClose(true, () => latest.current.handle.close("back"));

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab" || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const box = e.currentTarget;
    const stops = handle.kind === "menu" ? [] : tabStopsIn(box);
    const out = tabOut({ kind: handle.kind, shift: e.shiftKey, index: stopIndex(stops, activeElement(), radioOf), count: stops.length });
    if (out === "anchor") {
      e.preventDefault();
      handle.close("shiftTab");
    } else if (out === "onward") {
      /*
       * The browser moves focus on, as Tab from the anchor would, and focus
       * arriving outside closes the popover. Past the page's last control
       * focus lands nowhere, so the popover closes here. This opening's box
       * leaves the page as it closes, and an opening after it draws a box
       * of its own, so the check tells the two apart (closesAfterTab).
       */
      setTimeout(() => {
        if (closesAfterTab({ sameOpening: box.isConnected, at: focusAt(document.activeElement, box, handle.anchor.current) })) handle.close("tab");
      }, 0);
    }
  };

  return (
    <PopoverContext.Provider value={context}>
      <div
        ref={handle.box}
        data-rvtt-popover=""
        id={dialog ? handle.contentId : undefined}
        role={dialog ? "dialog" : undefined}
        aria-labelledby={dialog && props.title && !props.label ? titleId : undefined}
        aria-label={dialog ? props.label : undefined}
        // A press on a part that is no control focuses the box, so it never reads as focus leaving.
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onScroll={updateMore}
        style={{
          position: "fixed",
          zIndex: theme.z.popover,
          boxSizing: "border-box",
          overflowY: "auto",
          overscrollBehavior: "contain",
          padding: POPOVER_PAD,
          background: theme.color.surface,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          borderRadius: theme.radius.lg,
          boxShadow: theme.shadow.pane,
          color: theme.color.text,
          fontFamily: theme.font.body,
        }}
      >
        {props.title ? (
          // A menu is named by its own label, so its title is not read twice.
          <div id={titleId} aria-hidden={dialog ? undefined : true} style={{ ...sectionLabelLook(), marginBottom: theme.space(2) }}>
            {props.title}
          </div>
        ) : null}
        {props.children}
        {more ? <ScrollForMore inset={POPOVER_PAD} /> : null}
      </div>
    </PopoverContext.Provider>
  );
}

/**
 * The room's window listeners for the map press rule (popoverRules.ts
 * pressStep), added the first time a popover opens in the room and kept
 * until the room goes, so a press that began with a popover open is
 * followed to its end even after the popover closed. Capture, so they run
 * before the map's own handlers: the map reads the press as suppressed
 * (PopoverRoom.suppressesTool) from its first event.
 */
function attachRoom(room: PopoverRoom): void {
  if (room.attached()) return;
  const down = (e: PointerEvent) => {
    const entry = room.current();
    const where: PressWhere = entry ? entry.where(e.target) : isMapTarget(e.target) ? "map" : "elsewhere";
    const step = room.press({ type: "down", pointerId: e.pointerId, where, open: entry !== null, pan: room.pans(e) });
    if (step.close === "now") entry?.close("press");
  };
  const end = (e: PointerEvent) => {
    const step = room.press({ type: e.type === "pointerup" ? "up" : "cancel", pointerId: e.pointerId });
    if (step.close === "end") room.current()?.close("map");
    // The map's handlers for this last event run after this listener and still read the press as suppressed. The map settles it as its last pointer lifts (canvas/Stage.tsx), and this covers a press whose map went away meanwhile.
    if (step.state === null && step.suppress) setTimeout(() => room.settle(), 0);
  };
  window.addEventListener("pointerdown", down, true);
  window.addEventListener("pointerup", end, true);
  window.addEventListener("pointercancel", end, true);
  room.attach(() => {
    window.removeEventListener("pointerdown", down, true);
    window.removeEventListener("pointerup", end, true);
    window.removeEventListener("pointercancel", end, true);
  });
}

function resolve(rect: Rect | (() => Rect)): Rect {
  return typeof rect === "function" ? rect() : rect;
}

function within(container: Element | null, target: unknown): boolean {
  return container !== null && target instanceof Node && container.contains(target);
}

function pressWhere(target: unknown, box: Element | null, anchor: Element | null): PressWhere {
  if (within(box, target)) return "inside";
  if (within(anchor, target)) return "anchor";
  return isMapTarget(target) ? "map" : "elsewhere";
}

function focusAt(target: unknown, box: Element | null, anchor: Element | null): FocusAt {
  if (!(target instanceof Node) || target === document.body || target === document) return "page";
  if (within(box, target)) return "inside";
  return within(anchor, target) ? "anchor" : "outside";
}

function activeElement(): HTMLElement | null {
  return document.activeElement instanceof HTMLElement ? document.activeElement : null;
}

function drawn(el: HTMLElement): boolean {
  return el.isConnected && el.getClientRects().length > 0;
}

/** The anchor while it is drawn, else what the consumer names. */
function focusAnchor(anchor: HTMLElement | null, fallback: (() => HTMLElement | null) | null | undefined): void {
  const target = anchor && drawn(anchor) ? anchor : (fallback?.() ?? null);
  target?.focus({ preventScroll: true });
}

/** Whether a modal dialog is open that the popover is not in. "View as a player" is one, with the preview's own popovers inside. */
function modalOver(box: Element): boolean {
  return [...document.querySelectorAll('[aria-modal="true"]')].some((dialog) => !dialog.contains(box));
}

const TAB_STOPS = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const CONTROLS = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

function radioOf(el: HTMLElement): RadioMark | null {
  return el instanceof HTMLInputElement && el.type === "radio" && el.name ? { name: el.name, checked: el.checked } : null;
}

/** Where Tab stops in the popover, a group of native radios being one stop (lib/modalDialog.ts tabStops). */
function tabStopsIn(root: HTMLElement): HTMLElement[] {
  return tabStops([...root.querySelectorAll<HTMLElement>(TAB_STOPS)].filter(drawn), radioOf);
}

/** Every control that can hold focus, a menu's items included, a group of radios as its one stop, for where focus goes when the focused one leaves. */
function controlsIn(root: HTMLElement): HTMLElement[] {
  return tabStops([...root.querySelectorAll<HTMLElement>(CONTROLS)].filter(drawn), radioOf);
}

/** A dialog popover's key open: its chosen option, else its first control, else the box itself. */
function focusFirstStop(box: HTMLElement): void {
  const stops = tabStopsIn(box);
  focusInView(stops[openingStop(stops.map((el) => radioOf(el)?.checked === true))] ?? box);
}

/** Focus on a control inside a popover, scrolled into the popover's view where its content scrolls. */
export function focusInView(el: HTMLElement): void {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
}
