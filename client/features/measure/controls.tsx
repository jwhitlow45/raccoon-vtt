import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type Ref,
} from "react";
import { Button } from "../../components/Button.tsx";
import { Input, Select } from "../../components/Field.tsx";
import { Icon, type IconName } from "../../components/Icon.tsx";
import { buttonLook, choiceLook } from "../../components/looks.ts";
import { MeasuringContext } from "../../components/measuring.ts";
import { sectionLabelLook } from "../../components/Panel.tsx";
import { inPopoverBox, Popover, usePopover, type PopoverHandle } from "../../components/Popover.tsx";
import type { Rect } from "../../components/popoverPlace.ts";
import { Segmented, type SegmentedOption } from "../../components/Segmented.tsx";
import { Swatches, type SwatchOption } from "../../components/Swatches.tsx";
import { accessibleName, VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { HoldRepeat, type RepeatValue } from "../../lib/holdRepeat.ts";
import { theme } from "../../lib/theme.ts";
import { fitRow, heldFit, POPOVER_MIN, SLOT_GAP, type Arrangement, type FitSlot, type RowFit, type SlotForm } from "../../pages/optionsLayout.ts";
import { uiScale } from "../device/settings.ts";

/**
 * The map tools' options (docs/design-v1-tool-options.md 6 to 8): one row
 * of 44 px controls that never wraps and never scrolls, a line above it
 * for the tool's hint or reading, and ⋯ for what the row has no room for.
 * Each tool lists its controls as slots (OptionsStrip), and the strip
 * measures them and fits them to the room Room gives it
 * (pages/optionsLayout.ts fitRow). A choice with many values is a value
 * chip that opens a small popover on the shared base (components/Popover.tsx).
 *
 * The kit's controls draw by where they stand (SlotPlace): inline in the
 * row in a full or compact form, as a row or a labelled group in ⋯'s
 * popover or a chip's, or as a hidden copy in the measuring layer. Outside
 * a strip, as in a pane on the map, they draw as plain controls. Every
 * control is a 44 px touch target with no hover-only state (design
 * section 14.4).
 */

// ------------------------------------------------------------ where a control draws

export type { SlotForm } from "../../pages/optionsLayout.ts";

/**
 * Where a kit control draws:
 * - "row": inline in the options row, in `form`, `width` wide where it is flexible.
 * - "more": in ⋯'s popover, as a row as wide as the popover, or a labelled group.
 * - "popover": waiting in a value chip's popover, as in ⋯.
 * - "measure": a hidden copy in the measuring layer, in `form`, whose width the strip reads.
 */
export type SlotPlace = { at: "row" | "more" | "popover" | "measure"; form: SlotForm; id: string; width?: number };

const SlotPlaceContext = createContext<SlotPlace | null>(null);

/** Where the control in this slot draws, or null outside a strip. */
export function useSlotPlace(): SlotPlace | null {
  return useContext(SlotPlaceContext);
}

/** In ⋯'s popover or a chip's, where a control takes the popover's width. */
function inPopover(place: SlotPlace | null): boolean {
  return place?.at === "more" || place?.at === "popover";
}

/**
 * What closes the popover a control stands in (7.2): a pick in a choice
 * popover, and a button that ends the tool's task in any popover (Place,
 * Done, Discard, a confirm's second press). In ⋯ a pick closes nothing,
 * since ⋯ holds settings changed in a row.
 */
type Closers = { pick: (() => void) | null; task: (() => void) | null };
const CloseContext = createContext<Closers>({ pick: null, task: null });

export function usePopoverClose(): Closers {
  return useContext(CloseContext);
}

// ------------------------------------------------------------ the frame Room gives the strip

/** Where the strip's popovers stand (7.3), all in the chrome's own px. */
export type PopoverFrame = { bound(): Rect; rise: (() => Rect) | null; gap(anchor: Rect): number };

/**
 * What Room's options element gives the strip inside it
 * (pages/Room.tsx): the room the row may use, where the line floats, the
 * popovers' frame, and the ways back to Room. Without one, as in a test,
 * the strip measures its own width and draws its line above itself.
 */
export type OptionsFrame = {
  /** The width the row may use for its controls, in layout px. */
  room: number;
  arrangement: Arrangement;
  popover: PopoverFrame;
  /** Where the line floats, from the options element's left edge, how wide it may grow, and how far its foot stands above the element's top past the 6 px gap. Null draws it in flow above the row. */
  line: { left: number; maxWidth: number; lift?: number } | null;
  /** The tool's options are tucked (5.4): the row hides, and the line too unless a task is under way. */
  tucked: boolean;
  /** Something stands where the line floats: a popover of the toolbar's, Setup or Tools, or the top bars, where the map is shorter than the line. */
  covered: boolean;
  /** Shows tucked options again, from the "options hidden" pill. */
  show(): void;
  /** While a popover of the strip is open, the options element stands at theme.z.popover (7.6). */
  raise(open: boolean): void;
  /** Whether a task is under way (5.4), which keeps the "options hidden" pill while tucked. */
  task(under: boolean): void;
  /** Whether the tool's state has no row (6.6): then only its line shows, 6 px above the toolbar, where the row does not stack. */
  rowless(none: boolean): void;
  /** The options element's description (Multi-select's whole sentence, 9.1). */
  describe(text: string | null): void;
  /** The active tool's button, where focus goes when nothing in the row is left to take it. */
  toolButton(): HTMLElement | null;
};

export const OptionsFrameContext = createContext<OptionsFrame | null>(null);

/** Until Room gives a frame: the whole window, with no room to rise into. */
const WINDOW_POPOVER: PopoverFrame = {
  bound() {
    const scale = uiScale();
    return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
  },
  rise: null,
  gap: () => theme.layout.popover.gap,
};

/** What the strip gives the controls in it. */
type StripApi = {
  tool: string;
  popover: PopoverFrame;
  /** The slots waiting in a chip's popover, drawn there. */
  homed(chip: string): ReactNode;
  /** A chip's popover opened or closed, so the fit keeps its anchor in the row. */
  opened(id: string, open: boolean): void;
  /** ⋯, where focus goes from a chip whose popover closed after the chip left the row, else the tool's button. */
  fallback(): HTMLElement | null;
};

const StripContext = createContext<StripApi | null>(null);

/** Where a popover of the strip stands: Room's frame, or the window outside one. */
export function usePopoverFrame(): PopoverFrame {
  return useContext(StripContext)?.popover ?? WINDOW_POPOVER;
}

/**
 * Tells the strip that a popover anchored in this slot is open, as a
 * value chip does by itself: the fit keeps the slot in the row, and the
 * options element rises over the notices (6.4, 7.6). For a popover a
 * control opens on its own, such as the spell field's results.
 */
export function useOpenInSlot(open: boolean): void {
  const strip = useContext(StripContext);
  const id = useSlotPlace()?.id ?? null;
  const opened = strip?.opened;
  useLayoutEffect(() => {
    if (!id || !opened) return;
    opened(id, open);
    return () => opened(id, false);
  }, [id, opened, open]);
}

// ------------------------------------------------------------ the strip

/** One control of a tool's options row (6.1). */
export type Slot = {
  /** Unique in the tool. The slot's place in the list is its display order. */
  id: string;
  /** 1, the highest, to 9. */
  priority: number;
  /** A kit control, which draws by where it stands (SlotPlace). */
  control: ReactNode;
  /** It has a compact form: a chip's glyph or swatch alone, short words, a choice of two as a chip, or an icon alone (OptButton `compactIcon`). */
  compact?: boolean;
  /** A value chip whose options all have glyphs: glyph and words where the row has room (6.2). */
  glyph?: boolean;
  /** The slot whose value this chip shows while that slot waits in its popover ("Sphere 20 ft"). */
  hosts?: string;
  /** The chip whose popover holds it when it does not fit the row. Left out, ⋯. */
  home?: string;
  /** Flexible: it fits at this width and grows into what the row leaves, up to its own width. */
  flex?: number;
  /** Always in ⋯: the tool's fixed ⋯ content, such as Clear all. */
  always?: boolean;
  /** Its heading in ⋯ ("More area options"). */
  group?: string;
  /** A smaller label over a run of slots inside its group ("Reminders"). */
  sub?: string;
  /** A part of the row, such as a selected stamp's: a line stands before its first inline slot after another part's. */
  part?: string;
};

/** The line's tone (8): a hint, a reading, a warning, or a status such as "Grid saved". */
export type LineTone = "hint" | "reading" | "warning" | "status";

/** `finding`: the reading is being worked out, such as a walking ruler's search, marked `data-finding` on the line so a run can see the search happen. */
export type StripLine = { tone: LineTone; content: ReactNode; finding?: boolean };

/**
 * A tool's options as one row and its line (6): the slots that fit
 * inline in display order, then ⋯ for the rest, fitted by
 * pages/optionsLayout.ts fitRow to the room Room gives.
 *
 * Every slot that may stand in the row is drawn once more in a hidden,
 * inert measuring layer, in each of its forms, and its widths are read in
 * layout px before paint. The fit runs again whenever the room, the slots
 * or a width change. It holds while a press that began on the row is
 * down and while ⋯ is open, never moves the focused control or the anchor
 * of an open popover out of the row, and when the focused control leaves,
 * focus goes to the slot in its place, never to the page (6.4).
 */
export function OptionsStrip(props: {
  /** The tool's label, which names ⋯'s popover: "More Area options". */
  tool: string;
  line?: StripLine | null;
  /** In display order. Leave a slot out with a falsy value where it does not show now (`cond && slot`). */
  slots: readonly (Slot | false | null | undefined | "" | 0)[];
  /** A task under way (5.4): tucked, the line stays as the "options hidden" pill. */
  task?: boolean;
  /** The options element's description, where the row shows less than the whole sentence (9.1). */
  description?: string;
}) {
  const frame = useContext(OptionsFrameContext);
  const slots = props.slots.filter((s): s is Slot => !!s);
  const inRow = slots.filter((s) => !s.always);
  const always = slots.filter((s) => s.always === true);
  const byId = new Map(slots.map((s) => [s.id, s]));

  // The room: Room's, or the strip's own width outside a frame.
  const outer = useRef<HTMLDivElement>(null);
  const [ownRoom, setOwnRoom] = useState<number | null>(null);
  const framed = frame !== null;
  useLayoutEffect(() => {
    const el = outer.current;
    if (framed || !el) return;
    const read = () => setOwnRoom(el.getBoundingClientRect().width / uiScale());
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [framed]);
  const room = frame?.room ?? ownRoom;

  // The widths of every form, in layout px, read before paint.
  const layer = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Readonly<Record<string, number>>>({});
  const measure = useCallback(() => {
    const el = layer.current;
    if (!el) return;
    const scale = uiScale();
    const next: Record<string, number> = {};
    for (const copy of el.querySelectorAll<HTMLElement>("[data-measure]")) next[copy.dataset.measure ?? ""] = copy.getBoundingClientRect().width / scale;
    setWidths((prev) => (sameWidths(prev, next) ? prev : next));
  }, []);
  useLayoutEffect(measure);
  // A font that loads, or a new interface size, changes the copies' widths without a render.
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [measure]);

  // What holds the fit still (6.4).
  const [focused, setFocused] = useState<string | null>(null);
  const [anchor, setAnchor] = useState<string | null>(null);
  const [pressed, setPressed] = useState(false);
  const toolButton = useRef(frame?.toolButton);
  toolButton.current = frame?.toolButton;
  const moreButton = useRef<HTMLElement | null>(null);
  const more = usePopover({ kind: "dialog", fallbackFocus: () => toolButton.current?.() ?? null });

  const fitSlots = inRow.map((s) => fitSlotOf(s, widths));
  const measured = fitSlots.every((s): s is FitSlot => s !== null);
  const last = useRef<RowFit | null>(null);
  let fit: RowFit | null = null;
  if (room !== null) {
    const known = fitSlots.filter((s): s is FitSlot => s !== null);
    const input = { room, slots: known, alwaysMore: always.length > 0, pins: [focused, anchor].filter((id): id is string => id !== null) };
    const before = last.current;
    if (before && (pressed || more.open || !measured)) fit = heldFit(before, input, more.open);
    else if (measured) fit = fitRow(input);
  }
  useLayoutEffect(() => {
    last.current = fit;
  });

  // Focus never falls to the page (6.4): the control holding it left the row.
  const rowEl = useRef<HTMLDivElement | null>(null);
  const focus = useFocusKeeper({ fit, order: inRow.map((s) => s.id), row: rowEl, moreButton, toolButton, onFocused: setFocused });

  // The row refits once the press that began on it ends.
  const onPointerDown = () => {
    if (pressed) return;
    setPressed(true);
    const end = () => {
      window.removeEventListener("pointerup", end, true);
      window.removeEventListener("pointercancel", end, true);
      setPressed(false);
    };
    window.addEventListener("pointerup", end, true);
    window.addEventListener("pointercancel", end, true);
  };

  const opened = useCallback((id: string, open: boolean) => setAnchor((prev) => (open ? id : prev === id ? null : prev)), []);
  const anyOpen = more.open || anchor !== null;
  const raise = frame?.raise;
  useLayoutEffect(() => {
    raise?.(anyOpen);
  }, [raise, anyOpen]);
  useLayoutEffect(() => () => raise?.(false), [raise]);
  const task = frame?.task;
  const under = props.task === true;
  useLayoutEffect(() => {
    task?.(under);
    return () => task?.(false);
  }, [task, under]);
  const description = useStripDescription(frame, outer, props.description ?? null);
  const rowless = frame?.rowless;
  const none = slots.length === 0;
  useLayoutEffect(() => {
    rowless?.(none);
    return () => rowless?.(false);
  }, [rowless, none]);

  const popover = frame?.popover ?? WINDOW_POPOVER;
  const homes = fit?.homes ?? {};
  const api: StripApi = {
    tool: props.tool,
    popover,
    homed: (chip) => (homes[chip] ?? []).map((id) => {
      const slot = byId.get(id);
      return slot ? <SlotFrame key={id} slot={slot} place={{ at: "popover", form: "full", id }} /> : null;
    }),
    opened,
    fallback: () => (moreButton.current?.isConnected ? moreButton.current : (toolButton.current?.() ?? null)),
  };

  const tucked = frame?.tucked === true;
  const waiting = (fit?.more ?? []).flatMap((id) => byId.get(id) ?? []);
  const row = fit?.row ?? [];
  return (
    <StripContext.Provider value={api}>
      <div ref={outer} data-options-strip="" style={{ display: "flex", flexDirection: "column", gap: theme.space(1), width: "100%", minWidth: 0 }}>
        {props.line || (tucked && under) ? (
          <OptionsLine line={props.line ?? null} tool={props.tool} frame={frame} hidden={anyOpen || frame?.covered === true} tucked={tucked} task={under} />
        ) : null}
        {slots.length === 0 ? null : (
        <div
          ref={rowEl}
          data-options-row=""
          hidden={tucked}
          onPointerDownCapture={onPointerDown}
          onFocusCapture={focus.onFocus}
          onBlurCapture={focus.onBlur}
          style={{ position: "relative", display: tucked ? "none" : "flex", alignItems: "center", gap: SLOT_GAP, minWidth: 0, minHeight: theme.touch }}
        >
          {row.map((placed, i) => {
            const slot = byId.get(placed.id);
            if (!slot) return null;
            const previous = i > 0 ? byId.get(row[i - 1]!.id) : undefined;
            const divided = previous !== undefined && (previous.part ?? "") !== (slot.part ?? "");
            return (
              <Fragment key={slot.id}>
                {divided ? <OptionsDivider /> : null}
                <SlotFrame slot={slot} holds={homes[slot.id]} place={{ at: "row", form: placed.form, id: slot.id, width: slot.flex !== undefined ? placed.width : undefined }} />
              </Fragment>
            );
          })}
          {fit?.hasMore ? <MoreButton handle={more} tool={props.tool} buttonRef={moreButton} popover={popover} waiting={waiting} always={always} /> : null}
        </div>
        )}
        {/* Beside the row, not in it, so it measures while the row is tucked away. */}
        {inRow.length > 0 ? <MeasureLayer ref={layer} slots={inRow} /> : null}
        {description}
      </div>
    </StripContext.Provider>
  );
}

function sameWidths(a: Readonly<Record<string, number>>, b: Readonly<Record<string, number>>): boolean {
  const keys = Object.keys(b);
  return keys.length === Object.keys(a).length && keys.every((k) => Math.abs((a[k] ?? -1) - (b[k] ?? 0)) < 0.25);
}

/** The forms a slot draws in, which the measuring layer draws each of. */
function formsOf(slot: Slot): SlotForm[] {
  const forms: SlotForm[] = ["full"];
  if (slot.compact) forms.push("compact");
  if (slot.glyph) forms.push("glyph");
  if (slot.hosts) forms.push(...(slot.glyph ? (["hosts", "hostsGlyph"] as const) : (["hosts"] as const)));
  return forms;
}

/** A slot with its measured widths, or null until they are read. */
function fitSlotOf(slot: Slot, widths: Readonly<Record<string, number>>): FitSlot | null {
  const w = (form: SlotForm) => widths[`${slot.id}:${form}`];
  const full = w("full");
  if (full === undefined) return null;
  return {
    id: slot.id,
    priority: slot.priority,
    full: slot.flex !== undefined ? Math.min(slot.flex, full) : full,
    ...(slot.flex !== undefined ? { max: full } : {}),
    ...(slot.compact ? { compact: w("compact") ?? full } : {}),
    ...(slot.glyph ? { glyph: w("glyph") ?? full } : {}),
    ...(slot.hosts ? { hosts: { id: slot.hosts, words: w("hosts") ?? full, ...(slot.glyph ? { glyph: w("hostsGlyph") ?? full } : {}) } } : {}),
    ...(slot.home !== undefined ? { home: slot.home } : {}),
    ...(slot.part !== undefined ? { part: slot.part } : {}),
  };
}

/**
 * One slot where it is drawn: the row, ⋯ or a chip's popover. For the
 * tests, never in the measuring layer: `data-rvtt-slot` names it,
 * `data-rvtt-priority` gives its priority, and a chip in the row lists the
 * slots waiting in its popover in `data-rvtt-holds`.
 */
function SlotFrame(props: { slot: Slot; place: SlotPlace; holds?: readonly string[] }) {
  const { place } = props;
  const row = place.at === "row";
  return (
    <div
      data-rvtt-slot={props.slot.id}
      data-rvtt-priority={props.slot.priority}
      data-rvtt-holds={props.holds && props.holds.length > 0 ? props.holds.join(" ") : undefined}
      style={row ? { flex: "none", display: "flex", alignItems: "center", width: place.width, minWidth: 0 } : { display: "grid", minWidth: 0 }}
    >
      <SlotPlaceContext.Provider value={place}>{props.slot.control}</SlotPlaceContext.Provider>
    </div>
  );
}

/**
 * Every slot that may stand in the row, in each of its forms, hidden and
 * inert, out of flow and clipped to nothing, so it never adds to what the
 * row scrolls or what a screen reader reads (6.2).
 */
function MeasureLayer(props: { ref: Ref<HTMLDivElement>; slots: readonly Slot[] }) {
  return (
    <div aria-hidden style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div ref={props.ref} inert style={{ position: "absolute", left: 0, top: 0, display: "flex", alignItems: "flex-start", gap: SLOT_GAP, width: "max-content", visibility: "hidden" }}>
        <MeasuringContext.Provider value={true}>
          {props.slots.flatMap((slot) =>
            formsOf(slot).map((form) => (
              <div key={`${slot.id}:${form}`} data-measure={`${slot.id}:${form}`} style={{ flex: "none", display: "flex" }}>
                <SlotPlaceContext.Provider value={{ at: "measure", form, id: slot.id }}>{slot.control}</SlotPlaceContext.Provider>
              </div>
            )),
          )}
        </MeasuringContext.Provider>
      </div>
    </div>
  );
}

/**
 * Where focus goes when the control holding it leaves the row, whether
 * into ⋯ or because its state ended (Fog's Discard, a stamp's Done): the
 * slot now in its place in display order, else the one before it, else
 * ⋯, else the active tool's button. Focus that left by a press elsewhere
 * is not followed.
 */
function useFocusKeeper(input: {
  fit: RowFit | null;
  order: readonly string[];
  /** This strip's own row: a player preview draws a second room with slots of the same names. */
  row: { current: HTMLElement | null };
  moreButton: { current: HTMLElement | null };
  toolButton: { current: (() => HTMLElement | null) | undefined };
  /** The slot holding focus in the row, or null, which the fit keeps in the row (6.4). */
  onFocused(id: string | null): void;
}) {
  const held = useRef<{ id: string; el: HTMLElement; order: readonly string[] } | null>(null);
  const { fit, order } = input;
  useLayoutEffect(() => {
    const was = held.current;
    if (!was || was.el.isConnected || !fit) return;
    held.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) {
      // Focus went on by itself: the pin goes with it unless it went to another inline control, which pinned itself.
      if (inlineSlotOf(input.row.current, active) === null) input.onFocused(null);
      return;
    }
    const inline = new Set(fit.row.map((p) => p.id));
    const at = was.order.indexOf(was.id);
    const after = was.order.slice(Math.max(0, at)).find((id) => inline.has(id) && order.includes(id));
    const before = was.order.slice(0, Math.max(0, at)).reverse().find((id) => inline.has(id));
    const pick = (id: string | undefined) => (id ? firstControl(input.row.current?.querySelector(`:scope > [data-rvtt-slot="${CSS.escape(id)}"]`) ?? null) : null);
    const target = pick(after) ?? pick(before) ?? (input.moreButton.current?.isConnected ? input.moreButton.current : null) ?? input.toolButton.current?.() ?? null;
    target?.focus({ preventScroll: true });
    if (target === null || inlineSlotOf(input.row.current, target) === null) input.onFocused(null);
  });
  return {
    onFocus(e: { target: EventTarget }) {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const id = inlineSlotOf(input.row.current, el);
      if (el === null || id === null) return;
      held.current = { id, el, order };
      input.onFocused(id);
    },
    onBlur(e: { target: EventTarget }) {
      const el = e.target;
      // Checked once the event is done: a control that leaves the page blurs on the way out and must still be followed.
      queueMicrotask(() => {
        if (held.current?.el !== el || !held.current.el.isConnected || document.activeElement === el) return;
        held.current = null;
        // Into the chip's own popover, to ⋯ or out of the row: no inline control holds focus, so nothing is pinned. An open popover's anchor keeps its own pin.
        if (inlineSlotOf(input.row.current, document.activeElement) === null) input.onFocused(null);
      });
    },
  };
}

