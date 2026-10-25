import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { headerRow, Pill, PILL_FOCUS, PILL_HOST } from "../components/HeaderRow.tsx";
import { Icon } from "../components/Icon.tsx";
import { useTooltip } from "../components/Tooltip.tsx";
import { PRESSED } from "../components/looks.ts";
import { Menu, type MenuItem, type MenuSection } from "../components/Menu.tsx";
import { Popover, usePopover, type Rect } from "../components/Popover.tsx";
import { HideButton } from "../components/SheetHeader.tsx";
import { panelSections, type PanelDef } from "../features/panels.ts";
import { tabKeyIndex, VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { isCoarsePointer } from "../lib/device.ts";
import { theme } from "../lib/theme.ts";
import { Badge } from "./RoomChrome.tsx";
import { fitTabs, GROUP_GAP, nameCut, TAB_GAP, headerNamesOpen, tabLook as pickLook, widthsFor, type TabFit, type TabLook, type TabWidths } from "./tabFit.ts";

/**
 * The side panel's tabs in one row (docs/design-v1-panel-tabs.md): the
 * registry's order, as many as fit (pages/tabFit.ts), then More, a tab
 * whose menu lists the rest under the phone list's groups. Nothing moves
 * a tab: the row depends only on the widths this device draws and the
 * room it has. A panel opened from More, by its menu or from anywhere
 * else, shows its name on More, which is then the chosen tab, so the tab
 * list always has one and every rule that sends focus to "the chosen tab"
 * finds More.
 *
 * Badges sit on each tab's corner, so a count never widens a tab. More
 * shows the sum of the counts of the panels it holds, and its menu shows
 * each one's.
 */

/** Tabs and More: the 44 px tab, with 6 px side padding so Token, Initiative, Log and More fit 295 px with a wide font (3.4). */
const TAB_BOX: CSSProperties = {
  boxSizing: "border-box",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: TAB_GAP,
  minHeight: theme.touch,
  minWidth: theme.touch,
  padding: `0 ${theme.space(1.5)}px`,
  border: `${theme.line.border}px solid transparent`,
  borderRadius: theme.radius.md,
  fontFamily: theme.font.body,
  fontSize: theme.font.body14,
  fontWeight: theme.weight.strong,
  whiteSpace: "nowrap",
};

/**
 * A side panel tab at rest. The chosen one draws the pressed look on its
 * pill (components/HeaderRow.tsx), as every other chosen option does
 * (docs/design-v1-visual.md 3.2), so choosing never changes a width, and
 * the bar's name wears the same pill for the panel below
 * (docs/design-v1-side-headers.md).
 */
const TAB_REST: CSSProperties = { background: "transparent", border: `${theme.line.border}px solid transparent`, color: theme.color.textMuted };

/** A tab's look: its text in the accent while chosen, its pill pressed. */
export function tabLook(chosen: boolean): { button: CSSProperties; pill: CSSProperties | null } {
  return { button: { ...TAB_REST, ...(chosen ? { color: theme.color.accent } : null) }, pill: chosen ? PRESSED : null };
}

/** A panel's icon before its name, 2 px more than the row's gap apart, as every tab and More draw it and the measuring row measures it. */
const NAMED_ICON: CSSProperties = { marginRight: theme.space(0.5) };

/** More's place among the row's stops for the tab keys. */
const MORE = "\u0000more";

/** "Two panels" in More's menu, an id no panel has. */
const SPLIT_ITEM = "\u0000split";

/**
 * The bottom panel's mark on its tab (docs/design-v1-split-panel.md 6): a
 * 2 px accent line along its pill's foot, over the pill's 1 px border,
 * inside the tab's fixed box, so the fit reads nothing new. A border,
 * unlike a shadow, stays in forced colors.
 */
const BELOW_MARK: CSSProperties = {
  position: "absolute",
  left: theme.space(1),
  right: theme.space(1),
  bottom: -theme.line.border,
  height: 0,
  borderBottom: `${theme.line.strong}px solid ${theme.color.accent}`,
  pointerEvents: "none",
};

type Layout = { fit: TabFit; widths: TabWidths; look: TabLook };

function sameLayout(a: Layout | null, b: Layout | null): boolean {
  if (a === null || b === null) return a === b;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return (
    a.look === b.look &&
    a.fit.count === b.fit.count &&
    near(a.fit.moreRoom, b.fit.moreRoom) &&
    near(a.widths.room, b.widths.room) &&
    a.widths.tabs.length === b.widths.tabs.length &&
    a.widths.tabs.every((t, i) => near(t.more, b.widths.tabs[i]!.more))
  );
}

/** The side panel's box inside its border and padding, which hold the safe areas, in its own px. More's menu and the split's "Panel below" keep inside it. */
export function innerBox(el: HTMLElement, zoom: number): Rect {
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string) => Number.parseFloat(v) || 0;
  return {
    left: r.left / zoom + px(cs.borderLeftWidth) + px(cs.paddingLeft),
    top: r.top / zoom + px(cs.borderTopWidth) + px(cs.paddingTop),
    right: r.right / zoom - px(cs.borderRightWidth) - px(cs.paddingRight),
    bottom: r.bottom / zoom - px(cs.borderBottomWidth) - px(cs.paddingBottom),
  };
}

