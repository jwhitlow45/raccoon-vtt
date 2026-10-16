import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type RefObject } from "react";
import { flushSync } from "react-dom";
import { Icon } from "../components/Icon.tsx";
import { PRESSED } from "../components/looks.ts";
import { Menu, type MenuSection } from "../components/Menu.tsx";
import { Popover, usePopover, type Rect } from "../components/Popover.tsx";
import { HideButton, SheetHeader } from "../components/SheetHeader.tsx";
import { panelSections, type PanelDef } from "../features/panels.ts";
import { tabKeyIndex, VISUALLY_HIDDEN } from "../lib/a11y.ts";
import { theme } from "../lib/theme.ts";
import { Badge } from "./RoomChrome.tsx";
import { fitTabs, GROUP_GAP, nameCut, TAB_GAP, type TabFit, type TabWidths } from "./tabFit.ts";

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

/** A side panel tab at rest. The chosen one takes the pressed look, as every other chosen option (docs/design-v1-visual.md 3.2), with the same 1 px border, so choosing never changes a width. */
const TAB_REST: CSSProperties = { background: "transparent", border: `${theme.line.border}px solid transparent`, color: theme.color.textMuted };

/** More's place among the row's stops for the tab keys. */
const MORE = "\u0000more";

type Layout = { fit: TabFit; widths: TabWidths };

function sameLayout(a: Layout | null, b: Layout | null): boolean {
  if (a === null || b === null) return a === b;
  const near = (x: number, y: number) => Math.abs(x - y) < 0.5;
  return (
    a.fit.count === b.fit.count &&
    near(a.fit.moreRoom, b.fit.moreRoom) &&
    near(a.widths.room, b.widths.room) &&
    a.widths.tabs.length === b.widths.tabs.length &&
    a.widths.tabs.every((t, i) => near(t.more, b.widths.tabs[i]!.more))
  );
}

/** The side panel's box inside its border and padding, which hold the safe areas, in its own px. */
function innerBox(el: HTMLElement, zoom: number): Rect {
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
  /** Whether the side panel draws a subpage's header, which names the panel in full in its Back. */
  subpage: boolean;
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
      const more = [...row.querySelectorAll("[data-more]")].map(width);
      const widths: TabWidths = {
        tabs: panels.map((p, i) => ({ rest: rest[i] ?? 0, more: more[i] ?? 0, group: p.group })),
        moreRest: width(row.querySelector("[data-more-rest]")),
        room: width(list),
      };
      const fit = fitTabs(widths);
      next = fit ? { fit, widths } : null;
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
    props.onTab(next);
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
  const sections: MenuSection[] = panelSections(held, props.grouped).map((s) => ({
    key: s.key,
    ...(s.label ? { heading: s.label } : null),
    separator: s.line,
    items: s.panels.map((p) => {
      const n = props.badges[p.id] ?? 0;
      return { id: p.id, title: p.title, checked: p.id === tab, ...(n > 0 ? { badge: <Badge count={n} label={props.badgeLabels[p.id]} /> } : null) };
    }),
  }));
  const chosenIndex = tabs.findIndex((p) => p.id === tab);
  const cutTitle = layout && chosenHeld && nameCut(layout.fit, layout.widths, chosenIndex) ? chosenHeld.title : null;

  return (
    <>
      {/* The tab list, More's menu right after it in the page, so Tab from the menu goes on to Hide panels, and Hide panels outside the list. */}
      <div style={{ position: "relative", display: "flex", alignItems: "flex-start", gap: theme.space(1), padding: theme.space(2), borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
        <div ref={listRef} role="tablist" aria-label="Panels" onKeyDown={onTabKey} style={{ flex: "1 1 auto", minWidth: 0, display: "flex", alignItems: "center", gap: TAB_GAP }}>
          {row.map((p, i) => {
            const chosen = p.id === tab;
            const opensGroup = i > 0 && row[i - 1]?.group !== p.group;
            return (
              <button
                key={p.id}
                ref={chosen ? tabRef : undefined}
                id={props.tabId(p.id)}
                type="button"
                role="tab"
                aria-selected={chosen}
                aria-controls={chosen ? props.panelId : undefined}
                tabIndex={p.id === stop ? 0 : -1}
                data-active={chosen}
                data-stop={p.id}
                data-index={i}
                onClick={() => props.onTab(p.id)}
                style={{ ...TAB_BOX, position: "relative", flex: "none", marginLeft: opensGroup ? GROUP_GAP - TAB_GAP : 0, ...(chosen ? PRESSED : TAB_REST), cursor: "pointer" }}
              >
                {p.title}
                <Badge count={props.badges[p.id] ?? 0} corner label={props.badgeLabels[p.id]} />
              </button>
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
              aria-describedby={description ? describedId : undefined}
              tabIndex={stop === MORE ? 0 : -1}
              data-active={chosenHeld !== undefined}
              data-stop={MORE}
              onClick={menu.onAnchorClick}
              onKeyDown={menu.onAnchorKeyDown}
              style={{ ...TAB_BOX, position: "relative", flex: "0 1 auto", maxWidth: fit.moreRoom, ...(chosenHeld ? PRESSED : TAB_REST), cursor: "pointer" }}
            >
              {/* The title cuts in its own span, so the corner badge never does. Its name keeps the whole title. */}
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
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
              <Badge count={heldCount} corner spoken={false} />
            </button>
          ) : null}
        </div>
        <Popover handle={menu} side="below" bound={() => innerBox(listRef.current?.closest("aside") ?? document.body, latest.current.zoom)}>
          <Menu label="More panels" sections={sections} onPick={props.onTab} data={{ "data-tabs-menu": "" }} />
        </Popover>
        <HideButton label="Hide panels" onClick={props.onHide} style={{ flex: "none" }} />
        {/* More's description, outside it so it is no part of its name or its text, and hidden, as only a screen reader reads it. */}
        {description ? (
          <span id={describedId} hidden>
            {description}
          </span>
        ) : null}
        {/* Every title in the tab look and in More's, measured where they draw: hidden spans with no role, taking no room. */}
        <div ref={measureRef} aria-hidden style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, overflow: "hidden", visibility: "hidden", pointerEvents: "none" }}>
          <div style={{ display: "flex", width: "max-content" }}>
            {tabs.map((p) => (
              <span key={`rest-${p.id}`} data-rest="" style={{ ...TAB_BOX, flex: "none" }}>
                {p.title}
              </span>
            ))}
            {tabs.map((p) => (
              <span key={`more-${p.id}`} data-more="" style={{ ...TAB_BOX, flex: "none" }}>
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
      {/* A name More cuts is named in full above the panel (3.8). A subpage's header names it in its Back instead. */}
      {cutTitle && !props.subpage ? (
        <div style={{ flex: "none", borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
          <SheetHeader title={cutTitle} />
        </div>
      ) : null}
    </>
  );
}
