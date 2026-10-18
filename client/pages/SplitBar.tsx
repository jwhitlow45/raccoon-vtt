import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { headerRow, Pill, PILL_FOCUS, PILL_HOST } from "../components/HeaderRow.tsx";
import { Icon } from "../components/Icon.tsx";
import { IconButton } from "../components/IconButton.tsx";
import { Menu, type MenuSection } from "../components/Menu.tsx";
import { Popover, usePopover, type PopoverSide } from "../components/Popover.tsx";
import { panelSections, type PanelDef } from "../features/panels.ts";
import { VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";
import { Badge } from "./RoomChrome.tsx";
import { innerBox, tabLook } from "./SideTabs.tsx";
import { BAR_PX, dragTop, gripStep, separatorValue, type PaneSizes } from "./splitPanes.ts";

/**
 * The bar between the side panel's two panels
 * (docs/design-v1-split-panel.md 3.1, 3.3 and 3.4): the bottom pane's
 * header and the divider. Left to right, the grip, the bottom panel's
 * name, which opens "Panel below", then Swap and Close. It takes the tab
 * row's look (docs/design-v1-side-headers.md): the same band, padding and
 * icons, and the name in the chosen tab's pill, as More wears it for a
 * panel it holds, so the panel below reads as the same kind of thing as
 * the one on top.
 *
 * The grip is the keyboard's way to move the bar, a focusable separator
 * whose Up and Down move it 8 px, or 64 with Shift, each press stored at
 * once. A press on the grip or on the bar's blank part drags it once it
 * passes the slop a tap on the map has, the top pane following the
 * pointer within both panes' least heights, and the release stores it.
 * Escape or a cancelled pointer puts it back. These are the token
 * window's drag rules (docs/design-v1-token-window.md 4.2), on one axis.
 */

/** Marks the bar, so a pane's subpage focus leaves focus on its name (features/panels.ts useSubpageFocus) and the O key knows which side of it focus is. */
export const PANE_BAR_ATTR = "data-pane-bar";

type Drag = { pointerId: number; el: HTMLElement; y: number; start: number; top: number | null };

export function SplitBar(props: {
  hidden: boolean;
  zoom: number;
  /** The role's panels from 900 px up, every one "Panel below" lists. */
  panels: PanelDef[];
  grouped: boolean;
  top: PanelDef;
  below: PanelDef;
  badges: Record<string, number>;
  badgeLabels: Record<string, string>;
  sizes: PaneSizes;
  /** The top pane's id, which the grip controls. */
  topPaneId: string;
  /** The name's id, which names the bottom pane's group. */
  nameId: string;
  nameRef: RefObject<HTMLButtonElement | null>;
  barRef: RefObject<HTMLDivElement | null>;
  onPick(id: string): void;
  onSwap(): void;
  onClose(): void;
  /** The top pane's height while a drag moves the bar, or null as it ends. */
  onDrag(top: number | null): void;
  /** Stores the bar's place as the top pane's height: a drop or a key step. */
  onPlace(top: number): void;
}) {
  const { sizes, zoom } = props;
  const swapDescribed = useId();
  const menu = usePopover({ kind: "menu", fallbackFocus: () => props.nameRef.current });
  const [side, setSide] = useState<PopoverSide>("below");
  const latest = useRef(props);
  latest.current = props;

  /*
   * The bar's drag. Escape or a cancelled pointer puts the bar back as the
   * drag began and stores nothing. A capture listener on the window, there
   * only while a drag is under way, takes Escape first, and its
   * preventDefault leaves Room's Escape alone, as the token window's does.
   */
  const dragRef = useRef<Drag | null>(null);
  const endDrag = useRef(() => {});
  const onEscape = useRef((e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    endDrag.current();
  });
  endDrag.current = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    window.removeEventListener("keydown", onEscape.current, true);
    if (drag?.el.hasPointerCapture(drag.pointerId)) drag.el.releasePointerCapture(drag.pointerId);
    if (drag?.top !== null && drag?.top !== undefined) latest.current.onDrag(null);
  };
  useEffect(() => () => window.removeEventListener("keydown", onEscape.current, true), []);
  // The side panel hiding (S) or the room too short for two ends a drag as a cancelled pointer does, and closes the menu with its anchor.
  const closeMenu = menu.close;
  useEffect(() => {
    if (!props.hidden) return;
    if (dragRef.current) endDrag.current();
    closeMenu("gone");
  }, [props.hidden, closeMenu]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // One pointer at a time, and a mouse's main button only.
    if (dragRef.current || (e.pointerType === "mouse" && e.button !== 0)) return;
    // The name, Swap, Close and the open menu, which stands inside the bar so Tab goes on from it to Swap, keep their presses. The grip and the bar's blank part drag.
    if (e.target instanceof Element && e.target.closest("button, [data-rvtt-popover]")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, el: e.currentTarget, y: e.clientY, start: sizes.top, top: null };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    const top = dragTop(sizes, drag.start, (e.clientY - drag.y) / zoom, drag.top !== null);
    if (top === null) return;
    if (drag.top === null) window.addEventListener("keydown", onEscape.current, true);
    drag.top = top;
    props.onDrag(top);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (drag.top !== null) props.onPlace(drag.top);
    endDrag.current();
  };
  const onPointerCancel = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) endDrag.current();
  };

  // Up and Down on the grip, each step stored at once and clamped. Left, Right, Home and End do nothing there.
  const onGripKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const step = gripStep(e.key, e.shiftKey);
    if (step === null) return;
    e.preventDefault();
    props.onPlace(Math.min(sizes.max, Math.max(sizes.min, sizes.top + step)));
  };

  // "Panel below" opens on the side of the bar with more room in the side panel, decided as it opens.
  const decideSide = () => {
    const anchor = props.nameRef.current;
    const aside = anchor?.closest("aside");
    if (!anchor || !aside) return;
    const box = innerBox(aside, zoom);
    const r = anchor.getBoundingClientRect();
    setSide(r.top / zoom - box.top > box.bottom - r.bottom / zoom ? "above" : "below");
  };
  const anchorRef = menu.anchorProps.ref;
  const nameRefs = useCallback(
    (el: HTMLButtonElement | null) => {
      props.nameRef.current = el;
      anchorRef(el);
    },
    [anchorRef, props.nameRef],
  );

  const sections: MenuSection[] = panelSections(props.panels, props.grouped).map((s) => ({
    key: s.key,
    ...(s.label ? { heading: s.label } : null),
    separator: s.line,
    items: s.panels.map((p) => {
      const n = props.badges[p.id] ?? 0;
      return {
        id: p.id,
        title: p.title,
        checked: p.id === props.below.id,
        ...(p.id === props.top.id ? { note: "on top", description: "Shown on top" } : null),
        ...(n > 0 ? { badge: <Badge count={n} label={props.badgeLabels[p.id]} /> } : null),
      };
    }),
  }));

  const value = separatorValue(sizes);
  return (
    <div
      ref={props.barRef}
      hidden={props.hidden}
      {...{ [PANE_BAR_ATTR]: "" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      style={{
        ...headerRow(true),
        position: "relative",
        flex: "none",
        height: BAR_PX,
        touchAction: "none",
        userSelect: "none",
      }}
    >
      {/* The line over the bar, where it meets the pane above, drawn inside its band so the bar is a header row's height, as the tab row is. */}
      <span aria-hidden style={{ position: "absolute", left: 0, right: 0, top: 0, height: theme.line.border, background: theme.color.border, pointerEvents: "none" }} />
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize the two panels"
        aria-orientation="horizontal"
        aria-controls={props.topPaneId}
        aria-valuenow={value.now}
        aria-valuemin={value.min}
        aria-valuemax={value.max}
        aria-valuetext={`${props.top.title} ${value.now} percent`}
        onKeyDown={onGripKey}
        style={GRIP}
      >
        <Icon name="grip" size="sm" />
      </div>
      <button
        ref={nameRefs}
        id={props.nameId}
        type="button"
        aria-haspopup={menu.anchorProps["aria-haspopup"]}
        aria-expanded={menu.anchorProps["aria-expanded"]}
        aria-controls={menu.anchorProps["aria-controls"]}
        onClick={(e) => {
          if (!menu.open) decideSide();
          menu.onAnchorClick(e);
        }}
        onKeyDown={(e) => {
          if (!menu.open && (e.key === "ArrowDown" || e.key === "ArrowUp")) decideSide();
          menu.onAnchorKeyDown(e);
        }}
        {...PILL_FOCUS}
        style={{ ...NAME, ...tabLook(true).button }}
      >
        {/* The title cuts in its own span, and the name keeps the whole title and says where it is, so speech input that says "Token" finds it. */}
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
          {props.below.title}
          <span style={VISUALLY_HIDDEN}> below</span>
        </span>
        <Icon name="chevronDown" size="sm" style={menu.open ? { transform: "rotate(180deg)" } : undefined} />
        <Pill look={tabLook(true).pill} />
      </button>
      <Popover handle={menu} side={side} bound={() => innerBox(props.nameRef.current?.closest("aside") ?? document.body, latest.current.zoom)}>
        <Menu label="Panel below" sections={sections} onPick={props.onPick} data={{ "data-tabs-menu": "" }} />
      </Popover>
      {/* The bar's blank part, a drag handle as the grip is. */}
      <span aria-hidden style={{ flex: 1, alignSelf: "stretch", cursor: "row-resize" }} />
      <IconButton icon="swapPanels" label="Swap panels" aria-describedby={swapDescribed} onClick={props.onSwap} />
      <span id={swapDescribed} hidden>
        Puts {props.below.title} on top
      </span>
      <IconButton icon="close" label={`Close ${props.below.title}`} onClick={props.onClose} />
    </div>
  );
}

const GRIP: CSSProperties = {
  flex: "none",
  display: "grid",
  placeItems: "center",
  width: theme.touch,
  height: theme.touch,
  borderRadius: theme.radius.md,
  color: theme.color.textMuted,
  cursor: "row-resize",
};

/** The bottom panel's name: a tab's box and type, as wide as its words, as More is when it names a panel. */
const NAME: CSSProperties = {
  ...PILL_HOST,
  flex: "0 1 auto",
  minWidth: theme.touch,
  minHeight: theme.touch,
  display: "inline-flex",
  alignItems: "center",
  gap: 2,
  padding: `0 ${theme.space(1.5)}px`,
  borderRadius: theme.radius.md,
  fontFamily: theme.font.body,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  whiteSpace: "nowrap",
  cursor: "pointer",
};