/**
 * The slot whose inline control `el` is, in this strip's own row, or
 * null. The pin follows only these (6.4): focus in a popover is the
 * popover's to keep (components/Popover.tsx inPopoverBox), and ⋯ is no
 * slot.
 */
function inlineSlotOf(row: HTMLElement | null, el: Element | null): string | null {
  if (row === null || !(el instanceof HTMLElement) || inPopoverBox(el)) return null;
  const slot = el.closest<HTMLElement>("[data-rvtt-slot]");
  return slot !== null && slot.parentElement === row ? (slot.dataset.rvttSlot ?? null) : null;
}

function firstControl(root: Element | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? null;
}

/**
 * The options element's description (9.1): through Room's frame, or
 * outside one on the nearest toolbar, as a hidden line beside the strip.
 */
function useStripDescription(frame: OptionsFrame | null, outer: { current: HTMLElement | null }, text: string | null): ReactNode {
  const id = useId();
  const describe = frame?.describe;
  useLayoutEffect(() => {
    if (describe) {
      describe(text);
      return () => describe(null);
    }
    const toolbar = outer.current?.closest('[role="toolbar"]');
    if (!toolbar || text === null) return;
    toolbar.setAttribute("aria-describedby", id);
    return () => {
      if (toolbar.getAttribute("aria-describedby") === id) toolbar.removeAttribute("aria-describedby");
    };
  }, [describe, text, id, outer]);
  if (describe || text === null) return null;
  return (
    <span id={id} hidden>
      {text}
    </span>
  );
}

