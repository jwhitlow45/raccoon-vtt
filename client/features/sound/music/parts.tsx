import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Button } from "../../../components/Button.tsx";
import { IconButton } from "../../../components/IconButton.tsx";
import { Menu, type MenuItem, type MenuPickBy } from "../../../components/Menu.tsx";
import { Popover, usePopover, type Rect } from "../../../components/Popover.tsx";
import { theme } from "../../../lib/theme.ts";
import { uiScale } from "../../device/settings.ts";
import { FADES, type Fade, type SoundId } from "#shared/sound.ts";
import { dragAt, makeRoom } from "./dragOrder.ts";
import { CROSSFADE, crossfadeName, FADE_WORDS, HANDLE_HELP, moreName, SORT_TRACKS, SORT_WORDS, sortName, type Sort } from "./words.ts";

/**
 * The Music window's small shared parts (docs/design/design-v1-music-player.md
 * 4 and 5): a list's heading with its count and button, the More and
 * choice menus, and a row's drag handle with the drag itself.
 */

/** A menu keeps inside the window, which the interface size zooms. */
export function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

/** An element's width in the interface's own px, kept as it resizes, for the layouts that turn on the room a part has. 0 until measured. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [el, setEl] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => setWidth(el.getBoundingClientRect().width / (el.currentCSSZoom ?? 1));
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    measure();
    return () => observer.disconnect();
  }, [el]);
  return [setEl, width];
}

/**
 * A list's heading: its name, a muted count or total after it, and a
 * button at its end, which wraps under them where the row is short (the
 * preview's 320 px at 130%), never over the count.
 */
