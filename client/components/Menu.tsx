import { Fragment, useId, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { effectiveZoom } from "../features/device/layout.ts";
import { theme } from "../lib/theme.ts";
import { letterOf } from "../state/shortcuts.ts";
import { Icon } from "./Icon.tsx";
import { buttonLook } from "./looks.ts";
import { menuAction, openingIndex, typeahead, type Typed } from "./menuKeys.ts";
import { tileRows } from "./menuTiles.ts";
import { sectionLabelLook } from "./Panel.tsx";
import { focusInView, usePopoverContext } from "./Popover.tsx";

/**
 * A pick list on the shared popover base (docs/design-v1-panel-tabs.md
 * 4.4, 5.1 and 5.2): the side panel's More, and Setup and Tools in the
 * toolbar, drawn as tiles (docs/design-v1-tool-options.md 5.1 and 5.2),
 * so all three take the same keys. Render it inside a "menu" Popover.
 *
 * `role="menu"` named by `label`, its items `menuitemradio`, the one in
 * use checked, since choosing among them is one choice. An item may be a
 * `menuitemcheckbox` instead, a switch of its own beside that choice, such
 * as More's "Two panels" (docs/design-v1-split-panel.md 6), or a plain
 * `menuitem` in a menu of actions with no choice to hold, such as a roll
 * card's asks of the DM, and any item may be disabled: it takes focus, so its description is heard, and picks
 * nothing. A section's
 * heading is hidden text that names its `role="group"`, and a section may
 * start after a `role="separator"` line. Keys (components/menuKeys.ts):
 * Down and Up, or in tiles also Right and Left, move and wrap, Home and
 * End go to the ends, a letter types ahead, Enter or Space picks. Every
 * key it handles is marked used, so no room shortcut runs while focus is
 * in it. Escape, Tab and Shift+Tab are the base's.
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
};

export type MenuSection = {
  key: string;
  /** A label over the section's items, which names their group. */
  heading?: string;
  /** A plain line before the section, as before Menu in the side panel's More. */
  separator?: boolean;
  items: readonly MenuItem[];
};

export function Menu(props: {
  /** The menu's name: "More panels", "Setup tools", "Tools". */
  label: string;
  sections: readonly MenuSection[];
  /** The pick. It runs before focus goes back to the anchor, so the anchor names what was picked by then. */
  onPick(id: string): void;
  /** Tiles in rows, for Setup and Tools, where Right and Left move as Down and Up do. */
  tiles?: boolean;
  /** Data attributes for the menu element, such as the side panel's `data-tabs-menu`. */
  data?: Readonly<Record<`data-${string}`, string>>;
}) {
  const { handle, setInsideFocus, setFitContent } = usePopoverContext();
  const tiles = props.tiles === true;
  const ids = useId();
  const items = props.sections.flatMap((s) => s.items);
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const root = useRef<HTMLDivElement | null>(null);
  const typed = useRef<Typed | null>(null);

  const focusItem = (index: number) => {
    const item = items[index];
    const node = item ? nodes.current.get(item.id) : undefined;
    if (node) focusInView(node);
  };

  useLayoutEffect(() => {
    setInsideFocus((from) => focusItem(openingIndex(items, from)));
    return () => setInsideFocus(null);
  });

  /*
   * A wrapping row of tiles cannot balance itself in CSS: its last row may
   * hold one tile alone, and the box keeps the width of the full row
   * above. So as the popover places its box, each section's tiles are
   * measured at their own widths against the room the box gives them (the
   * menu's own width, which the box caps), and take the width cap
   * tileRows picks. The box then measures the rows they settle into. The
   * cap is a custom property React never writes, so a render while the
   * menu is open keeps it.
   */
  useLayoutEffect(() => {
    if (!tiles) return;
    setFitContent(() => {
      const menu = root.current;
      if (!menu) return;
      for (const row of menu.querySelectorAll<HTMLElement>("[data-rvtt-tiles]")) {
        row.style.removeProperty(TILES_WIDTH);
        const zoom = effectiveZoom(row);
        const widths = [...row.children].map((tile) => tile.getBoundingClientRect().width);
        const { width } = tileRows(widths, (parseFloat(getComputedStyle(row).columnGap) || 0) * zoom, menu.getBoundingClientRect().width);
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
   * falls to the page between the item going and the anchor taking it.
   */
  const pick = (id: string) => {
    if (items.find((item) => item.id === id)?.disabled === true) return;
    flushSync(() => props.onPick(id));
    handle.close("pick");
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return;
    const focused = items.findIndex((item) => nodes.current.get(item.id) === document.activeElement);
    const action = menuAction({ key: e.key, letter: letterOf(e), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }, focused, items.length, tiles, (i) => items[i]?.disabled === true);
    if (action.type === "none") return;
    e.preventDefault();
    if (action.type === "focus") focusItem(action.index);
    else if (action.type === "pick") pick(items[action.index]!.id);
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

  const item = (it: MenuItem) => {
    const checked = it.checked === true;
    const checkbox = it.kind === "checkbox";
    const disabled = it.disabled === true;
    const described = it.description ? `${ids}-${it.id}` : undefined;
    const look = buttonLook("quiet", { pressed: checked, disabled });
    return (
      <div
        key={it.id}
        ref={(node) => {
          if (node) nodes.current.set(it.id, node);
          else nodes.current.delete(it.id);
        }}
        role={checkbox ? "menuitemcheckbox" : it.kind === "action" ? "menuitem" : "menuitemradio"}
        aria-checked={it.kind === "action" ? undefined : checked}
        aria-disabled={disabled || undefined}
        aria-describedby={described}
        tabIndex={-1}
        onClick={() => pick(it.id)}
        style={tiles ? { ...TILE, ...look } : { ...ROW, ...look, ...(disabled ? { cursor: "default" } : null) }}
      >
        {tiles ? (
          <>
            {it.glyph ? <span aria-hidden style={{ display: "grid", placeItems: "center" }}>{it.glyph}</span> : null}
            <span>{it.title}</span>
          </>
        ) : (
          <>
            {it.glyph ? <span aria-hidden style={{ display: "grid", placeItems: "center", flex: "none" }}>{it.glyph}</span> : null}
            <span style={{ flex: 1, minWidth: 0 }}>{it.title}</span>
            {it.note ? (
              <span aria-hidden style={{ flex: "none", color: theme.color.textMuted, fontSize: theme.font.small, fontWeight: theme.weight.regular }}>
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
      <div role="group" aria-labelledby={headingId} style={{ display: "grid" }}>
        <div id={headingId} aria-hidden style={{ ...sectionLabelLook(), padding: `${theme.space(2)}px ${theme.space(3)}px ${theme.space(1)}px` }}>
          {section.heading}
        </div>
        {content}
      </div>
    );
  };

  return (
    <div {...props.data} ref={root} role="menu" id={handle.contentId} aria-label={props.label} onKeyDown={onKeyDown} style={{ display: "grid", gap: tiles ? theme.space(2) : 0 }}>
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
 * A tile (docs/design-v1-tool-options.md 7.2): words with a glyph above
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
