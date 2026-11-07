import { Fragment, useId, useLayoutEffect, useRef, useState, type CSSProperties, type DOMAttributes, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { effectiveZoom } from "../features/device/layout.ts";
import { theme } from "../lib/theme.ts";
import { letterOf } from "../state/shortcuts.ts";
import { useHeld } from "./Held.tsx";
import { Icon } from "./Icon.tsx";
import { buttonLook } from "./looks.ts";
import { menuAction, openingIndex, typeahead, type Typed } from "./menuKeys.ts";
import { laidGap, menuWidth, tileRows } from "./menuTiles.ts";
import { sectionLabelLook } from "./Panel.tsx";
import { focusInView, usePopoverContext } from "./Popover.tsx";

/**
 * A pick list on the shared popover base (docs/design/design-v1-panel-tabs.md
 * 4.4, 5.1 and 5.2): the side panel's More, and Setup and Tools in the
 * toolbar, drawn as tiles (docs/design/design-v1-tool-options.md 5.1 and 5.2),
 * so all three take the same keys. Render it inside a "menu" Popover.
 *
 * `role="menu"` named by `label`, its items `menuitemradio`, the one in
 * use checked, since choosing among them is one choice. An item may be a
 * `menuitemcheckbox` instead, a switch of its own beside that choice, such
 * as More's "Two panels" (docs/design/design-v1-split-panel.md 6), or a plain
 * `menuitem` in a menu of actions with no choice to hold, such as a roll
 * card's asks of the DM, and any item may be disabled: it takes focus, so its description is heard, and picks
 * nothing. A section's
 * heading is hidden text that names its `role="group"`, and a section may
 * start after a `role="separator"` line. Keys (components/menuKeys.ts):
 * Down and Up, or in tiles also Right and Left, move and wrap, Home and
 * End go to the ends, a letter types ahead, Enter or Space picks. Every
 * key it handles is marked used, so no room shortcut runs while focus is
 * in it. Escape, Tab and Shift+Tab are the base's.
 *
 * Its items are divs, which a disabled fieldset never stops, so a menu
 * opened inside a held group (Held.tsx) holds every item itself: each
 * draws disabled and says so, picks nothing by pointer or key, and drops
 * its press binding. The keys still move through them, and the menu stays
 * open, so it reads as off rather than vanishing under the pointer
 * (D-261101-314).
 */

export type MenuItem = {
  id: string;
  /** Its visible name, which typeahead reads. */
  title: string;
  checked?: boolean;
  /** At its end, such as an unread count whose hidden words then join the item's name. */
  badge?: ReactNode;
  /** Its description (`aria-describedby`), such as "Pick again to hide its options." */
  description?: string;
  /** A tile's glyph, above its words, or a row's, before them. */
  glyph?: ReactNode;
  /**
   * "radio" (the default): one of the menu's one choice. "checkbox": a switch of its own, checked in the pressed look with a check mark at its end.
   * "action": a plain menuitem that does something and holds no state, so it has no checked state to announce.
   */
  kind?: "radio" | "checkbox" | "action";
  /** `aria-disabled`: it stays focusable and picks nothing. */
  disabled?: boolean;
  /** Muted words at a row's end, such as "on top". Hidden from screen readers, since its description says it. */
  note?: string;
  /** The shortcut it does, from state/shortcuts.ts useKeyHint: `title` its hover title with the key, "Fog (F)", and `aria` its `aria-keyshortcuts`. A roll's options keys have no hover title. */
  keys?: { title?: string; aria: string };
  /** Drawn in place of `title`, which still names it for typeahead, such as a roll's name, tags and bonus (docs/design/design-v1-stat-block-rolls.md 4.2). */
  content?: ReactNode;
  /** Merged over the row's own look, such as a proficiency border. */
  style?: CSSProperties;
  /** Data attributes for the item, such as its proficiency mark. */
  data?: Readonly<Record<`data-${string}`, string>>;
  /** Its accessible name (`aria-label`) where its drawn words say less. */
  label?: string;
  /** `aria-busy`: its action waits, and it picks nothing meanwhile. */
  busy?: boolean;
  /** A press binding's handlers (useRollPressBinding). Never an `onClick`: Menu's own click is the one pick (4.7). */
  events?: MenuItemEvents;
};

/** The handlers an item's press binding adds. A click stays Menu's pick, which the binding's window capture listener gates. */
export type MenuItemEvents = Partial<Pick<DOMAttributes<HTMLDivElement>, "onPointerDown" | "onTouchStart" | "onTouchEnd" | "onTouchCancel" | "onLostPointerCapture" | "onContextMenu" | "onKeyDown">>;

export type MenuSection = {
  key: string;
  /** A label over the section's items, which names their group. */
  heading?: string;
  /** A plain line before the section, as before Menu in the side panel's More. */
  separator?: boolean;
  items: readonly MenuItem[];
};

/** How an item was picked. */
export type MenuPickBy = "pointer" | "key";

/**
 * What a pick answers: "stay" keeps the menu open for a pick whose result
 * shows in the menu itself, such as a move of the players that asks first
 * or waits on the server (docs/design/design-v1-qol.md 4, C2's move, D-261106-136). Any
 * other answer closes it as ever, so a pick written to return whatever
 * its last call returned still closes.
 */
export type MenuPickResult = unknown;

/**
 * The item focus moves to after a render, or null. Only a change moves
 * it, so the menu's own keys keep their place while the target stands.
 */
export function focusMove(before: string | null, now: string | null): string | null {
  return now !== before ? now : null;
}

/**
 * The item a key opening focuses: by default the checked choice, else the
 * first (openingIndex). `atEdge`: the first item, or the last for Up,
 * for a menu of actions that holds a choice partway down, such as the DM
 * menu's Map phase (docs/design/design-v1-qol.md 7).
 */
export function openingAt(items: readonly MenuItem[], from: "first" | "last", opts: { atEdge?: boolean; skipDisabled?: boolean } = {}): number {
  if (!opts.atEdge) return openingIndex(items, from, opts.skipDisabled);
  return from === "last" ? items.length - 1 : items.length > 0 ? 0 : -1;
}

/** A double tap's span: a menu that covers its anchor ignores a press that starts this soon after it opens (D-261101-313). */
export const COVER_GUARD_MS = 350;

export function Menu(props: {
  /** The menu's name: "More panels", "Setup tools", "Tools". */
  label: string;
  sections: readonly MenuSection[];
  /**
   * The pick. It runs before focus goes back to the anchor, so the anchor
   * names what was picked by then. `by` is "key" for Enter or Space, and for
   * a click with `detail` 0, a reader's activation with no finger down
   * (D-261101-098), else "pointer". "stay" keeps the menu open.
   */
  onPick(id: string, by: MenuPickBy): MenuPickResult;
  /**
   * The item focus moves to once drawn, whenever this changes: a pick that
   * kept the menu open names the item that took the picked one's place,
   * such as "Show players anyway" (docs/design/design-v1-qol.md 4, C2's move).
   */
  focus?: string | null;
  /** Tiles in rows, for Setup and Tools, where Right and Left move as Down and Up do. */
  tiles?: boolean;
  /** Roll options open at an enabled action. Other menus retain their existing opening rule. */
  skipDisabledOnOpen?: boolean;
  /** A key opening focuses the first item, or the last for Up, never a checked choice inside (openingAt). */
  openAtEdge?: boolean;
  /** Data attributes for the menu element, such as the side panel's `data-tabs-menu`. */
  data?: Readonly<Record<`data-${string}`, string>>;
}) {
  const { handle, setInsideFocus, setFitContent, placed } = usePopoverContext();
  const held = useHeld();
  const tiles = props.tiles === true;
  const ids = useId();
  const items = props.sections.flatMap((s) => s.items);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const root = useRef<HTMLDivElement | null>(null);
  const typed = useRef<Typed | null>(null);
  const [openedAt] = useState(() => performance.now());
  const guarded = useRef(false);

  const focusItem = (index: number) => {
    const item = items[index];
    const node = item ? nodes.current.get(item.id) : undefined;
    if (node) focusInView(node);
  };

  useLayoutEffect(() => {
    setInsideFocus((from) => focusItem(openingAt(items, from, { atEdge: props.openAtEdge, skipDisabled: props.skipDisabledOnOpen })));
    return () => setInsideFocus(null);
  });

  // In the commit that drew the target, so focus never falls to the page from an item that left with the pick.
  const focusTarget = props.focus ?? null;
  const lastTarget = useRef(focusTarget);
  useLayoutEffect(() => {
    const id = focusMove(lastTarget.current, focusTarget);
    lastTarget.current = focusTarget;
    const node = id === null ? undefined : nodes.current.get(id);
    if (!node) return;
    focusInView(node);
    // The item's own lines may place the box again, from its top (Popover.tsx contentKey), so it is brought into view once that is done.
    const frame = requestAnimationFrame(() => {
      if (document.activeElement === node) focusInView(node);
    });
    return () => cancelAnimationFrame(frame);
  }, [focusTarget]);

  /*
   * The popover calls this as it places its box (Popover.tsx
   * setFitContent), with `room`: the widest content the box may hold, its
   * widest box less its padding and border.
   *
   * Rows: a row's label has a zero flex basis, so left to itself the box
   * would hug the shortest words. So the menu and each row are measured at
   * their own max-content widths, with ROWS_WIDTH cleared first, and the
   * menu takes the widest of them, capped at `room` (menuWidth), in
   * ROWS_WIDTH.
   *
   * Tiles: a wrapping row of tiles cannot balance itself in CSS: its last
   * row may hold one tile alone, and the box keeps the width of the full
   * row above. So each section's tiles are measured at their own widths
   * against the room the box gives them (the menu's own width, which the
   * box caps), and take the width cap tileRows picks, in TILES_WIDTH. The
   * box then measures the rows they settle into.
   *
   * Either width is a custom property React never writes, so a render
   * while the menu is open keeps it. It refreshes only when the popover
   * places the box, so an item whose width changes while the menu is open
   * keeps the width it had.
   */
  useLayoutEffect(() => {
    setFitContent((room) => {
      const menu = root.current;
      if (!menu) return;
      if (!tiles) {
        // Measure whole rows before constraining them. A flex label's zero basis can otherwise make the popover hug its shortest words.
        menu.style.removeProperty(ROWS_WIDTH);
        const zoom = effectiveZoom(menu);
        const widths = [menu.getBoundingClientRect().width / zoom];
        for (const node of nodes.current.values()) {
          node.style.width = "max-content";
          widths.push(node.getBoundingClientRect().width / zoom);
          node.style.width = "";
        }
        menu.style.setProperty(ROWS_WIDTH, `${menuWidth(widths, room)}px`);
        return;
      }
      for (const row of menu.querySelectorAll<HTMLElement>("[data-rvtt-tiles]")) {
        row.style.removeProperty(TILES_WIDTH);
        const zoom = effectiveZoom(row);
        const rects = [...row.children].map((tile) => tile.getBoundingClientRect());
        // The gap as laid out between two tiles of one row: the browser snaps a zoomed gap to its layout unit, so the computed one runs over under zoom.
        const gap = laidGap(rects, (parseFloat(getComputedStyle(row).columnGap) || 0) * zoom);
        const { width } = tileRows(rects.map((r) => r.width), gap, menu.getBoundingClientRect().width);
        // Half a pixel over the widest row, so rounding never sends its last tile down. The next tile is a whole tile wider.
        if (width !== null) row.style.setProperty(TILES_WIDTH, `${width / zoom + 0.5}px`);
      }
    });
    return () => setFitContent(null);
  });

  /*
   * The pick runs first and its render commits at once, then focus goes to
   * the anchor and the menu closes. So the anchor already names the pick
   * when focus reaches it ("Monsters, tab, selected"), and focus never
   * falls to the page between the item going and the anchor taking it. A
   * pick that answers "stay" leaves the menu open, focus where its render
   * put it.
   */
  const pick = (id: string, by: MenuPickBy) => {
    const it = items.find((item) => item.id === id);
    if (held || it?.disabled === true || it?.busy === true) return;
    const result = flushSync(() => props.onPick(id, by));
    if (result !== "stay") handle.close("pick");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const focused = items.findIndex((item) => nodes.current.get(item.id) === document.activeElement);
    const action = menuAction({ key: e.key, letter: letterOf(e), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }, focused, items.length, tiles, (i) => held || items[i]?.disabled === true);
    if (action.type === "none") return;
    e.preventDefault();
    if (action.type === "focus") focusItem(action.index);
    else if (action.type === "pick") pick(items[action.index]!.id, "key");
    else {
      const next = typeahead(
        typed.current,
        action.letter,
        e.timeStamp,
        items.map((item) => item.title),
        focused,
      );
      typed.current = next.typed;
      if (next.index !== null) focusItem(next.index);
    }
  };

  /*
   * A menu slid back over its anchor to stand whole (popoverPlace's
   * `covers`) puts a row where the anchor was, so a fast second tap aimed
   * at the anchor would pick that row. A press that starts that soon after
   * the menu opens neither picks nor starts the row's press binding. A key,
   * and any later press, acts as ever. `covers` is read only where the
   * placement gives it.
   */
  const coverGuards = () => {
    const at = placed.current;
    const covers = at !== null && "covers" in at && at.covers === true;
    return covers && performance.now() - openedAt < COVER_GUARD_MS;
  };

  const item = (it: MenuItem) => {
    const checked = it.checked === true;
    const checkbox = it.kind === "checkbox";
    const disabled = held || it.disabled === true;
    // AbilityMenu's rows roll from their press binding (a long press, ContextMenu, Shift+F10) without a pick, and their owner's own disabled never learned the held group.
    const events = held ? undefined : it.events;
    const described = it.description ? `${ids}-${it.id}` : undefined;
    const look = buttonLook("quiet", { pressed: checked, disabled });
    return (
      // A binding's handlers go first, so Menu's own click below stays the one pick (docs/design/design-v1-stat-block-rolls.md 4.7).
      <div
        key={it.id}
        {...it.data}
        {...events}
        onPointerDown={(e) => {
          guarded.current = coverGuards();
          if (!guarded.current) events?.onPointerDown?.(e);
        }}
        ref={(node) => {
          if (node) nodes.current.set(it.id, node);
          else nodes.current.delete(it.id);
        }}
        role={checkbox ? "menuitemcheckbox" : it.kind === "action" ? "menuitem" : "menuitemradio"}
        aria-checked={it.kind === "action" ? undefined : checked}
        aria-disabled={disabled || undefined}
        aria-busy={it.busy || undefined}
        aria-label={it.label}
        aria-describedby={described}
        aria-keyshortcuts={it.keys?.aria}
        title={it.keys?.title}
        tabIndex={-1}
        onClick={(e) => {
          const by = e.detail === 0 ? "key" : "pointer";
          const ignored = guarded.current && by === "pointer";
          guarded.current = false;
          if (!ignored) pick(it.id, by);
        }}
        style={tiles ? { ...TILE, ...look, ...it.style } : { ...ROW, ...look, ...(disabled || it.busy ? { cursor: "default" } : null), ...it.style }}
      >
        {tiles ? (
          <>
            {it.glyph ? <span aria-hidden style={{ display: "grid", placeItems: "center" }}>{it.glyph}</span> : null}
            {it.content ?? <span>{it.title}</span>}
          </>
        ) : (
          <>
            {it.glyph ? <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none" }}>{it.glyph}</span> : null}
            {/* Unlike anywhere, break-word preserves the intrinsic word width while keeping a name longer than the cap inside the menu. */}
            {it.content ?? <span style={{ flex: "1 1 auto", minWidth: 0, whiteSpace: "normal", overflowWrap: "break-word", wordBreak: "normal" }}>{it.title}</span>}
            {it.note ? (
              // An item that is off draws every word dim, its note too, which says why it is off (docs/design/design-v1-look-pass-1.md 1).
              <span aria-hidden style={{ flex: "none", color: disabled ? theme.color.textDisabled : theme.color.textMuted, fontSize: theme.font.small, fontWeight: theme.weight.regular }}>
                {it.note}
              </span>
            ) : null}
            {it.badge}
            {checkbox && checked ? <Icon name="check" size="sm" /> : null}
          </>
        )}
        {/* Hidden, so it is no part of the item's name, and still its description. */}
        {described ? (
          <span id={described} hidden>
            {it.description}
          </span>
        ) : null}
      </div>
    );
  };

  const group = (section: MenuSection) => {
    const content = tiles ? (
      // Capped by the popover's placing where the tiles do not fit one row (TILES_WIDTH).
      <div data-rvtt-tiles="" style={{ display: "flex", flexWrap: "wrap", gap: theme.space(1), maxWidth: `var(${TILES_WIDTH}, none)` }}>
        {section.items.map(item)}
      </div>
    ) : (
      section.items.map(item)
    );
    if (!section.heading) return content;
    const headingId = `${ids}-${section.key}`;
    return (
      <div role="group" aria-labelledby={headingId} style={{ display: "grid", gridTemplateColumns: tiles ? undefined : "minmax(0, 1fr)" }}>
        <div id={headingId} aria-hidden style={{ ...sectionLabelLook(), padding: `${theme.space(2)}px ${theme.space(3)}px ${theme.space(1)}px` }}>
          {section.heading}
        </div>
        {content}
      </div>
    );
  };

  return (
    // The columns here and in each group must shrink below a word's intrinsic width so break-word can keep a long name within the cap.
    <div {...props.data} ref={root} role="menu" id={handle.contentId} aria-label={props.label} onKeyDown={onKeyDown} style={{ display: "grid", gridTemplateColumns: tiles ? undefined : "minmax(0, 1fr)", gap: tiles ? theme.space(2) : 0, width: tiles ? undefined : `var(${ROWS_WIDTH}, auto)`, maxWidth: tiles ? undefined : "100%" }}>
      {props.sections.map((section) => (
        <Fragment key={section.key}>
          {section.separator ? <div role="separator" style={{ height: theme.line.border, margin: `${theme.space(1)}px 0`, background: theme.color.border }} /> : null}
          {group(section)}
        </Fragment>
      ))}
    </div>
  );
}

/** The custom property that caps a section's row of tiles where they wrap, set as the popover places its box. */
const TILES_WIDTH = "--rvtt-tiles-width";

/** The measured row width survives renders until the popover places the menu again. */
const ROWS_WIDTH = "--rvtt-menu-width";

/** A list item: 44 px tall, the menu's full width, its badge at the end, as the phone's list of panels has it. */
const ROW = {
  display: "flex",
  alignItems: "center",
  gap: theme.space(2),
  minHeight: theme.touch,
  padding: `0 ${theme.space(3)}px`,
  borderRadius: theme.radius.md,
  whiteSpace: "nowrap",
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  cursor: "pointer",
} as const;

/**
 * A tile (docs/design/design-v1-tool-options.md 7.2): words with a glyph above
 * where one exists, as the toolbar's buttons have them. Its side padding
 * is 4 px, as above and below, so the DM's five setup tools stand in one
 * row from a 430 px phone up: at 8 px they needed 4 px more than a 440 px
 * phone gives. The 60 px minimum and the gap still keep two tiles' words
 * apart.
 */
const TILE = {
  display: "grid",
  justifyItems: "center",
  alignContent: "center",
  gap: theme.space(1),
  minWidth: theme.layout.popover.tile,
  minHeight: theme.layout.popover.tile,
  padding: theme.space(1),
  borderRadius: theme.radius.md,
  textAlign: "center",
  fontSize: theme.font.small,
  fontWeight: theme.weight.strong,
  cursor: "pointer",
} as const;