export function ListHead(props: { children: ReactNode; detail?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div data-music-head="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(2), rowGap: theme.space(1), minHeight: theme.touch, minWidth: 0 }}>
      <h3 id={props.id} style={{ margin: 0, flex: "1 1 auto", minWidth: 0, fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>
        {props.children}
        {props.detail !== undefined ? <span style={{ marginLeft: theme.space(2), fontWeight: theme.weight.regular, fontSize: theme.font.body14, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>{props.detail}</span> : null}
      </h3>
      {props.action}
    </div>
  );
}

/** A row's More: its items in the shared Menu. `onPick` hears how it was picked, so a step to another menu opens the same way. */
export function MoreMenu(props: { name: string; items: readonly MenuItem[]; onPick(id: string, by: MenuPickBy): void; anchorRef?(el: HTMLElement | null): void }) {
  const menu = usePopover({ kind: "menu" });
  const { ref, ...anchorProps } = menu.anchorProps;
  return (
    <>
      <IconButton
        {...anchorProps}
        ref={(el: HTMLButtonElement | null) => {
          ref(el);
          props.anchorRef?.(el);
        }}
        icon="more"
        label={moreName(props.name)}
        data-music-more=""
      />
      <Popover handle={menu} side="below" flip bound={viewportBound}>
        <div style={{ maxWidth: theme.layout.listCap }}>
          <Menu label={moreName(props.name)} sections={[{ key: "more", items: props.items }]} onPick={props.onPick} />
        </div>
      </Popover>
    </>
  );
}

/** A button naming the choice it holds, "Crossfade: 5 s", that opens the choices as a menu. */
function ChoiceMenu<T extends string | number>(props: { label: string; menuLabel: string; value: T; choices: readonly { value: T; title: string }[]; onPick(value: T): void; mark: string }) {
  const menu = usePopover({ kind: "menu" });
  return (
    <>
      <Button {...menu.anchorProps} {...{ [`data-music-${props.mark}`]: "" }} size="sm" icon="caret">
        {props.label}
      </Button>
      <Popover handle={menu} side="below" flip bound={viewportBound}>
        <Menu
          label={props.menuLabel}
          sections={[{ key: "choices", items: props.choices.map((c) => ({ id: String(c.value), title: c.title, kind: "radio" as const, checked: c.value === props.value })) }]}
          onPick={(id) => {
            const choice = props.choices.find((c) => String(c.value) === id);
            if (choice && choice.value !== props.value) props.onPick(choice.value);
          }}
        />
      </Popover>
    </>
  );
}

export function CrossfadeMenu(props: { fade: Fade; onPick(fade: Fade): void }) {
  return <ChoiceMenu<Fade> label={crossfadeName(props.fade)} menuLabel={CROSSFADE} value={props.fade} choices={FADES.map((f) => ({ value: f, title: FADE_WORDS[f] }))} onPick={props.onPick} mark="crossfade" />;
}

export function SortMenu(props: { sort: Sort; onPick(sort: Sort): void }) {
  return <ChoiceMenu<Sort> label={sortName(props.sort)} menuLabel={SORT_TRACKS} value={props.sort} choices={(Object.keys(SORT_WORDS) as Sort[]).map((s) => ({ value: s, title: SORT_WORDS[s] }))} onPick={props.onPick} mark="sort" />;
}

/** Six dots, the grip a drag handle draws. */
function Grip() {
  return (
    <svg width="12" height="18" viewBox="0 0 12 18" aria-hidden focusable="false">
      {[3, 9, 15].map((y) => (
        <g key={y} fill="currentColor">
          <circle cx="3" cy={y} r="1.6" />
          <circle cx="9" cy={y} r="1.6" />
        </g>
      ))}
    </svg>
  );
}

/** A drag under way: the row, where it began, the rows' middles then, the slot it points at, and the key it holds on to. */
type RowDrag = { id: SoundId; from: number; pointerId: number; startY: number; dy: number; mids: number[]; height: number; zoom: number; slot: number; key: string };

export type HandleEvents = {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
  onPointerCancel(): void;
  onLostPointerCapture(e: ReactPointerEvent<HTMLElement>): void;
};

/**
 * Drag to reorder by a row's handle (4.3), as the initiative tracker's
 * (panels/TrackerPanel.tsx): only the handle starts it, so scrolling a
 * list never moves a row. The row follows the finger, the others make
 * room, and the drop sends one move. It ends with nothing sent on Escape,
 * a lost pointer, or once `key` changes by value, which the caller works
 * out again on each frame from the server and on each tick of the panel's
 * clock. `lists` gives each row's list in play order.
 */
export function useRowDrag(opts: { ids: readonly SoundId[]; lists: readonly number[]; key: string; onDrop(id: SoundId, slot: number): void }) {
  const [held, setHeld] = useState<RowDrag | null>(null);
  // A drag whose key no longer holds is over from this render on, before the effect below lets it go.
  const drag = held !== null && held.key === opts.key ? held : null;
  const live = useRef<RowDrag | null>(null);
  live.current = drag;
  const rows = useRef(new Map<SoundId, HTMLElement>());
  const end = () => {
    live.current = null;
    setHeld(null);
  };

  useEffect(() => {
    if (held !== null && held.key !== opts.key) setHeld(null);
  }, [held, opts.key]);

  const dragging = drag !== null;
  useEffect(() => {
    if (!dragging) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // Escape puts the row back, and is the drag's alone: the window behind it stays open.
      e.preventDefault();
      e.stopPropagation();
      end();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging]);

  const handle = (id: SoundId): HandleEvents => ({
    onPointerDown(e) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const from = opts.ids.indexOf(id);
      if (from < 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const mids = opts.ids.map((x) => {
        const r = rows.current.get(x)?.getBoundingClientRect();
        return r ? r.top + r.height / 2 : 0;
      });
      const row = rows.current.get(id);
      const height = row?.getBoundingClientRect().height ?? 56;
      // The pointer and the rows' boxes read in the screen's px, and a transform inside the dialog's interface size zoom is drawn that much larger.
      const zoom = row?.currentCSSZoom ?? 1;
      const next: RowDrag = { id, from, pointerId: e.pointerId, startY: e.clientY, dy: 0, mids, height, zoom, slot: from, key: opts.key };
      live.current = next;
      setHeld(next);
    },
    onPointerMove(e) {
      const d = live.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const { dy, slot } = dragAt(d.mids, d.from, e.clientY - d.startY);
      if (dy === d.dy && slot === d.slot) return;
      const next = { ...d, dy, slot };
      live.current = next;
      setHeld(next);
    },
    onPointerUp(e) {
      const d = live.current;
      if (!d || d.pointerId !== e.pointerId) return;
      end();
      if (d.key === opts.key) opts.onDrop(d.id, d.slot);
    },
    onPointerCancel: end,
    onLostPointerCapture(e) {
      if (live.current?.pointerId === e.pointerId) end();
    },
  });

  const shift = drag ? makeRoom(opts.lists, drag.from, drag.slot, drag.height / drag.zoom) : null;
  const offsetOf = (id: SoundId): number => {
    if (!drag) return 0;
    if (id === drag.id) return drag.dy / drag.zoom;
    return shift?.[opts.ids.indexOf(id)] ?? 0;
  };
  const rowRef = (id: SoundId) => (el: HTMLElement | null) => {
    if (el) rows.current.set(id, el);
    else rows.current.delete(id);
  };
  return { drag, handle, offsetOf, rowRef };
}

/** A row's look while one lifts and the others make room. */
export function dragRowStyle(offset: number, lifted: boolean, dragging: boolean): CSSProperties {
  return {
    position: "relative",
    zIndex: lifted ? 2 : undefined,
    transform: offset !== 0 ? `translateY(${offset}px)` : undefined,
    boxShadow: lifted ? theme.shadow.pane : undefined,
    background: lifted ? theme.color.surfaceRaised : undefined,
    transition: dragging && !lifted ? "transform 120ms" : undefined,
  };
}

/**
 * A row's drag handle: a button named "Move Tavern theme, 2 of 11" and
 * described "Drag, or press Up or Down." (4.3), which owns its touches
 * (`touch-action: none`), so neither the list's scroll nor the sheet's
 * swipe starts from it.
 */
export function Handle(props: { label: string; helpId: string; lifted: boolean; buttonRef(el: HTMLButtonElement | null): void; onKeyDown(e: KeyboardEvent<HTMLButtonElement>): void; events: HandleEvents }) {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      data-music-handle=""
      aria-label={props.label}
      aria-describedby={props.helpId}
      onKeyDown={props.onKeyDown}
      {...props.events}
      style={{
        flex: "none",
        width: theme.touch,
        minHeight: theme.touch,
        display: "grid",
        placeItems: "center",
        background: "transparent",
        border: "none",
        padding: 0,
        color: theme.color.textMuted,
        cursor: props.lifted ? "grabbing" : "grab",
        touchAction: "none",
        borderRadius: theme.radius.md,
      }}
    >
      <Grip />
    </button>
  );
}

/** The help every handle in a list is described by, once: hidden, so it adds no line to the rows, and still read through its reference. */
export function HandleHelp(props: { id: string }) {
  return (
    <span id={props.id} hidden>
      {HANDLE_HELP}
    </span>
  );
}

/** The polite status a key's move speaks through, "Tavern theme is now 1 of 11.", out of sight. */
export function MoveStatus(props: { text: string }) {
  return (
    <div role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clipPath: "inset(50%)", whiteSpace: "nowrap" }}>
      {props.text}
    </div>
  );
}
