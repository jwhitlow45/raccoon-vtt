import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { RoomState } from "#shared/model.ts";
import { Chip, ChipRow } from "../../components/Chip.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Tag } from "../../components/Tag.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomScope } from "../../state/scope.ts";
import { outlinerSearchSlot } from "../../state/shortcuts.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { useLayoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import type { PanelProps } from "../panels.ts";
import { focusOutlineRow } from "./focus.ts";
import { filterRows, GROUPS, listItems, outlineRows, ROW_PX, windowRange, type ListItem, type OutlineGroup, type OutlineRow } from "./rows.ts";

/**
 * The scene outliner (docs/design-v1-dm-tools.md 3.2): a searchable list of
 * everything on the scene in view, for the DM, with what players get of
 * each, and a tap that frames the item and picks it.
 *
 * A scene at its limits holds about 5,000 rows, so the list is windowed at
 * a fixed height a line (rows.ts ROW_PX, a Row's 56 px with its detail line)
 * inside whatever scrolls the panel (a phone's sheet, the side panel), and
 * the search index is rebuilt only when the view's collections change.
 */
export default function OutlinerPanel(props: PanelProps) {
  const role = useRoomView((s) => s.you?.role);
  const sceneId = useRoomView((s) => s.sceneId);
  if (role !== "dm") return <Empty>Only the DM has the outliner.</Empty>;
  if (!sceneId) return <Empty>There is no scene to list yet. Make one in Scenes.</Empty>;
  return <Outliner sceneId={sceneId} close={props.close} shown={props.shown} />;
}

/** The parts of the view the rows read. Each keeps its identity until it changes, so the rows are made again only then. */
function useScenePieces(): RoomState | null {
  const view = useRoomView((s) => s.view);
  const pieces = [
    view?.tokens,
    view?.stamps,
    view?.labels,
    view?.pins,
    view?.lights,
    view?.templates,
    view?.drawings,
    view?.buildChunks,
    view?.fogTiles,
    view?.exploredTiles,
    view?.journal,
    view?.members,
    view?.scenes,
    view?.meta,
    view?.characters,
    (view as { sight?: unknown } | null)?.sight,
  ];
  // The view itself changes with any op, a log line included, so only these pieces decide when the rows are made again.
  return useMemo(() => view, pieces);
}

function Outliner(props: { sceneId: string; close(): void; shown: boolean }) {
  const view = useScenePieces();
  const scope = useRoomScope();
  const ui = useRoomUi();
  const actions = useRoomActions();
  const wide = useLayoutSize().width >= theme.layout.wideMinWidth;
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<OutlineGroup | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<OutlineGroup>>(new Set());
  const searchRef = useRef<HTMLInputElement>(null);

  /*
   * `/` opens the outliner with its search focused (state/shortcuts.ts),
   * whether it was open already or not. A hidden pane cannot take focus, and
   * the outliner may be in one as `/` is pressed: the side panel hidden, or
   * the bottom of two panels in a side panel too short for both. So the
   * shortcut's call only marks the request, and the search takes it in an
   * effect once the panel shows (docs/design-v1-split-panel.md 9.2).
   */
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const slot = scope.get(outlinerSearchSlot);
    const mark = () => setAsked((n) => n + 1);
    slot.listeners.add(mark);
    return () => {
      slot.listeners.delete(mark);
    };
  }, [scope]);
  useEffect(() => {
    const slot = scope.get(outlinerSearchSlot);
    if (!props.shown || !slot.focusNext) return;
    slot.focusNext = false;
    searchRef.current?.focus();
    searchRef.current?.select();
  }, [scope, props.shown, asked]);

  const rows = useMemo(() => (view ? outlineRows(view, props.sceneId) : []), [view, props.sceneId]);
  const shown = useMemo(() => filterRows(rows, query, group), [rows, query, group]);
  // A search shows every match, folded groups included.
  const items = useMemo(() => listItems(shown, query.trim() ? new Set() : folded), [shown, query, folded]);
  const counts = useMemo(() => {
    const m = new Map<OutlineGroup, number>();
    for (const r of filterRows(rows, query, null)) m.set(r.group, (m.get(r.group) ?? 0) + 1);
    return m;
  }, [rows, query]);

  const pick = (row: OutlineRow) => {
    // On a phone the sheet closes first, so the item is not under it.
    if (!wide) props.close();
    focusOutlineRow(row, { scope, ui, actions, sceneId: props.sceneId });
  };
  const toggle = (g: OutlineGroup) =>
    setFolded((prev) => {
      const next = new Set(prev);
      if (next.has(g)) next.delete(g);
      else next.add(g);
      return next;
    });

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <Input
        ref={searchRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search the scene"
        aria-label="Search the scene"
        autoComplete="off"
        spellCheck={false}
        style={{ width: "100%" }}
      />
      <ChipRow label="Show one group">
        <Chip count={rows.length === 0 ? null : filterRows(rows, query, null).length} pressed={group === null} onClick={() => setGroup(null)}>
          All
        </Chip>
        {GROUPS.map((g) => (
          <Chip key={g.id} count={counts.get(g.id) ?? 0} pressed={group === g.id} onClick={() => setGroup(group === g.id ? null : g.id)}>
            {g.chip}
          </Chip>
        ))}
      </ChipRow>
      {rows.length === 0 ? (
        <Empty>Nothing on this scene yet. Tokens, labels, pins, lights, doors and drawings list here as you add them.</Empty>
      ) : items.length === 0 ? (
        <Empty>Nothing matches “{query.trim()}”.</Empty>
      ) : (
        <WindowedList items={items} onPick={pick} onToggle={toggle} />
      )}
    </div>
  );
}