// ------------------------------------------------------------ ⋯ (6.5)

/**
 * ⋯, always last in the row, and its "More" popover: the slots waiting for
 * it in display order, then the tool's content always in ⋯ in its own
 * order, each under its group's heading. Inside, every slot uses its full
 * form, a chip shows its own popover's content inline, and a button that
 * ends the tool's task closes it after it acts.
 */
function MoreButton(props: { handle: PopoverHandle; tool: string; buttonRef: { current: HTMLElement | null }; popover: PopoverFrame; waiting: readonly Slot[]; always: readonly Slot[] }) {
  const { handle } = props;
  const closers = useMemo<Closers>(() => ({ pick: null, task: () => handle.close("pick") }), [handle]);
  const anchorRef = handle.anchorProps.ref;
  const ref = useCallback(
    (el: HTMLElement | null) => {
      props.buttonRef.current = el;
      anchorRef(el);
    },
    [anchorRef, props.buttonRef],
  );
  return (
    <div data-rvtt-more="" style={{ flex: "none", display: "flex" }}>
      <Button
        size="sm"
        {...handle.anchorProps}
        ref={ref}
        expanded={handle.open}
        aria-label="More options"
        title="More options"
        style={{ width: theme.touch, padding: 0 }}
      >
        <Icon name="more" />
      </Button>
      <Popover handle={handle} side="above" bound={props.popover.bound} rise={props.popover.rise} gap={props.popover.gap} minHeight={POPOVER_MIN} title="More" label={`More ${props.tool} options`}>
        <CloseContext.Provider value={closers}>
          <div style={{ display: "grid", gap: theme.space(2) }}>
            {groupsOf([...props.waiting, ...props.always]).map((group, i) => (
              <MoreGroup key={`${group.title ?? ""}-${i}`} title={group.title} slots={group.slots} />
            ))}
          </div>
        </CloseContext.Provider>
      </Popover>
    </div>
  );
}

/** Runs of slots under one heading, in order. */
function groupsOf(slots: readonly Slot[]): { title: string | undefined; slots: Slot[] }[] {
  const groups: { title: string | undefined; slots: Slot[] }[] = [];
  for (const slot of slots) {
    const last = groups[groups.length - 1];
    if (last && last.title === slot.group) last.slots.push(slot);
    else groups.push({ title: slot.group, slots: [slot] });
  }
  return groups;
}

/** Runs of slots under one smaller label inside a group, in order. */
function runsOf(slots: readonly Slot[]): { sub: string | undefined; slots: Slot[] }[] {
  const runs: { sub: string | undefined; slots: Slot[] }[] = [];
  for (const slot of slots) {
    const last = runs[runs.length - 1];
    if (last && last.sub === slot.sub) last.slots.push(slot);
    else runs.push({ sub: slot.sub, slots: [slot] });
  }
  return runs;
}

function MoreGroup(props: { title: string | undefined; slots: readonly Slot[] }) {
  const id = useId();
  const content = runsOf(props.slots).map((run) => {
    const frames = run.slots.map((slot) => <SlotFrame key={slot.id} slot={slot} place={{ at: "more", form: "full", id: slot.id }} />);
    return run.sub ? (
      <div key={`sub-${run.slots[0]!.id}`} role="group" aria-label={run.sub} style={{ display: "grid", gap: theme.space(1) }}>
        <div aria-hidden style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
          {run.sub}
        </div>
        {frames}
      </div>
    ) : (
      frames
    );
  });
  if (!props.title) return <>{content}</>;
  return (
    <div role="group" aria-labelledby={id} style={{ display: "grid", gap: theme.space(1) }}>
      <div id={id} style={{ ...sectionLabelLook(), paddingTop: theme.space(1) }}>
        {props.title}
      </div>
      {content}
    </div>
  );
}

// ------------------------------------------------------------ the line (8)

/**
 * The tool's hint or reading, one line in a pill above the row. Where its
 * words do not fit they end in an ellipsis and the pill becomes a button
 * that shows the whole line, wrapping upward to four lines and scrolling
 * past that, until another tap, a tap anywhere else, a popover or a tool
 * change folds it. A pill that is not cut takes taps without doing
 * anything, so a tap on it never reaches the map. While a popover stands
 * over it, it is hidden from sight but stays the one polite live region,
 * so a reading that changes is still spoken. Tucked mid-task, it reads
 * "<tool> options hidden. Tap to show." and shows them again (5.4).
 */