export function SideTabs(props: {
  hidden: boolean;
  zoom: number;
  tabs: PanelDef[];
  tab: string;
  badges: Record<string, number>;
  /** What a panel's count says to a screen reader where it is not "N unread", such as the DM panel's "1 upload waiting". */
  badgeLabels: Record<string, string>;
  /** A DM's menu groups its panels under In play and Prepare, as the phone's list does. */
  grouped: boolean;
  onTab(id: string): void;
  onHide(): void;
  /**
   * Two panels (docs/design-v1-split-panel.md 6): whether the split is on,
   * whether the side panel holds two, and the bottom panel while it shows,
   * whose tab or More item carries its mark and swaps the two when pressed.
   */
  split: { on: boolean; fits: boolean | null; below: string | null; onToggle(): void };
  /**
   * The chosen panel's full name while the row does not show it on a touch
   * pointer, its tab an icon alone or More's name cut (3.8,
   * docs/design-v1-icons-2.md 3.1), else null, for the side panel to name above the top panel, where it takes
   * room from that panel alone and never from the split.
   */
  onCutTitle(title: string | null): void;
  /** The chosen tab, More while the open panel is in it. */
  tabRef: RefObject<HTMLButtonElement | null>;
  /**
   * Called before paint once a new fit's tabs are drawn. The fit commits in
   * this component alone, so Room's request to focus the chosen tab, made
   * while there were no tabs to focus, is answered here.
   */
  onTabsDrawn(): void;
  tabId(id: string): string;
  panelId: string;
}) {
  const { tabs, tab, tabRef } = props;
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const describedId = useId();
  const belowDescribedId = useId();
  const below = props.split.below;
  const [layout, setLayout] = useState<Layout | null>(null);
  const latest = useRef({ tabs, zoom: props.zoom });
  latest.current = { tabs, zoom: props.zoom };
  /** A focused tab went into More with the last fit, so focus moves to More once it is drawn. */
  const focusMore = useRef(false);

  const menu = usePopover({ kind: "menu", fallbackFocus: () => tabRef.current });

  /*
   * Measures and fits. Widths come from bounding boxes in the same zoomed
   * side panel, divided by its zoom, so the gaps and the cap, in its own
   * px, apply at any interface size. The tab list's width never depends on
   * what it holds (flex: 1 1 auto, min-width: 0), so the fit never reads
   * anything it changes.
   */
  const refit = useCallback(() => {
    const list = listRef.current;
    const row = measureRef.current;
    const { tabs: panels, zoom } = latest.current;
    let next: Layout | null = null;
    if (list && row) {
      const width = (el: Element | null) => (el ? el.getBoundingClientRect().width / zoom : 0);
      const rest = [...row.querySelectorAll("[data-rest]")].map(width);
      const named = [...row.querySelectorAll("[data-named]")].map(width);
      const more = [...row.querySelectorAll("[data-more]")].map(width);
      const moreRest = width(row.querySelector("[data-more-rest]"));
      const room = width(list);
      const tabsOf = (at: number[]) => panels.map((p, i) => ({ rest: at[i] ?? 0, more: more[i] ?? 0, group: p.group }));
      // Each panel's icon before its name where the row then holds as many tabs as the names alone, else the icons alone (docs/design-v1-icons-2.md 3.1).
      const withNames: TabWidths = { tabs: tabsOf(named), moreRest, room };
      const look = pickLook({ tabs: tabsOf(rest), moreRest, room }, withNames);
      const widths = look ? widthsFor(look, withNames) : withNames;
      const fit = look ? fitTabs(widths) : null;
      next = fit && look ? { fit, widths, look } : null;
    }
    setLayout((was) => {
      if (sameLayout(was, next)) return was;
      const active = document.activeElement;
      const at = active instanceof HTMLElement && list?.contains(active) ? Number(active.dataset.index ?? "-1") : -1;
      if (next && at >= next.fit.count) focusMore.current = true;
      return next;
    });
  }, []);

  // Before the first paint, as the side panel shows and when the role's panels change: until then it draws no tabs.
  const panelsKey = tabs.map((p) => p.id).join(" ");
  useLayoutEffect(refit, [refit, props.hidden, panelsKey, props.zoom]);

  // A resize, a rotation that changes the safe area, a new interface size, or a font that changes size. Committed at once, so no frame paints the old fit.
  useEffect(() => {
    const observer = new ResizeObserver(() => flushSync(refit));
    if (listRef.current) observer.observe(listRef.current);
    const inner = measureRef.current?.firstElementChild;
    if (inner) observer.observe(inner);
    return () => observer.disconnect();
  }, [refit]);

  const fit = layout?.fit ?? null;
  const count = fit ? fit.count : 0;
  const row = fit ? tabs.slice(0, count) : [];
  const held = fit ? tabs.slice(count) : [];
  const chosenHeld = held.find((p) => p.id === tab);
  const stops = [...row.map((p) => p.id), ...(held.length > 0 ? [MORE] : [])];
  const stop = chosenHeld ? MORE : row.some((p) => p.id === tab) ? tab : stops[0];

  // The menu closes as the fit changes: a resize or a rotation that moves a tab, or that changes More's room.
  const lastFit = useRef<TabFit | null>(null);
  useLayoutEffect(() => {
    const was = lastFit.current;
    lastFit.current = fit;
    if (was && (!fit || was.count !== fit.count || Math.abs(was.moreRoom - fit.moreRoom) >= 0.5)) menu.close("state");
    if (focusMore.current) {
      focusMore.current = false;
      moreRef.current?.focus({ preventScroll: true });
    }
  });

  // The chosen tab is More while the open panel is in it, for Room's focus after Details, Panels and the turn strip, and Back's fallback.
  useLayoutEffect(() => {
    if (chosenHeld && moreRef.current) tabRef.current = moreRef.current;
  });
  const onTabsDrawn = useRef(props.onTabsDrawn);
  onTabsDrawn.current = props.onTabsDrawn;
  useLayoutEffect(() => {
    if (layout) onTabsDrawn.current();
  }, [layout]);

  const anchorRef = menu.anchorProps.ref;
  const moreRefs = useCallback(
    (el: HTMLButtonElement | null) => {
      // More leaves the row as the side panel hides or the fit holds every tab: a chosen tab it stood for is gone with it, so Room waits for the next.
      if (el === null && tabRef.current !== null && tabRef.current === moreRef.current) tabRef.current = null;
      moreRef.current = el;
      anchorRef(el);
    },
    [anchorRef, tabRef],
  );

  /*
   * The ARIA tab pattern over the row and More: one Tab stop, the chosen
   * tab. Left, Right, Home and End move along the row and choose as focus
   * reaches a tab. More takes focus and chooses nothing, so the keys never
   * open a menu or a panel that was only passed over. Its own keys are a
   * menu button's (components/Popover.tsx), and they mark what they use.
   * The map's arrow shortcuts stand aside on a tab list and in a menu
   * (state/shortcuts.ts ownsNavigationKeys).
   */
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const at = stops.indexOf((e.target as HTMLElement).dataset.stop ?? "");
    const index = at === -1 ? null : tabKeyIndex(e.key, at, stops.length);
    const next = index === null ? undefined : stops[index];
    if (next === undefined) return;
    e.preventDefault();
    if (next === MORE) {
      moreRef.current?.focus();
      return;
    }
    // The bottom panel's tab takes focus and chooses nothing, as More does, so passing over it never changes the panes.
    if (next !== below) props.onTab(next);
    document.getElementById(props.tabId(next))?.focus();
  };

  const heldCount = held.reduce((sum, p) => sum + (props.badges[p.id] ?? 0), 0);
  // A count with a label of its own is said by it, as the phone's Panels button says "2 unread, 1 upload waiting".
  const heldUnread = held.reduce((sum, p) => sum + (props.badgeLabels[p.id] ? 0 : (props.badges[p.id] ?? 0)), 0);
  const heldLabels = held.flatMap((p) => {
    const label = props.badgeLabels[p.id];
    return label && (props.badges[p.id] ?? 0) > 0 ? [label] : [];
  });
  const description = [chosenHeld ? "More panels" : null, heldUnread > 0 ? `${heldUnread} unread` : null, ...heldLabels].filter((s) => s !== null).join(", ");
  // "Two panels" heads the menu, then a line, then the panels (docs/design-v1-split-panel.md 4.1, 6).
  const split = props.split;
  const tooShort = split.fits === false;
  const splitItem: MenuItem = {
    id: SPLIT_ITEM,
    title: "Two panels",
    kind: "checkbox",
    checked: split.on,
    glyph: <Icon name="splitPanel" size="sm" />,
    ...(split.on
      ? tooShort
        ? { description: "Too short for two now. They come back when the side panel is taller." }
        : null
      : tooShort
        ? { disabled: true, note: "too short", description: "The side panel is too short for two panels." }
        : null),
  };
  const sections: MenuSection[] = [
    { key: "split", items: [splitItem] },
    ...panelSections(held, props.grouped).map((s, i) => ({
      key: s.key,
      ...(s.label ? { heading: s.label } : null),
      separator: s.line || i === 0,
      items: s.panels.map((p) => {
        const n = props.badges[p.id] ?? 0;
        return {
          id: p.id,
          title: p.title,
          glyph: <Icon name={p.icon} size="sm" />,
          checked: p.id === tab,
          ...(p.id === below ? { note: "below", description: "Shown below" } : null),
          ...(n > 0 ? { badge: <Badge count={n} label={props.badgeLabels[p.id]} /> } : null),
        };
      }),
    })),
  ];
  const pick = (id: string) => (id === SPLIT_ITEM ? split.onToggle() : props.onTab(id));
  const chosenIndex = tabs.findIndex((p) => p.id === tab);
  // More draws a held panel's icon alone where its name would be cut.
  const moreCut = layout !== null && chosenHeld !== undefined && nameCut(layout.fit, layout.widths, chosenIndex);
  // On a touch pointer, wherever the row does not show the open panel's name, the side panel names it above the panel (docs/design-v1-panel-tabs.md 3.8 as docs/design-v1-icons-2.md 3.1 amends it): an icon-only tab, or More's icon alone. A computer shows the name on hover and focus instead and keeps the panel's height.
  const chosenPanel = tabs[chosenIndex];
  const named = layout !== null && chosenPanel !== undefined && headerNamesOpen(layout.look, chosenHeld !== undefined, moreCut, isCoarsePointer());
  const cutTitle = named ? chosenPanel.title : null;
  // More with its icon alone shows the held panel's name as every icon-only tab does, on hover, keyboard focus and a long press (docs/design-v1-icons-2.md 6).
  const moreTip = useTooltip(chosenHeld?.title ?? "More panels");
  // Where the icon tabs' tooltips stand: after the tab list, which may own only tabs (review ICONS2B-OPUS-05). A tip is a popover, so where it stands in the page moves nothing on screen.
  const [tipHost, setTipHost] = useState<HTMLDivElement | null>(null);
  // Before paint, so the name and the panel under it draw in one frame.
  const onCutTitle = useRef(props.onCutTitle);
  onCutTitle.current = props.onCutTitle;
  useLayoutEffect(() => onCutTitle.current(cutTitle), [cutTitle]);

  return (
    <>
      {/* The tab list, More's menu right after it in the page, so Tab from the menu goes on to Hide panels, and Hide panels outside the list. */}
      <div style={{ position: "relative", ...headerRow(true) }}>
        <div ref={listRef} role="tablist" aria-label="Panels" onKeyDown={onTabKey} style={{ flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: TAB_GAP }}>
          {row.map((p, i) => {
            const chosen = p.id === tab;
            const marked = p.id === below;
            const opensGroup = i > 0 && row[i - 1]?.group !== p.group;
            const look = tabLook(chosen);
            return (
              <PanelTab
                key={p.id}
                panel={p}
                alone={layout?.look === "icon"}
                tabRef={chosen ? tabRef : undefined}
                id={props.tabId(p.id)}
                chosen={chosen}
                controls={chosen ? props.panelId : undefined}
                describedBy={marked ? belowDescribedId : undefined}
                tipHost={tipHost}
                stop={p.id === stop}
                index={i}
                onClick={() => props.onTab(p.id)}
                style={{ marginLeft: opensGroup ? GROUP_GAP - TAB_GAP : 0, ...look.button }}
              >
                <Pill look={look.pill}>
                  <Badge count={props.badges[p.id] ?? 0} corner label={props.badgeLabels[p.id]} />
                  {marked ? <span aria-hidden data-below-mark="" style={BELOW_MARK} /> : null}
                </Pill>
              </PanelTab>
            );
          })}
          {fit && held.length > 0 ? (
            <button
              ref={moreRefs}
              // While it names the open panel it labels the tab panel, as that panel's tab would.
              id={chosenHeld ? props.tabId(chosenHeld.id) : props.tabId("more")}
              type="button"
              role="tab"
              aria-selected={chosenHeld !== undefined}
              aria-haspopup="menu"
              aria-expanded={menu.open}
              aria-controls={menu.open ? menu.contentId : chosenHeld ? props.panelId : undefined}
              tabIndex={stop === MORE ? 0 : -1}
              data-active={chosenHeld !== undefined}
              data-stop={MORE}
              {...PILL_FOCUS}
              {...(moreCut ? moreTip.anchor({ "aria-describedby": description ? describedId : undefined }) : { "aria-describedby": description ? describedId : undefined })}
              onClick={menu.onAnchorClick}
              onKeyDown={menu.onAnchorKeyDown}
              style={{ ...TAB_BOX, ...PILL_HOST, flex: "0 1 auto", maxWidth: fit.moreRoom, ...tabLook(chosenHeld !== undefined).button, cursor: "pointer" }}
            >
              {/* The held panel's icon before its name, or alone where its name would be cut, so More never cuts a word: the side panel then names the panel above it (3.8). Its name keeps the whole title. */}
              {chosenHeld ? <Icon name={chosenHeld.icon} size="sm" style={NAMED_ICON} /> : null}
              <span style={moreCut ? VISUALLY_HIDDEN : { minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
                {chosenHeld ? (
                  chosenHeld.title
                ) : (
                  <>
                    More<span style={VISUALLY_HIDDEN}> panels</span>
                  </>
                )}
              </span>
              {/* The icon set has one chevron for down and up, turned while the menu is open. */}
              <Icon name="chevronDown" size="sm" style={menu.open ? { transform: "rotate(180deg)" } : undefined} />
              <Pill look={tabLook(chosenHeld !== undefined).pill}>
                <Badge count={heldCount} corner spoken={false} />
              </Pill>
            </button>
          ) : null}
        </div>
        {moreCut ? moreTip.tip : null}
        <div ref={setTipHost} style={{ display: "contents" }} />
        <Popover handle={menu} side="below" bound={() => innerBox(listRef.current?.closest("aside") ?? document.body, latest.current.zoom)}>
          <Menu label="More panels" sections={sections} onPick={pick} data={{ "data-tabs-menu": "" }} />
        </Popover>
        <HideButton label="Hide panels" onClick={props.onHide} style={{ flex: "none" }} />
        {/* More's description, outside it so it is no part of its name or its text, and hidden, as only a screen reader reads it. */}
        {description ? (
          <span id={describedId} hidden>
            {description}
          </span>
        ) : null}
        <span id={belowDescribedId} hidden>
          Shown below
        </span>
        {/* Every title in the tab look and in More's, measured where they draw: hidden spans with no role, taking no room. */}
        <div ref={measureRef} aria-hidden style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, overflow: "hidden", visibility: "hidden", pointerEvents: "none" }}>
          <div style={{ display: "flex", width: "max-content" }}>
            {tabs.map((p) => (
              <span key={`rest-${p.id}`} data-rest="" style={{ ...TAB_BOX, flex: "none" }}>
                {p.title}
              </span>
            ))}
            {tabs.map((p) => (
              <span key={`named-${p.id}`} data-named="" style={{ ...TAB_BOX, flex: "none" }}>
                <Icon name={p.icon} size="sm" style={NAMED_ICON} />
                {p.title}
              </span>
            ))}
            {tabs.map((p) => (
              <span key={`more-${p.id}`} data-more="" style={{ ...TAB_BOX, flex: "none" }}>
                <Icon name={p.icon} size="sm" style={NAMED_ICON} />
                <span>{p.title}</span>
                <Icon name="chevronDown" size="sm" />
              </span>
            ))}
            <span data-more-rest="" style={{ ...TAB_BOX, flex: "none" }}>
              <span>More</span>
              <Icon name="chevronDown" size="sm" />
            </span>
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * One panel's tab: its icon before its name, or its icon alone where the
 * row is too narrow for both (docs/design-v1-icons-2.md 3.1). Alone, its
 * name is a visually hidden title, never an `aria-label`, so the badge's
 * hidden words stay in it ("Log 2 unread", docs/design-v1-panel-tabs.md
 * 3.5), and shows on hover, keyboard focus and a long press, as every
 * icon-only control's does (docs/design-v1-icons.md 3.2).
 * Either way the box is the measured one, so the fit holds what it drew.
 */
export function PanelTab(props: {
  panel: PanelDef;
  alone: boolean;
  tabRef: RefObject<HTMLButtonElement | null> | undefined;
  id: string;
  chosen: boolean;
  controls: string | undefined;
  describedBy: string | undefined;
  /** Where its tooltip stands, outside the tab list, which may own only tabs. */
  tipHost: Element | null;
  stop: boolean;
  index: number;
  onClick(): void;
  style: CSSProperties;
  children: ReactNode;
}) {
  const { panel, alone } = props;
  const tooltip = useTooltip(panel.title);
  return (
    <>
      <button
        ref={props.tabRef}
        id={props.id}
        type="button"
        role="tab"
        aria-selected={props.chosen}
        aria-controls={props.controls}
        tabIndex={props.stop ? 0 : -1}
        data-active={props.chosen}
        data-stop={panel.id}
        data-index={props.index}
        {...PILL_FOCUS}
        {...(alone ? tooltip.anchor({ "aria-describedby": props.describedBy }) : { "aria-describedby": props.describedBy })}
        onClick={props.onClick}
        style={{ ...TAB_BOX, ...PILL_HOST, flex: "none", ...(alone ? { padding: 0 } : null), ...props.style, cursor: "pointer" }}
      >
        <Icon name={panel.icon} size={alone ? "md" : "sm"} style={alone ? undefined : NAMED_ICON} />
        {alone ? <span style={VISUALLY_HIDDEN}>{panel.title}</span> : panel.title}
        {props.children}
      </button>
      {alone && props.tipHost ? createPortal(tooltip.tip, props.tipHost) : null}
    </>
  );
}