/** The nearest ancestor that scrolls, whose view the window follows. */
function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if (overflow === "auto" || overflow === "scroll") return p;
  }
  return null;
}

/** The lines in view of the panel's own scrolling, kept up to date as it scrolls or resizes. */
function useWindow(listRef: RefObject<HTMLElement | null>, count: number): { start: number; end: number } {
  const [range, setRange] = useState(() => ({ start: 0, end: Math.min(count, 40) }));
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const scroller = scrollParent(list);
    const update = () => {
      // Rectangles are drawn pixels, which the interface size multiplies (features/device/layout.ts). Lines are the panel's own.
      const zoom = uiScale();
      const top = scroller ? scroller.getBoundingClientRect().top : 0;
      const listTop = (list.getBoundingClientRect().top - top) / zoom;
      const viewHeight = scroller ? scroller.clientHeight : window.innerHeight / zoom;
      const next = windowRange({ listTop, viewHeight, count });
      setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
    };
    update();
    const target = scroller ?? window;
    target.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    if (scroller) observer.observe(scroller);
    return () => {
      target.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [listRef, count]);
  return range;
}

/**
 * The windowed lines, each in a `listitem` of its own that holds its
 * place, around a button that keeps its button role: a group's header,
 * which folds its group, or a row, which shows its item on the map. With
 * `role="listitem"` on the row's own button, a screen reader heard a list
 * item and never a button to press.
 */
export function WindowedList(props: { items: ListItem[]; onPick(row: OutlineRow): void; onToggle(group: OutlineGroup): void }) {
  const listRef = useRef<HTMLDivElement>(null);
  const { start, end } = useWindow(listRef, props.items.length);
  return (
    <div ref={listRef} role="list" aria-label="Everything on the scene" style={{ position: "relative", height: props.items.length * ROW_PX }}>
      {props.items.slice(start, end).map((item, i) => {
        const top = (start + i) * ROW_PX;
        return item.kind === "header" ? (
          <div key={`h:${item.group}`} role="listitem" style={slot(top)}>
            <button
              type="button"
              aria-expanded={!item.folded}
              onClick={() => props.onToggle(item.group)}
              style={{ ...LINE, justifyContent: "flex-start", gap: theme.space(2), background: "transparent", border: "none", borderBottom: `${theme.line.border}px solid ${theme.color.border}`, color: theme.color.text }}
            >
              <span style={{ flex: "none", color: theme.color.textMuted }}>
                <Icon name={item.folded ? "chevronRight" : "chevronDown"} />
              </span>
              <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold }}>{item.title}</span>
              <span style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>{item.count}</span>
            </button>
          </div>
        ) : (
          <div key={item.row.key} role="listitem" style={slot(top)}>
            <button
              type="button"
              onClick={() => props.onPick(item.row)}
              title={`Show ${item.row.name} on the map`}
              style={{ ...LINE, gap: theme.space(3), background: "transparent", border: "none", color: theme.color.text, paddingLeft: theme.space(8) }}
            >
              <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5), textAlign: "left", lineHeight: theme.leading.tight }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: theme.font.input, fontWeight: theme.weight.strong }}>{item.row.name}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: theme.font.small, color: theme.color.textMuted }}>{item.row.detail}</span>
              </span>
              {item.row.mark ? <Mark text={item.row.mark} /> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

/** Where a line sits in the windowed list. */
function slot(top: number) {
  return { position: "absolute" as const, top, left: 0, right: 0, height: ROW_PX };
}

/** A line's button, filling its slot. */
const LINE = {
  width: "100%",
  height: "100%",
  display: "flex",
  alignItems: "center",
  padding: `0 ${theme.space(3)}px 0 ${theme.space(1)}px`,
  fontFamily: theme.font.body,
  fontSize: theme.font.body14,
  cursor: "pointer",
  textAlign: "left" as const,
};

/**
 * What players get, as a muted Tag: nothing here is an error, only a fact
 * about the table. A mark can hold a member's name ("Only Pat"), up to 80
 * characters, so its text is cut with an ellipsis before it can crowd out
 * the row's own name. The whole text stays in the row's name and tooltip.
 */
function Mark(props: { text: string }) {
  return (
    <Tag title={props.text}>
      <span style={{ display: "block", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis" }}>{props.text}</span>
    </Tag>
  );
}