function OptionsLine(props: { line: StripLine | null; tool: string; frame: OptionsFrame | null; hidden: boolean; tucked: boolean; task: boolean }) {
  const { line, frame } = props;
  const words = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  const [open, setOpen] = useState(false);
  const pill = props.tucked && props.task;
  // A popover over it, or the options tucked, folds it.
  useEffect(() => {
    if (props.hidden || props.tucked) setOpen(false);
  }, [props.hidden, props.tucked]);
  // Whether its words are cut: read after every render, and again when its box changes size.
  const readCut = useCallback(() => {
    const el = words.current;
    if (el && !openRef.current) setCut(el.scrollWidth > el.clientWidth + 1);
  }, []);
  const openRef = useRef(open);
  openRef.current = open;
  useLayoutEffect(readCut);
  useEffect(() => {
    const el = words.current;
    if (!el) return;
    const observer = new ResizeObserver(readCut);
    observer.observe(el);
    return () => observer.disconnect();
  }, [readCut, cut, open, pill]);
  // A tap anywhere else folds it, and goes on to what it pressed.
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (e.target instanceof Node && box.current?.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", down, true);
    return () => window.removeEventListener("pointerdown", down, true);
  }, [open]);

  const tone = line?.tone ?? "hint";
  const reading = !pill && tone !== "hint";
  const floating = frame?.line ?? null;
  const look: CSSProperties = {
    boxSizing: "border-box",
    // A column that centers its words in the height below, so a 13 px hint shares a 14 px reading's middle rather than its top.
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    maxWidth: floating ? floating.maxWidth : "100%",
    width: "fit-content",
    padding: `${LINE_PAD.y}px ${LINE_PAD.x}px`,
    borderRadius: theme.radius.sm,
    background: theme.color.overlay,
    border: `${theme.line.border}px solid ${theme.color.border}`,
    fontSize: tone === "reading" && !pill ? theme.font.body14 : theme.font.small,
    // A reading changes as the pointer moves, so its digits keep one width.
    fontVariantNumeric: tone === "reading" ? "tabular-nums" : undefined,
    lineHeight: theme.leading.body,
    // A hint's 13 px stands as tall as a reading's 14 px. The line's height is the map's reserve (pages/Room.tsx useOptionsBox), so a hint turning into a reading as a drag starts would otherwise refit the map under the pointer.
    minHeight: LINE_MIN + 2 * theme.line.border,
    color: pill ? theme.color.text : LINE_COLORS[tone],
    pointerEvents: "auto",
    ...(floating ? { position: "absolute", left: floating.left, bottom: `calc(100% + ${theme.layout.options.lineGap + (floating.lift ?? 0)}px)` } : null),
  };
  const text: CSSProperties = open
    ? { display: "block", maxHeight: `calc(4 * ${theme.leading.body}em)`, overflowY: "auto", whiteSpace: "normal", overscrollBehavior: "contain" }
    : { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  const content = pill ? `${props.tool} options hidden. Tap to show.` : line?.content;
  const inner = (
    <span ref={words} style={text}>
      {content}
    </span>
  );
  if (props.tucked && !props.task) return null;
  return (
    <div
      ref={box}
      aria-live="polite"
      // How Room's measure reads it (pages/Room.tsx useOptionsBox): only a line shown on one line sets its reserve.
      data-options-line={props.hidden ? "hidden" : open ? "open" : "shown"}
      data-options-reading={reading ? "" : undefined}
      data-finding={line?.finding ? "" : undefined}
      style={props.hidden ? VISUALLY_HIDDEN : look}
    >
      {pill ? (
        <button type="button" onClick={() => frame?.show()} style={LINE_BUTTON}>
          {inner}
          <span aria-hidden data-touch-reach="" style={LINE_REACH} />
        </button>
      ) : cut || open ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={LINE_BUTTON}>
          {inner}
          <span aria-hidden data-touch-reach="" style={LINE_REACH} />
        </button>
      ) : (
        inner
      )}
    </div>
  );
}

const LINE_COLORS: Record<LineTone, string> = {
  hint: theme.color.textMuted,
  reading: theme.color.text,
  warning: theme.color.warning,
  status: theme.color.success,
};

/** The pill's padding, and its least height inside its border: a 14 px reading's line and that padding. */
const LINE_PAD = { x: theme.space(2.5), y: theme.space(1.5) };
const LINE_MIN = theme.font.body14 * theme.leading.body + 2 * LINE_PAD.y;

/**
 * The line as a button, with no look of its own. It reaches over the
 * pill's padding to its border, so a tap anywhere on the pill takes,
 * not only one on its words. The negative margins keep the pill's width
 * and height what its words alone give it.
 */
const LINE_BUTTON: CSSProperties = {
  position: "relative",
  display: "block",
  boxSizing: "border-box",
  width: `calc(100% + ${2 * LINE_PAD.x}px)`,
  minHeight: LINE_MIN,
  padding: `${LINE_PAD.y}px ${LINE_PAD.x}px`,
  margin: `${-LINE_PAD.y}px ${-LINE_PAD.x}px`,
  border: "none",
  background: "transparent",
  color: "inherit",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

/**
 * The line button's touch target: 44 px tall however short its one line
 * is, reaching past the pill's top and foot rather than growing it, since
 * the pill's height is the map's reserve (pages/Room.tsx useOptionsBox).
 * The 6 px gap above the row holds what it reaches down, so it never takes
 * a tap meant for the row.
 */
const LINE_REACH: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  top: "50%",
  height: `max(100%, ${theme.touch}px)`,
  transform: "translateY(-50%)",
};

// ------------------------------------------------------------ value chips (6.2, 7.2)

/** One value a chip can show: its words, and where every option has one, its glyph or swatch. */
export type ChipOption = { key: string; words: ReactNode; glyph?: ReactNode; swatch?: string };

export type ValueChipProps = {
  /** What it sets: the start of its name and its popover's title ("Shape"). */
  label: string;
  /** The values it may show, for its stable width, and the one it shows. */
  options: readonly ChipOption[];
  value: string;
  /** The value as its name says it, where it says more than its words ("Stroke: Mid, Solid"). */
  valueName?: string;
  /** A disk of this color in place of words: a color, a pin color or a tint. */
  disk?: string;
  /** Before the words, and alone in the compact form: the stroke's preview bar. */
  preview?: ReactNode;
  /** Short words for the compact form ("Kept (2)"). */
  short?: ReactNode;
  /** A slot's value it shows while that slot waits in its popover ("20 ft"), and every value it may take. */
  hosted?: { words: string; all: readonly string[] };
  /** Plain words in place of "label: value": a chip with no value, such as Nudge or Kept rulers. Its name is then its visible words. */
  plain?: boolean;
  /** The tooltip. */
  title?: string;
  /** A choice closes on a pick. A setting popover stays open while settings change (7.2). */
  kind: "choice" | "setting";
  /** The popover's title where it says more than the label ("Nudge the box"). */
  heading?: string;
  disabled?: boolean;
  /** The popover's content: tiles, swatches, a choice, or settings. */
  children: ReactNode;
};

/**
 * A value chip (6.2): a button that shows its value and opens a small
 * popover above the row. Named "<what>: <value>", with
 * `aria-haspopup="dialog"`, `aria-expanded` and `aria-controls`. It draws
 * at its widest value, every value stacked in one cell with only the
 * current one shown, so a pick in its popover never moves the controls
 * beside it. In ⋯ it shows its popover's content inline under its title:
 * there is never a popover inside a popover.
 */
export function ValueChip(props: ValueChipProps) {
  const place = useSlotPlace();
  if (place?.at === "measure") return <span style={chipLook(false, props.disabled === true)}>{chipFace(props, place.form)}</span>;
  if (inPopover(place)) return <ChipInline {...props} id={place!.id} />;
  return <LiveChip {...props} place={place} />;
}

function LiveChip(props: ValueChipProps & { place: SlotPlace | null }) {
  const strip = useContext(StripContext);
  const frame = strip?.popover ?? WINDOW_POPOVER;
  const fallback = strip?.fallback;
  const handle = usePopover({ kind: "dialog", fallbackFocus: () => fallback?.() ?? null });
  const id = props.place?.id ?? null;
  useOpenInSlot(handle.open);
  const form = props.place?.form ?? "full";
  const closers = useMemo<Closers>(() => ({ pick: props.kind === "choice" ? () => handle.close("pick") : null, task: () => handle.close("pick") }), [handle, props.kind]);
  return (
    <>
      <button
        type="button"
        {...handle.anchorProps}
        disabled={props.disabled}
        aria-label={chipName(props, form)}
        title={props.title ?? (props.plain ? textOf(props.options.find((o) => o.key === props.value)?.words) : undefined)}
        style={chipLook(handle.open, props.disabled === true)}
      >
        {chipFace(props, form)}
      </button>
      <Popover handle={handle} side="above" bound={frame.bound} rise={frame.rise} gap={frame.gap} minHeight={POPOVER_MIN} title={props.heading ?? props.label}>
        <CloseContext.Provider value={closers}>
          <div style={{ display: "grid", gap: theme.space(2) }}>
            <SlotPlaceContext.Provider value={null}>{props.children}</SlotPlaceContext.Provider>
            {id && strip ? strip.homed(id) : null}
          </div>
        </CloseContext.Provider>
      </Popover>
    </>
  );
}

/** A chip in ⋯: its popover's content under its title, and the slots that wait in it. */
function ChipInline(props: ValueChipProps & { id: string }) {
  const strip = useContext(StripContext);
  const headingId = useId();
  return (
    <div role="group" aria-labelledby={headingId} style={{ display: "grid", gap: theme.space(1) }}>
      <div id={headingId} style={{ ...sectionLabelLook(), paddingTop: theme.space(1) }}>
        {props.heading ?? props.label}
      </div>
      <SlotPlaceContext.Provider value={null}>{props.children}</SlotPlaceContext.Provider>
      {strip ? strip.homed(props.id) : null}
    </div>
  );
}

/** A chip's name: "<what>: <value>", with a hosted value it shows, or its visible words for a plain chip. */
function chipName(props: ValueChipProps, form: SlotForm): string | undefined {
  if (props.plain) return undefined;
  const current = props.options.find((o) => o.key === props.value);
  const value = props.valueName ?? textOf(current?.words) ?? props.value;
  const hosted = (form === "hosts" || form === "hostsGlyph") && props.hosted ? ` ${props.hosted.words}` : "";
  return `${props.label}: ${value}${hosted}`;
}

function textOf(node: ReactNode): string | undefined {
  return typeof node === "string" || typeof node === "number" ? String(node) : undefined;
}

/** What a chip shows in a form (6.2): glyph and words, words, the glyph or swatch alone, or short words, then its caret. */
function chipFace(props: ValueChipProps, form: SlotForm): ReactNode {
  const current = props.options.find((o) => o.key === props.value) ?? props.options[0];
  const compact = form === "compact";
  const glyph = current?.glyph && (compact || form === "glyph" || form === "hostsGlyph") ? current.glyph : null;
  const swatch = current?.swatch;
  const alone = compact && (glyph !== null || swatch !== undefined || props.preview !== undefined);
  const hosts = (form === "hosts" || form === "hostsGlyph") && props.hosted ? props.hosted : null;
  let words: ReactNode = null;
  if (props.disk === undefined && !alone) {
    if (compact && props.short !== undefined) words = props.short;
    // With a hosted value the words and the value read as one ("Sphere 20 ft"), at the width of the widest pair.
    else if (hosts) words = <StableWords current={`${textOf(current?.words) ?? ""} ${hosts.words}`} all={props.options.flatMap((o) => hosts.all.map((h) => `${textOf(o.words) ?? ""} ${h}`))} />;
    else words = <StableWords current={current?.words} all={props.options.map((o) => o.words)} />;
  }
  return (
    <>
      {glyph ? <span style={{ display: "grid", placeItems: "center" }}>{glyph}</span> : null}
      {swatch !== undefined ? <ChipSwatch color={swatch} /> : null}
      {props.disk !== undefined ? <ChipSwatch color={props.disk} size={theme.layout.options.disk} round /> : null}
      {props.preview}
      {words}
      <Icon name="caret" size="sm" />
    </>
  );
}

function ChipSwatch(props: { color: string; size?: number; round?: boolean }) {
  const size = props.size ?? theme.icon.md;
  return (
    <span
      aria-hidden
      style={{
        flex: "none",
        width: size,
        height: size,
        boxSizing: "border-box",
        borderRadius: props.round ? theme.radius.round : theme.radius.xs,
        background: props.color,
        border: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    />
  );
}

function chipLook(open: boolean, disabled: boolean): CSSProperties {
  return {
    flex: "none",
    display: "inline-flex",
    alignItems: "center",
    gap: theme.space(1),
    boxSizing: "border-box",
    minHeight: theme.touch,
    minWidth: theme.touch,
    padding: `0 ${theme.space(1.5)}px 0 ${theme.space(3)}px`,
    borderRadius: theme.radius.md,
    fontFamily: theme.font.body,
    fontSize: theme.font.body14,
    fontWeight: theme.weight.strong,
    whiteSpace: "nowrap",
    cursor: disabled ? "default" : "pointer",
    ...buttonLook("secondary", { pressed: open, disabled }),
  };
}

/**
 * Words drawn at the width of the widest of `all`, every one stacked in
 * one grid cell and only `current` shown, so a change never moves what
 * stands beside them (6.2). The others are hidden from sight and from
 * screen readers.
 */
export function StableWords(props: { current: ReactNode; all: readonly ReactNode[]; align?: "start" | "center" }) {
  return (
    <span style={{ display: "inline-grid", justifyItems: props.align ?? "start", alignItems: "center" }}>
      {props.all.map((words, i) => (
        <span key={i} aria-hidden style={{ gridArea: "1 / 1", visibility: "hidden", whiteSpace: "nowrap" }}>
          {words}
        </span>
      ))}
      <span style={{ gridArea: "1 / 1", whiteSpace: "nowrap" }}>{props.current}</span>
    </span>
  );
}

// ------------------------------------------------------------ choices in a popover (7.2)

/**
 * A choice popover closes on a pick (7.5): a pointer's click on an option
 * (`detail` above 0), or Enter or Space on one. A native radio clicks on
 * an arrow key too, with `detail` 0, so the arrows change the choice and
 * leave the popover open. In ⋯ nothing closes.
 */
export function PickCloses(props: { children: ReactNode }) {
  const { pick } = usePopoverClose();
  const onClick = (e: ReactMouseEvent) => {
    if (pick && e.detail > 0 && isRadio(e.target)) pick();
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (!pick || (e.key !== "Enter" && e.key !== " ") || !isRadio(e.target)) return;
    e.preventDefault();
    if (!e.target.checked) e.target.click();
    pick();
  };
  return (
    <div onClick={onClick} onKeyDown={onKeyDown} style={{ display: "contents" }}>
      {props.children}
    </div>
  );
}

function isRadio(target: EventTarget): target is HTMLInputElement {
  return target instanceof HTMLInputElement && target.type === "radio";
}

/** An option the whole of its tile or row, as in Segmented: a tap anywhere on it hits the radio. */
const RADIO_COVER: CSSProperties = { position: "absolute", inset: 0, width: "100%", height: "100%", margin: 0, opacity: 0, cursor: "inherit" };

/** `spoken` names the tile for a screen reader where its words would read badly, as "Walls/doors" reads "Walls slash doors", and stands for its words beside a title as they would. */
export type TileOption<T extends string> = { value: T; label: string; spoken?: string; glyph?: ReactNode; title?: string };

/**
 * Tiles (7.2): a choice as 60 px tiles, words with a glyph or swatch above
 * where one exists, each a native radio over its whole tile, as Segmented
 * builds its options: one Tab stop, and the arrows move the choice. Wrap
 * it in PickCloses so a pick closes its popover.
 */
export function ChoiceTiles<T extends string>(props: {
  label: string;
  value: T;
  options: readonly TileOption<T>[];
  onChange(value: NoInfer<T>): void;
  /**
   * Every tile one width and one height, in a grid of as many columns as
   * fit, for names of uneven length such as the builder's modes, where
   * tiles that each took their own width stood ragged and a long name ran
   * out of its tile (D-261026-3). A name may break after a slash there
   * ("Heights/" over "stairs").
   */
  even?: boolean;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={props.label} style={props.even ? EVEN_TILES : { display: "flex", flexWrap: "wrap", gap: theme.space(1), maxWidth: TILES_MAX }}>
      {props.options.map((o) => {
        const chosen = o.value === props.value;
        return (
          <label key={o.value} className="rvtt-choice" title={o.title} style={{ ...TILE, ...(props.even ? EVEN_TILE : null), ...choiceLook(chosen) }}>
            <input type="radio" name={name} value={o.value} checked={chosen} aria-label={accessibleName(o.spoken ?? o.label, o.title) ?? o.spoken} onChange={() => props.onChange(o.value)} style={RADIO_COVER} />
            {o.glyph ? (
              <span aria-hidden style={{ display: "grid", placeItems: "center" }}>
                {o.glyph}
              </span>
            ) : null}
            <span>{props.even ? breaksAfterSlashes(o.label) : o.label}</span>
          </label>
        );
      })}
    </div>
  );
}

/** A name with a place to break after each slash, which a line otherwise never takes between two words joined by one. */
function breaksAfterSlashes(label: string): ReactNode {
  const parts = label.split("/");
  return parts.flatMap((part, i) => (i < parts.length - 1 ? [part, "/", <wbr key={i} />] : [part]));
}

/** Four tiles to a row, so a choice of eight or ten reads as a grid on any screen. */
const TILES_MAX = 4 * (theme.layout.popover.tile + 36) + 3 * theme.space(1);

/** An even grid: as many columns as fit, each at least 24 px wider than a tile and all sharing the width left over, and every row as tall as the tallest. */
const EVEN_TILES: CSSProperties = {
  display: "grid",
  gridTemplateColumns: `repeat(auto-fill, minmax(${theme.layout.popover.tile + 24}px, 1fr))`,
  gridAutoRows: "1fr",
  gap: theme.space(1),
  // The window's width, not four columns at the least, decides how many fit, so a narrow window takes fewer.
  width: "100%",
  minWidth: 0,
  maxWidth: TILES_MAX,
};
const EVEN_TILE: CSSProperties = { minWidth: 0, maxWidth: "none" };

const TILE: CSSProperties = {
  position: "relative",
  display: "grid",
  justifyItems: "center",
  alignContent: "center",
  gap: theme.space(1),
  boxSizing: "border-box",
  minWidth: theme.layout.popover.tile,
  maxWidth: theme.layout.popover.tile + 36,
  minHeight: theme.layout.popover.tile,
  padding: `${theme.space(1)}px ${theme.space(2)}px`,
  borderRadius: theme.radius.md,
  fontSize: theme.font.small,
  fontWeight: theme.weight.strong,
  lineHeight: theme.leading.tight,
  textAlign: "center",
  cursor: "pointer",
};

/** `picture` stands before the words as a swatch does, and `detail` follows them in muted words ("Pip companion"). */
export type RowOption<T extends string> = { value: T; label: string; title?: string; swatch?: string; picture?: ReactNode; detail?: string };

/**
 * Rows (7.2): a choice as 44 px rows with a check mark on the chosen one,
 * for values with longer names (a blank token kind, an edge, a light, a
 * creature an area is cast from). Native radios, as ChoiceTiles. Wrap it
 * in PickCloses. `wrap` lets a long name break onto a second line, for
 * rows in a narrow pane, where one line ran past its edge (the trap
 * pane's Hits at 320 px and 130%), each row still 44 px at least.
 */
export function ChoiceRows<T extends string>(props: { label: string; value: T; options: readonly RowOption<T>[]; onChange(value: NoInfer<T>): void; wrap?: boolean }) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={props.label} style={{ display: "grid", gap: theme.space(0.5) }}>
      {props.options.map((o) => {
        const chosen = o.value === props.value;
        return (
          <label key={o.value} className="rvtt-choice" title={o.title} style={{ ...CHOICE_ROW, ...(props.wrap ? CHOICE_ROW_WRAP : null), ...buttonLook("quiet", { pressed: chosen }) }}>
            <input type="radio" name={name} value={o.value} checked={chosen} aria-label={accessibleName(o.label, o.title)} onChange={() => props.onChange(o.value)} style={RADIO_COVER} />
            {o.swatch !== undefined ? <ChipSwatch color={o.swatch} /> : null}
            {o.picture !== undefined ? (
              <span aria-hidden style={{ flex: "none", display: "grid", placeItems: "center" }}>
                {o.picture}
              </span>
            ) : null}
            <span style={{ flex: 1, minWidth: props.wrap ? 0 : undefined }}>
              {o.label}
              {o.detail !== undefined ? <span style={{ fontWeight: theme.weight.regular, color: theme.color.textMuted }}> {o.detail}</span> : null}
            </span>
            {chosen ? <Icon name="check" size="sm" style={props.wrap ? { flex: "none" } : undefined} /> : null}
          </label>
        );
      })}
    </div>
  );
}

const CHOICE_ROW: CSSProperties = {
  position: "relative",
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  minHeight: theme.touch,
  padding: `0 ${theme.space(3)}px`,
  borderRadius: theme.radius.md,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  whiteSpace: "nowrap",
  cursor: "pointer",
};

const CHOICE_ROW_WRAP: CSSProperties = { whiteSpace: "normal", paddingTop: theme.space(1), paddingBottom: theme.space(1) };

/**
 * The parts of a control made of kit controls, such as a stepper's − and
 * +: plain buttons wherever the control stands, but for a measuring copy.
 */
export function Parts(props: { place: SlotPlace | null; children: ReactNode }) {
  return <SlotPlaceContext.Provider value={props.place?.at === "measure" ? props.place : null}>{props.children}</SlotPlaceContext.Provider>;
}

/** A choice in ⋯ or a popover: its name above it, then the choice wrapping to the popover's width (6.5). */
export function Labelled(props: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: theme.space(1), minWidth: 0 }}>
      <div aria-hidden style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
        {props.label}
      </div>
      {props.children}
    </div>
  );
}

/**
 * A segmented choice in a slot (components/Segmented.tsx). Its compact
 * form is a chip showing the chosen option's words, or its `short` words
 * where it has them, whose popover holds the choice ("Clear fog" with a
 * caret, 6.2). The chip's name keeps the option's own words and holds the
 * words it shows, so a voice user who says them finds it (WCAG 2.5.3):
 * "Measure: Walking" for "Walk", "Measure: Line (Straight)" for "Line". In
 * ⋯ it is a labelled group.
 */
export function OptSegmented<T extends string | number>(props: { label: string; value: T | null; options: readonly (SegmentedOption<T> & { short?: string })[]; onChange(value: NoInfer<T>): void; disabled?: boolean }) {
  const place = useSlotPlace();
  const choice = <Segmented label={props.label} value={props.value} options={props.options} onChange={props.onChange} disabled={props.disabled} />;
  if (inPopover(place)) return <Labelled label={props.label}>{choice}</Labelled>;
  if (place?.form !== "compact") return choice;
  return (
    <ValueChip
      label={props.label}
      kind="choice"
      disabled={props.disabled}
      value={String(props.value)}
      options={props.options.map((o) => ({ key: String(o.value), words: o.short ?? o.label }))}
      valueName={shortName(props.options.find((o) => o.value === props.value))}
    >
      <PickCloses>{choice}</PickCloses>
    </ValueChip>
  );
}

/** A compact chip's value as its name says it: the option's own words, with the short words it shows first where they are not part of them. */
export function shortName(option: (SegmentedOption<string | number> & { short?: string }) | undefined): string | undefined {
  const name = nameOf(option);
  const short = option?.short;
  if (short === undefined || name === undefined || name.toLowerCase().includes(short.toLowerCase())) return name;
  return `${short} (${name})`;
}

function nameOf(option: SegmentedOption<string | number> | undefined): string | undefined {
  if (!option) return undefined;
  return typeof option.label === "string" && /\p{L}|\d/u.test(option.label) ? option.label : (option.title ?? textOf(option.label));
}

/** Swatches in a slot (components/Swatches.tsx): a labelled group in ⋯, as Area's color is. */
export function OptSwatches(props: { label: string; value: string | null; options: readonly (string | SwatchOption)[]; onChange(color: string): void }) {
  const place = useSlotPlace();
  const swatches = <Swatches label={props.label} value={props.value} options={props.options} onChange={props.onChange} style={inPopover(place) ? { maxWidth: SWATCHES_MAX } : undefined} />;
  return inPopover(place) ? <Labelled label={props.label}>{swatches}</Labelled> : swatches;
}

/** Five swatches to a row in a popover (7.2). */
export const SWATCHES_MAX = 5 * theme.touch + 4 * theme.space(0.5);

/** Swatches in a choice popover: five to a row. */
export function PopoverSwatches(props: { label: string; value: string | null; options: readonly (string | SwatchOption)[]; onChange(color: string): void }) {
  return (
    <PickCloses>
      <Swatches label={props.label} value={props.value} options={props.options} onChange={props.onChange} style={{ maxWidth: SWATCHES_MAX }} />
    </PickCloses>
  );
}

/**
 * Plain text in a slot, such as Multi-select's "3 selected." and its
 * sentence (9.1) or the grid's "70 px per square" (9.10). Flexible where
 * its slot says so: it fits at its least and is cut with an ellipsis.
 * In ⋯ it is a muted row.
 */
export function StripText(props: { children: ReactNode; title?: string; tabular?: boolean; all?: readonly ReactNode[] }) {
  const place = useSlotPlace();
  const content = props.all ? <StableWords current={props.children} all={props.all} /> : props.children;
  if (inPopover(place)) return <div style={{ fontSize: theme.font.body14, color: theme.color.textMuted, padding: `${theme.space(1)}px 0` }}>{content}</div>;
  return (
    <span
      title={props.title}
      style={{
        display: "block",
        minWidth: 0,
        width: place?.at === "row" && place.width !== undefined ? place.width : undefined,
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        fontSize: theme.font.small,
        lineHeight: theme.leading.body,
        color: theme.color.textMuted,
        fontVariantNumeric: props.tabular ? "tabular-nums" : undefined,
      }}
    >
      {content}
    </span>
  );
}

// ------------------------------------------------------------ the older bars, until every tool has slots

/** The options bar's content: the hint line, then the rows of controls, filling the bar's width. */
export function OptionsColumn(props: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: theme.space(1), width: "100%", minWidth: 0 }}>{props.children}</div>;
}

/**
 * A wrapping row of controls. A control made of parts (a Segmented, a
 * stepper, a row of swatches) keeps its parts `space(1)` or closer, and
 * the row puts `space(2)` between controls, so the groups read apart.
 * Wrapped lines stay `space(1)` apart, since every pixel of the bar's
 * height is map that a phone does not show.
 */
export function OptionsRow(props: { children: ReactNode; label?: string }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: theme.space(1), columnGap: theme.space(2), minWidth: 0 }}
    >
      {props.children}
    </div>
  );
}

/**
 * The line above the controls. `muted` is a hint, what a tap or a drag
 * does now: 13 px muted, as every hint in the app, or in the warning tone
 * for what went wrong. Without a tone the line is a reading the tool gives
 * (the ruler's distance, what an area catches), at body size in text
 * color, since that is what the person came for. It wraps, and only a
 * very long "In area" list scrolls, past four lines.
 */
export function InfoLine(props: { children: ReactNode; tone?: "muted" | "warning" }) {
  const hint = props.tone !== undefined;
  return (
    <div
      aria-live="polite"
      // A reading or a warning is what the person came for, so the alerts' summary row never stands over it, as over a control (pages/Room.tsx useOptionsHeights). A muted hint it may cover.
      data-options-reading={props.tone === "muted" ? undefined : ""}
      style={{
        fontSize: hint ? theme.font.small : theme.font.body14,
        lineHeight: theme.leading.body,
        color: props.tone === "warning" ? theme.color.warning : hint ? theme.color.textMuted : theme.color.text,
        maxHeight: "5.4em",
        overflowY: "auto",
      }}
    >
      {props.children}
    </div>
  );
}

/** A thin line between the tool's own controls and those of the thing it has selected, such as a stamp. */
export function OptionsDivider() {
  return <span aria-hidden style={{ flex: "none", width: theme.line.border, alignSelf: "stretch", margin: `${theme.space(1)}px 0`, background: theme.color.border }} />;
}

// ------------------------------------------------------------ buttons, steppers and fields

/**
 * A small button in a bar (components/Button.tsx, size `sm`). `label` is
 * the tooltip, and the name too when the visible words say less than it
 * (lib/a11y.ts accessibleName), so "Undo" is still called "Undo" and an
 * arrow is called by what it does. `pressed` is an option that applies at
 * once, named by what pressed means ("DM only", "Shared"). A danger
 * button that is pressed is armed: it waits for its second tap.
 *
 * `repeat` makes it repeat while held, as a stepper's − and + do
 * (lib/holdRepeat.ts): `onClick` then runs on the press, again 400 ms into
 * the hold and every 80 ms after, until it returns false at a limit.
 * `onHold` hears when a pointer press starts and ends. `repeatValue` is
 * the value it steps, which a press the browser cancels before its first
 * repeat, a scroll that began on the button, puts back.
 *
 * A repeat button that is `disabled`, at its limit, is `aria-disabled`
 * instead, with the disabled look, and does nothing when pressed or
 * clicked. A truly disabled button loses the keyboard's focus to the page,
 * and moving the focus to the other button instead sent the rest of a held
 * Enter's key repeat back the other way. So the focus stays, and a held
 * Enter stops at the limit.
 *
 * In a slot (6.2, 6.5): `short` is its compact form's words ("Reveal
 * (4)"), whose name is then those words, with the full words as the
 * tooltip. `compactIcon` makes its compact form its icon alone, named by
 * its words with their tooltip, for a row that cannot hold the words
 * (docs/design-v1-look-pass.md 3.4). In a popover it is a row as wide as
 * the popover, a pressed toggle with a check mark, and `ends` closes the
 * popover after it acts, for a button that ends the tool's task.
 */
export function OptButton(props: {
  ref?: Ref<HTMLButtonElement>;
  /** With `repeat`, a return of false says a limit is reached, which ends the repeat. */
  onClick(): unknown;
  children?: ReactNode;
  label?: string;
  pressed?: boolean;
  disabled?: boolean;
  tone?: "primary" | "danger";
  icon?: IconName;
  repeat?: boolean;
  onHold?(holding: boolean): void;
  repeatValue?: RepeatValue;
  /** Its compact form's words. */
  short?: ReactNode;
  /** Its compact form is its icon alone, as `iconOnly="always"` draws it. */
  compactIcon?: boolean;
  /** It ends the tool's task: in a popover, the popover closes after it acts (7.2). */
  ends?: boolean;
  /** Its words in ⋯, where an icon alone would not read as a row ("Undo"). */
  rowWords?: string;
  /**
   * Its icon alone in the row, its words its name and tooltip (Button's
   * `iconOnly`, docs/design-v1-icons.md 3.1). In ⋯ it is a row with its
   * words, as every row there is.
   */
  iconOnly?: "always" | "fine";
  /**
   * A row as wide as its popover with its icon and words at the left, as
   * ⋯'s rows are, where it stands in a chip's own content rather than in a
   * slot: a kept ruler's remove in the Kept rulers popover.
   */
  row?: boolean;
}) {
  const place = useSlotPlace();
  if (place?.at === "measure") return <OptButtonFace {...props} form={place.form} />;
  return <LiveOptButton {...props} place={place} />;
}

/** A measuring copy: the same look and words, nothing live. */
function OptButtonFace(props: Parameters<typeof OptButton>[0] & { form: SlotForm }) {
  const variant = props.tone ?? "secondary";
  const short = props.form === "compact" && props.short !== undefined;
  const iconAlone = props.form === "compact" && props.compactIcon === true;
  return (
    <Button size="sm" variant={variant} pressed={props.pressed} icon={props.icon} iconOnly={short ? undefined : iconAlone ? "always" : props.iconOnly} disabled={props.disabled} tabIndex={-1} style={{ flex: "none", whiteSpace: "nowrap" }}>
      {short ? props.short : props.children}
    </Button>
  );
}

function LiveOptButton(props: Parameters<typeof OptButton>[0] & { place: SlotPlace | null }) {
  const { pressed, tone, place } = props;
  const atLimit = props.repeat === true && props.disabled === true;
  const hold = useHoldRepeat(props.onClick, props.onHold, props.repeatValue, atLimit);
  const { task } = usePopoverClose();
  const variant = tone ?? "secondary";
  const short = place?.at === "row" && place.form === "compact" && props.short !== undefined;
  const iconAlone = place?.at === "row" && place.form === "compact" && props.compactIcon === true;
  const row = inPopover(place) || props.row === true;
  const children = short ? props.short : row && props.children === undefined && props.rowWords ? props.rowWords : props.children;
  const full = props.label ?? textOf(props.children);
  const act = () => {
    const result = props.onClick();
    if (props.ends) task?.();
    return result;
  };
  return (
    <Button
      ref={props.ref}
      size="sm"
      variant={variant}
      pressed={pressed}
      armed={tone === "danger" && pressed === true}
      icon={props.icon}
      iconOnly={short || row ? undefined : iconAlone ? "always" : props.iconOnly}
      disabled={props.disabled && !atLimit}
      aria-disabled={atLimit || undefined}
      aria-label={short ? (hasWords(props.short) ? undefined : props.label) : children === undefined ? props.label : accessibleName(children, props.label)}
      title={short ? full : props.label}
      onClick={(e) => (props.repeat ? hold.click(e.detail === 0) : act())}
      onPointerDown={props.repeat ? hold.pointerDown : undefined}
      onContextMenu={props.repeat ? (e) => e.preventDefault() : undefined}
      style={{
        flex: "none",
        whiteSpace: "nowrap",
        ...(row ? { width: "100%", justifyContent: "flex-start" } : null),
        ...(props.repeat ? NO_CALLOUT : null),
        ...(atLimit ? { ...buttonLook(variant, { pressed, disabled: true }), cursor: "default" } : null),
      }}
    >
      {children}
      {row && pressed && tone !== "danger" ? <Icon name="check" size="sm" style={{ marginLeft: "auto" }} /> : null}
    </Button>
  );
}

/** Whether a form's content has words of its own to name it, rather than a thumbnail or an icon. */
function hasWords(node: ReactNode): boolean {
  return typeof node === "string" && /\p{L}/u.test(node);
}

/** A held button opens no callout or text selection on a phone, which would end the hold. */
const NO_CALLOUT: CSSProperties = { WebkitTouchCallout: "none", WebkitUserSelect: "none", userSelect: "none" };

/**
 * The hold repeat's wiring to the DOM. The lift is heard on `window`, in
 * case a browser never gives a button at its limit its own `pointerup`,
 * and also as the button's `lostpointercapture`, the last word a touch's
 * implicit capture gives. A finger sliding off the button ends
 * the hold, which that capture would otherwise hide. A `pointercancel` is
 * the browser taking the gesture for a scroll, which `cancel` answers.
 */
function useHoldRepeat(onClick: () => unknown, onHold: ((holding: boolean) => void) | undefined, value: RepeatValue | undefined, atLimit: boolean) {
  const clickRef = useRef(onClick);
  clickRef.current = onClick;
  const limitRef = useRef(atLimit);
  limitRef.current = atLimit;
  const holdRef = useRef(onHold);
  holdRef.current = onHold;
  const valueRef = useRef(value);
  valueRef.current = value;
  const [repeat] = useState(
    () =>
      new HoldRepeat({
        step: () => clickRef.current() !== false,
        atLimit: () => limitRef.current,
        onHold: (h) => holdRef.current?.(h),
        value: { read: () => valueRef.current?.read() ?? 0, write: (v) => valueRef.current?.write(v) },
      }),
  );
  const endRef = useRef<(() => void) | null>(null);
  useEffect(() => () => endRef.current?.(), []);
  return {
    click: (fromKeyboard: boolean) => repeat.click(fromKeyboard),
    pointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
      if (!e.isPrimary || e.button !== 0 || limitRef.current) return;
      endRef.current?.();
      const button = e.currentTarget;
      const id = e.pointerId;
      const end = (cancelled = false) => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        button.removeEventListener("lostpointercapture", onUp);
        endRef.current = null;
        if (cancelled) repeat.cancel();
        else repeat.release();
      };
      const onMove = (m: PointerEvent) => {
        if (m.pointerId !== id) return;
        const r = button.getBoundingClientRect();
        if (m.clientX >= r.left && m.clientX <= r.right && m.clientY >= r.top && m.clientY <= r.bottom) return;
        window.removeEventListener("pointermove", onMove);
        repeat.stop();
      };
      const onUp = (u: PointerEvent) => {
        if (u.pointerId === id) end(u.type === "pointercancel");
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
      button.addEventListener("lostpointercapture", onUp);
      endRef.current = () => end();
      repeat.press();
    },
  };
}

/** How long a destructive button stays armed for its second tap. */
const ARMED_MS = 4000;

/**
 * A danger button that asks for a second tap before it acts, for what
 * wipes something out (fog everything, clear the build, delete a light).
 * No dialog, so it works the same with a thumb and a mouse. Its words
 * change to the question once armed, and so does its name, so a screen
 * reader hears what the next tap does.
 *
 * In a slot it draws at the width of its armed words, so the first tap
 * never moves what stands beside it (6.2), `short` is its compact form's
 * armed words ("Delete?"), and its second press closes the popover it
 * stands in (7.2).
 */
export function ConfirmButton(props: { label: string; confirm: string; title?: string; onConfirm(): void; disabled?: boolean; short?: string; armedMs?: number; icon?: IconName; iconOnly?: boolean }) {
  const place = useSlotPlace();
  if (place?.at === "measure") return <ConfirmFace {...props} armed={false} form={place.form} />;
  return <LiveConfirm {...props} place={place} />;
}

function confirmWords(props: { label: string; confirm: string; short?: string }, form: SlotForm, armed: boolean): string {
  if (!armed) return props.label;
  return form === "compact" && props.short !== undefined ? props.short : props.confirm;
}

function ConfirmFace(props: { label: string; confirm: string; short?: string; disabled?: boolean; armed: boolean; form: SlotForm; icon?: IconName }) {
  const all = [props.label, confirmWords(props, props.form, true)];
  return (
    <Button size="sm" variant="danger" armed={props.armed} icon={props.icon} disabled={props.disabled} tabIndex={-1} style={{ flex: "none", whiteSpace: "nowrap" }}>
      <StableWords current={confirmWords(props, props.form, props.armed)} all={all} align="center" />
    </Button>
  );
}

function LiveConfirm(props: { label: string; confirm: string; title?: string; onConfirm(): void; disabled?: boolean; short?: string; armedMs?: number; icon?: IconName; iconOnly?: boolean; place: SlotPlace | null }) {
  const [armed, setArmed] = useState(false);
  const { task } = usePopoverClose();
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), props.armedMs ?? ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed, props.armedMs]);
  const form = props.place?.form ?? "full";
  const words = confirmWords(props, form, armed);
  const row = inPopover(props.place);
  const slotted = props.place !== null && !row;
  return (
    <Button
      size="sm"
      variant="danger"
      armed={armed}
      icon={props.icon}
      // The icon alone until armed, then its words (docs/design-v1-icons.md 3.1 rule 6). A slot keeps its words: it holds its widest anyway, so a row never moves.
      iconOnly={props.iconOnly && !armed && !slotted && !row ? "always" : undefined}
      disabled={props.disabled}
      aria-label={accessibleName(words, props.title)}
      title={props.title}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        props.onConfirm();
        task?.();
      }}
      style={{ flex: "none", whiteSpace: "nowrap", ...(row ? { width: "100%", justifyContent: "flex-start" } : null) }}
    >
      {slotted ? <StableWords current={words} all={[props.label, confirmWords(props, form, true)]} align="center" /> : words}
    </Button>
  );
}

/**
 * A number in steps, with buttons rather than a text field, so a phone
 * needs no keyboard. In a slot the value draws at its widest (`widest`,
 * and the values at both ends), so a step never moves what stands beside
 * it (6.2), and in a popover it is a labelled group. `repeat` steps while
 * a button is held, and `live` speaks the value, once a hold ends.
 */
export function Stepper(props: {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  unit?: string;
  onChange(v: number): void;
  /** How the value reads, where it is not the number and its unit ("Ground (clears)"). */
  format?(v: number): string;
  /** Words at least as wide as any value, beside those at both ends. */
  widest?: readonly string[];
  /** The buttons' names, where "Less size" and "More size" would not say what they do ("5 ft lower"). */
  less?: string;
  more?: string;
  /** The buttons' icons, where − and + would not say which way they go (an aim's down and up). */
  icons?: readonly [IconName, IconName];
  /** Steps while held (lib/holdRepeat.ts), through `onStep`, which returns false at a limit. */
  repeat?: boolean;
  onStep?(direction: -1 | 1): unknown;
  repeatValue?: RepeatValue;
  live?: boolean;
  /** The value's least width outside a slot. */
  valueWidth?: number;
}) {
  const place = useSlotPlace();
  const [holding, setHolding] = useState(false);
  const { value, step, min, max } = props;
  const format = props.format ?? ((v: number) => `${v.toLocaleString("en-US")}${props.unit ? ` ${props.unit}` : ""}`);
  const set = (v: number) => props.onChange(Math.min(max, Math.max(min, v)));
  const stepBy = (direction: -1 | 1) => (props.onStep ? props.onStep(direction) : set(value + direction * step));
  const measuring = place?.at === "measure";
  const slotted = place !== null;
  const shown = format(value);
  const all = slotted ? [format(min), format(max), ...(props.widest ?? []), shown] : undefined;
  const lower = props.less ?? `Less ${props.label.toLowerCase()}`;
  const higher = props.more ?? `More ${props.label.toLowerCase()}`;
  const group = (
    <div role={measuring ? undefined : "group"} aria-label={measuring ? undefined : props.label} style={{ display: "flex", flex: "none", alignItems: "center", gap: theme.space(1) }}>
      <Parts place={place}>
      <OptButton icon={props.icons?.[0] ?? "minus"} label={lower} disabled={value <= min} repeat={props.repeat} repeatValue={props.repeatValue} onHold={props.repeat ? setHolding : undefined} onClick={() => stepBy(-1)} />
      <StepValue live={props.live && !measuring} hushed={holding} minWidth={slotted ? 0 : props.valueWidth}>
        {all ? <StableWords current={shown} all={all} align="center" /> : shown}
      </StepValue>
      <OptButton icon={props.icons?.[1] ?? "plus"} label={higher} disabled={value >= max} repeat={props.repeat} repeatValue={props.repeatValue} onHold={props.repeat ? setHolding : undefined} onClick={() => stepBy(1)} />
      </Parts>
    </div>
  );
  return inPopover(place) ? <Labelled label={props.label}>{group}</Labelled> : group;
}

/**
 * The value between a stepper's buttons, in figures of one width, so it does
 * not jitter as it changes. `live` speaks each new value. `hushed` keeps it
 * quiet while a button is held, so a hold through eighteen steps is not
 * eighteen announcements, and the value is spoken once when it ends: the
 * text is put in again, which a screen reader hears as new.
 */
export function StepValue(props: { children: ReactNode; minWidth?: number; live?: boolean; hushed?: boolean }) {
  const [spoken, setSpoken] = useState(0);
  const wasHushed = useRef(props.hushed === true);
  useEffect(() => {
    const was = wasHushed.current;
    wasHushed.current = props.hushed === true;
    if (!was || props.hushed) return;
    // A frame later, so the region is polite again before its text changes.
    const frame = requestAnimationFrame(() => setSpoken((n) => n + 1));
    return () => cancelAnimationFrame(frame);
  }, [props.hushed]);
  return (
    <span
      aria-live={props.live ? (props.hushed ? "off" : "polite") : undefined}
      aria-atomic={props.live ? true : undefined}
      style={{
        minWidth: props.minWidth ?? 56,
        textAlign: "center",
        fontSize: theme.font.body14,
        fontWeight: theme.weight.bold,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      <span key={spoken}>{props.children}</span>
    </span>
  );
}

/**
 * A 16 px text input in the field look (iOS zooms the page on anything
 * smaller). In a flexible slot it takes the width the fit gives it (6.1),
 * and in a popover the popover's width under its name.
 */
export function OptInput(props: {
  ref?: Ref<HTMLInputElement>;
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange(v: string): void;
  onEnter?(): void;
  autoFocus?: boolean;
  width?: number;
  onFocus?(): void;
  onBlur?(): void;
  /** Ties it to a popover it opens, such as the spell results. */
  popup?: { expanded: boolean; controls: string | undefined };
  /** A press on the field or Down in it, which asks for its popover again after a dismissal. */
  onReopen?(): void;
}) {
  const place = useSlotPlace();
  const width = props.width ?? 180;
  if (place?.at === "measure") return <span style={{ display: "block", flex: "none", width, height: theme.touch }} />;
  const field = (
    <Input
      ref={props.ref}
      type="text"
      aria-label={props.label}
      value={props.value}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      autoFocus={props.autoFocus}
      onChange={(e) => props.onChange(e.target.value)}
      onFocus={props.onFocus}
      onBlur={props.onBlur}
      role={props.popup ? "combobox" : undefined}
      aria-haspopup={props.popup ? "dialog" : undefined}
      aria-expanded={props.popup?.expanded}
      aria-controls={props.popup?.controls}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onEnter?.();
        if (e.key === "ArrowDown") props.onReopen?.();
      }}
      onPointerDown={props.onReopen}
      style={{ flex: "none", boxSizing: "border-box", width: inPopover(place) ? "100%" : place?.at === "row" && place.width !== undefined ? place.width : width }}
    />
  );
  return inPopover(place) ? <Labelled label={props.label}>{field}</Labelled> : field;
}

/**
 * A native select in the field look, for a choice of more than a
 * Segmented holds (the builder's ten modes, the draw tool's eight). It is
 * the best picker on a phone, and `color-scheme` draws its menu dark.
 *
 * Its side padding is a step under a form field's: the select's own arrow
 * pads its right side already, and the builder's widest mode name with
 * Undo, Redo and the stamp button just fill a 390 px phone's first row,
 * so the selected stamp's buttons keep to one more row (StampOptions.tsx).
 */
export function OptSelect<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange(value: T): void }) {
  return (
    <Select
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as T)}
      style={{ flex: "none", maxWidth: "100%", padding: `0 ${theme.space(2)}px` }}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
