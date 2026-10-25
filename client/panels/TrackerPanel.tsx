import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import type { Token } from "#shared/model.ts";
import { MAX_ENTRIES_PER_OP, type EntryInput } from "#shared/protocol.ts";
import { Button } from "../components/Button.tsx";
import { Empty } from "../components/Empty.tsx";
import { QuickStartLink } from "../features/guide/GuideLink.tsx";
import { Help, Section } from "../components/Panel.tsx";
import { Segmented } from "../components/Segmented.tsx";
import { Switch } from "../components/Switch.tsx";
import { useSoundOn, setSoundOn } from "../features/encounter/alerts.ts";
import { AutoInitiativeControls, AutoInitiativeResult } from "../features/encounter/AutoInitiative.tsx";
import { HpLog } from "../features/encounter/HpLog.tsx";
import { setFollowTurn, useFollowTurn } from "../features/encounter/followTurn.ts";
import { useRowFacts, useSend, useSortedEntries, useTurnTimer, useYou } from "../features/encounter/hooks.ts";
import {
  COMPACT_HEADER_PX,
  addCandidates,
  dropIndex,
  entryBatches,
  entryName,
  hasStarted,
  keepsDragSlot,
  ownCandidates,
  reorderTie,
  roundHeaderForm,
  scoreFills,
  tieRun,
  turnOp,
  turnStatus,
  whoseTurn,
  type AddMode,
  type RoundHeaderForm,
} from "../features/encounter/logic.ts";
import { panAnchor, requestPan } from "../features/encounter/pan.ts";
import { EndTurnPill, TimerClock } from "../features/encounter/parts.tsx";
import { clockText, timerChoices } from "../features/encounter/timer.ts";
import { EntryRow, type RowDrag } from "../features/encounter/Row.tsx";
import { ValueEntry } from "../features/encounter/ValueEntry.tsx";
import { GroupHpEntry } from "../features/tokens/GroupHpEntry.tsx";
import { useFightJoin, type JoinState } from "../features/combat/state.ts";
import { SrdLoadFailed } from "../features/monsters/SrdLoadFailed.tsx";
import type { PanelProps } from "../features/panels.ts";
import { displayName, footprint } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { passingNoticesPx } from "../pages/modalSlot.tsx";
import { useRoomScope } from "../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../state/view.ts";
import { layoutSize } from "../features/device/layout.ts";
import { uiScale } from "../features/device/settings.ts";

/**
 * The initiative tracker (features section 10, design 9.4). Players roll at
 * the table or in D&D Beyond and type the result. The DM types monster rolls
 * too, or lets auto initiative roll them on the DM's own device.
 *
 * The DM builds the fight, enters or rolls monster initiative, settles ties
 * by dragging, and steps turns. Players add their own characters, type
 * their own rolls, see the order as projected for them, and end their own
 * turn. Players' encounter ops scan the whole encounter, so they are never
 * predicted (design 7.4): their buttons spin until the server's event lands.
 */
export default function TrackerPanel(props: PanelProps) {
  const you = useYou();
  const running = useRoomView((s) => !!s.view?.encounter);
  const [editingValues, setEditingValues] = useState(false);
  const dm = you.role === "dm";

  useEffect(() => {
    if (!running) setEditingValues(false);
  }, [running]);

  if (!running) {
    return (
      <Stack>
        <Empty action={dm ? <QuickStartLink /> : undefined}>No fight is running.</Empty>
        {dm ? <StartFight selectedTokenId={props.selectedTokenId} /> : null}
        <SoundSwitch />
      </Stack>
    );
  }

  // Ranked by use (docs/design-v1-combat-flow.md 3.2): the order under its sticky header, then what sets the order up, then the rest.
  return (
    <Stack>
      <RoundSection>{dm && editingValues ? <ValueEntryFromView onDone={() => setEditingValues(false)} /> : <EntryList close={props.close} />}</RoundSection>
      {dm ? <DmSetup selectedTokenId={props.selectedTokenId} editingValues={editingValues} onEditValues={() => setEditingValues(true)} /> : <JoinFight />}
      {editingValues ? null : <SelectedCreatures />}
      {editingValues ? null : (
        <Section label="HP changes" style={COLUMN}>
          <HpLog />
        </Section>
      )}
      {dm ? <DmSettings /> : null}
      <SoundSwitch />
    </Stack>
  );
}

// Columns of minmax(0, 1fr) let long names ellipsize instead of widening the sheet.
const COLUMN: CSSProperties = { gridTemplateColumns: "minmax(0, 1fr)" };

/** The panel's sections, one under another. Each Section spaces itself and draws the line between them. */
function Stack(props: { children: ReactNode }) {
  return <div style={{ display: "grid", ...COLUMN, fontSize: theme.font.body14 }}>{props.children}</div>;
}

function Wrap(props: { children: ReactNode }) {
  return <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>{props.children}</div>;
}

/**
 * A wrapping row's buttons, such as the ways to start or add to a fight,
 * each grow to fill their line, so where they do not fit on one, as in the
 * side panel, the last never stands alone under the others (LP22-ALIGN-6),
 * as the row options' roll reminder does (encounter/Row.tsx).
 */
const GROW: CSSProperties = { flex: "1 1 auto" };

// ---------------------------------------------------------------- turns

/** A full header's height before it is first measured: the sheet's 56 px. */
const FULL_HEADER_GUESS = 56;

/** A standard row's height while the order has none to measure: its 56 px line and two borders, with no gap. */
const STANDARD_ROW_GUESS = 56 + 2 * theme.line.border;

/**
 * The round section: the turn controls as its header, then the order
 * (docs/design-v1-combat-flow.md 3.1). The header sticks to the top of the
 * pane while the order scrolls under it. A sticky box never leaves its
 * parent, so once the order's end scrolls past, the header leaves with it,
 * with no script. The section is a plain block, since a sticky grid item
 * could not move outside its own row.
 *
 * It measures the pane's scroller (`data-pane-body`), the header and the
 * order's standard rows (`data-standard-row`), and picks the header's form
 * by the rule in roundHeaderForm, so a whole standard row always shows
 * under a stuck header. The full header's height is kept from when it last
 * showed full, since the compact one cannot measure it. In the very short
 * sheet, "Your turn" and a toast push the body down for a few seconds,
 * which is when End turn or Next is wanted, so the room they take counts
 * as the body's (pages/modalSlot.tsx passingNoticesPx) and the header
 * keeps its form while they show. The compact row's least width is kept
 * from when it last showed, as the full height is, and measured again
 * whenever its words or buttons change, which resize nothing it observes.
 * While another form shows, a change to them makes the width kept stale,
 * so it is dropped and the compact row tried again, which measures it
 * before the frame paints (FU31 review F2).
 */
function RoundSection(props: { children: ReactNode }) {
  const sectionRef = useRef<HTMLElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<RoundHeaderForm>("full");
  const [headerPx, setHeaderPx] = useState(0);
  const formRef = useRef(form);
  formRef.current = form;
  const fullPx = useRef(0);
  const compactNeed = useRef(0);
  const measureRef = useRef<() => void>(() => {});
  const remeasure = useCallback(() => measureRef.current(), []);
  const contentChanged = useCallback(() => {
    if (formRef.current !== "compact") compactNeed.current = 0;
    measureRef.current();
  }, []);

  useLayoutEffect(() => {
    const header = headerRef.current;
    const list = listRef.current;
    const scroller = sectionRef.current?.closest<HTMLElement>("[data-pane-body]");
    if (!header || !list || !scroller) {
      setForm("static");
      return;
    }
    const measure = () => {
      if (formRef.current !== "compact" && header.offsetHeight > 0) fullPx.current = header.offsetHeight;
      const row = header.firstElementChild instanceof HTMLElement ? header.firstElementChild : null;
      if (formRef.current === "compact" && row) compactNeed.current = compactNeedPx(row);
      const next = roundHeaderForm({
        scroller: scroller.clientHeight + passingNoticesPx(scroller),
        fullHeader: fullPx.current || FULL_HEADER_GUESS,
        // The compact form's bottom padding is 0, so its height follows from the pane's top padding it takes back.
        compactHeader: (parseFloat(getComputedStyle(header).paddingTop) || 0) + COMPACT_HEADER_PX + theme.line.border,
        row: standardRowPx(list),
        width: row?.offsetWidth ?? 0,
        compactNeed: compactNeed.current,
      });
      formRef.current = next;
      setForm(next);
      setHeaderPx(header.offsetHeight);
    };
    // Committed in the observer's callback, before the frame paints, so no frame shows the form the old size picked (W7-FC-1).
    const observer = new ResizeObserver(() => flushSync(measure));
    observer.observe(scroller);
    observer.observe(header);
    // The order's own size changes as rows come, go, open their options or gain companions.
    observer.observe(list);
    measureRef.current = measure;
    measure();
    return () => {
      observer.disconnect();
      measureRef.current = () => {};
    };
  }, []);

  const sticks = form !== "static";
  return (
    <section
      ref={sectionRef}
      data-round-section=""
      style={{ display: "block", paddingBottom: theme.space(4), ["--round-header-h" as string]: `${sticks ? headerPx : 0}px` }}
    >
      <div
        ref={headerRef}
        data-round-header=""
        data-form={form}
        style={{
          // The pane's padding taken back by the margin and given back as padding, so at rest the header sits where it
          // always did, and stuck its opaque fill meets the scroller's top and sides with no row showing past it.
          margin: `calc(-1 * ${PAD_TOP}) calc(-1 * ${PAD_X}) ${theme.space(2)}px`,
          padding: `${PAD_TOP} ${PAD_X} ${form === "compact" ? 0 : theme.space(2) - theme.line.border}px`,
          background: theme.color.surface,
          borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
          ...(sticks ? { position: "sticky", top: `calc(-1 * ${PAD_TOP})`, zIndex: theme.z.stickyHeader } : null),
        }}
      >
        <TurnControls compact={form === "compact"} onCompactShown={remeasure} onContentChange={contentChanged} />
      </div>
      <div ref={listRef} style={{ display: "grid", ...COLUMN, gap: theme.space(2) }}>
        {props.children}
      </div>
    </section>
  );
}

/**
 * The least width the compact row needs for "Round N" and its clock whole:
 * its width now, less the room its heading leaves after them, or with what
 * the heading cuts of them, in layout px. The rects are in the page's
 * pixels, which an interface size other than 100% scales and offsetWidth
 * does not.
 */
function compactNeedPx(row: HTMLElement): number {
  const heading = row.querySelector<HTMLElement>("[data-compact-heading]");
  const words = heading ? Array.from(heading.querySelectorAll<HTMLElement>("[data-round-words], [role='timer']")) : [];
  if (!heading || words.length === 0 || row.offsetWidth === 0) return 0;
  const scale = row.getBoundingClientRect().width / row.offsetWidth;
  const cut = Math.max(...words.map((w) => w.getBoundingClientRect().right)) - heading.getBoundingClientRect().right;
  return row.offsetWidth + cut / scale;
}

/** The shortest standard row in the order with the gap after it, or a row's usual height while there is none. */
function standardRowPx(list: HTMLElement): number {
  const rows = Array.from(list.querySelectorAll<HTMLElement>("[data-standard-row]"), (row) => row.offsetHeight).filter((px) => px > 0);
  if (rows.length === 0) return STANDARD_ROW_GUESS;
  const order = list.querySelector<HTMLElement>("[data-standard-row]")!.parentElement;
  const gap = order ? parseFloat(getComputedStyle(order).rowGap) || 0 : 0;
  return Math.min(...rows) + gap;
}

/** The scrolling pane's padding, which its body publishes (components/Sheet.tsx paneBodyPadding). 0 outside a pane. */
const PAD_TOP = "var(--pane-pad-top, 0px)";
const PAD_X = "var(--pane-pad-x, 0px)";

function TurnControls(props: { compact: boolean; onCompactShown(): void; onContentChange(): void }) {
  const you = useYou();
  const actions = useRoomActions();
  const store = useRoomStore();
  const round = useRoomView((s) => s.view?.encounter?.round ?? 1);
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const started = useRoomView((s) => (s.view?.encounter ? hasStarted(s.view.encounter) : false));
  const canGoBack = useRoomView((s) => (s.view?.encounterHistory.length ?? 0) > 0);
  const entries = useSortedEntries();
  const facts = useRowFacts();
  const endTurn = useSend();
  const timer = useTurnTimer();
  const active = entries.find((e) => e.id === activeEntryId);
  const status = turnStatus({ entries, activeEntryId, mine: facts.mine });

  const line = whoseTurn({ dm: you.role === "dm", started, activeName: active ? entryName(facts.view, active) : null, yours: status === "yours" }).line;
  const ends = you.role === "dm" ? (activeEntryId === null ? "start" : "next") : status === "yours" || endTurn.waiting ? `end ${endTurn.waiting}` : "none";
  // Its figures are all one width, so only its length and whether time is up change the clock's.
  const clock = timer && active ? `${timer.over} ${clockText(timer).length}` : "none";
  const { compact, onCompactShown, onContentChange } = props;
  useLayoutEffect(() => {
    if (compact) onCompactShown();
  }, [compact, onCompactShown]);
  // What the compact row needs beside its buttons changes with the round, the clock's words and the buttons, none of which resizes the header (FU30-ROUND-COMPACT).
  // Not keyed on the form, which a change of form it makes would then change again.
  useLayoutEffect(() => onContentChange(), [onContentChange, round, clock, ends]);
  const heading = props.compact ? (
    // One line that ends in an ellipsis on a short panel, never inside the round or its clock (roundHeaderForm). The whole whose-turn text stays in it, so a screen reader reads all of it.
    <div data-compact-heading="" style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
      <span data-round-words="" style={{ fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>Round {round}</span>
      {timer && active ? (
        <>
          {" "}
          <TimerClock state={timer} size={theme.font.body14} icon />
        </>
      ) : null}{" "}
      <span style={{ color: theme.color.textMuted }}>{line}</span>
    </div>
  ) : (
    // Never narrower than "Round N" or its clock, the wider of the two (its least width, as a flex item's is by default), so
    // where the buttons leave it less, they go under the heading rather than over either (ICONS2B-OPUS-06, FU30-OPUS-1).
    <div style={{ flex: 1 }}>
      {/* Beside the DM's Previous and Next, "Time's up +1:05" leaves no room, so the clock goes under the round rather than splitting "Round" from its number. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: theme.space(2) }}>
        <span style={{ fontSize: theme.font.title, fontWeight: theme.weight.bold, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>Round {round}</span>
        {timer && active ? <TimerClock state={timer} size={theme.font.body14} icon /> : null}
      </div>
      {/* No width of its own in the heading's least width, which the round and its clock alone set: it fills the heading and ends in an ellipsis. */}
      <div style={{ width: 0, minWidth: "100%", color: theme.color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{line}</div>
    </div>
  );
  // The compact form stays one line, as the round section's form rule counts it (roundHeaderForm). The full one wraps its buttons under the heading, together and at the end.
  const row: CSSProperties = props.compact
    ? { display: "flex", alignItems: "center", gap: theme.space(2), minHeight: COMPACT_HEADER_PX }
    : { display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) };
  const buttons = (children: ReactNode) => <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), marginInlineStart: "auto" }}>{children}</div>;

  if (you.role === "dm") {
    return (
      <div style={row}>
        {heading}
        {buttons(
          <>
            <Button size="sm" disabled={!canGoBack} onClick={() => actions.dispatch(turnOp("encounter.prev", store.getState()))} aria-label="Previous turn">
              Previous
            </Button>
            <Button size="sm" variant="primary" disabled={entries.length === 0} onClick={() => actions.dispatch(turnOp("encounter.next", store.getState()))}>
              {activeEntryId === null ? "Start" : "Next"}
            </Button>
          </>,
        )}
      </div>
    );
  }

  return (
    <div style={row}>
      {heading}
      {status === "yours" || endTurn.waiting ? buttons(<EndTurnPill waiting={endTurn.waiting} onClick={() => endTurn.send(turnOp("encounter.next", store.getState()))} />) : null}
    </div>
  );
}

// ---------------------------------------------------------------- rows

type DragState = {
  id: string;
  from: number;
  pointerId: number;
  startY: number;
  dy: number;
  /** Row centers in client pixels, measured when the drag began. */
  mids: number[];
  height: number;
  run: { start: number; end: number };
  target: number;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * The order, with drag-to-reorder for ties (design 9.4). Only the handle
 * starts a drag, so scrolling the list never moves a row, and a drag stays
 * inside its tie because the order is value first. Move up and Move down in
 * a row's options do the same without dragging.
 */
function EntryList(props: { close(): void }) {
  const entries = useSortedEntries();
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const selectedIds = useRoomView((s) => s.local.selectedIds);
  const multi = useRoomView((s) => s.local.multi);
  const you = useYou();
  const facts = useRowFacts();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const dm = you.role === "dm";
  const [expanded, setExpanded] = useState<string | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  dragRef.current = drag;
  const rows = useRef(new Map<string, HTMLLIElement>());
  // The order's width, which decides whether untied rows keep the handle's slot (logic.ts keepsDragSlot).
  const orderRef = useRef<HTMLOListElement>(null);
  const [orderPx, setOrderPx] = useState(0);
  const listed = entries.length > 0;
  useLayoutEffect(() => {
    const order = orderRef.current;
    if (!order) return;
    const measure = () => setOrderPx(order.clientWidth);
    const observer = new ResizeObserver(measure);
    observer.observe(order);
    measure();
    return () => observer.disconnect();
  }, [listed]);

  // A change from the server mid-drag can move rows under the finger, so the drag gives up.
  useEffect(() => setDrag(null), [entries]);

  const reorder = (entryId: string, to: number) => {
    const order = reorderTie(entries, entryId, to);
    if (order) actions.dispatch({ t: "encounter.reorder", entryIds: order });
  };

  // A row tap does what a tap on the token does (features section 10):
  // select it and open its action bar on the map. A phone's sheet would
  // cover that bar, so it closes, and the token comes to the middle.
  const show = (tokenId: string | undefined) => {
    const token = tokenId !== undefined ? facts.view.tokens[tokenId] : undefined;
    if (!token) return;
    // While selecting several, a row tap only picks the creature for the
    // shared HP entry below the list, which stands in for the map's bar.
    if (multi) {
      ui.tap(token.id);
      ui.showActions(false);
      return;
    }
    ui.tap(token.id);
    props.close();
    const fp = footprint(token);
    requestPan(scope, {
      sceneId: token.sceneId,
      x: token.x + fp.w / 2,
      y: token.y + fp.h / 2,
      anchor: panAnchor(layoutSize(window, uiScale()), theme.layout.wideMinWidth, false),
    });
  };

  const handleFor = (index: number): NonNullable<RowDrag["handle"]> => ({
    onPointerDown(e: ReactPointerEvent<HTMLElement>) {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const entry = entries[index];
      if (!entry) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      const mids = entries.map((row) => {
        const r = rows.current.get(row.id)?.getBoundingClientRect();
        return r ? r.top + r.height / 2 : 0;
      });
      const height = rows.current.get(entry.id)?.getBoundingClientRect().height ?? 56;
      setDrag({ id: entry.id, from: index, pointerId: e.pointerId, startY: e.clientY, dy: 0, mids, height, run: tieRun(entries, index), target: index });
    },
    onPointerMove(e: ReactPointerEvent<HTMLElement>) {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      const here = d.mids[d.from]!;
      const dy = clamp(e.clientY - d.startY, d.mids[d.run.start]! - here, d.mids[d.run.end - 1]! - here);
      const target = clamp(dropIndex(d.mids, d.from, here + dy), d.run.start, d.run.end - 1);
      if (dy !== d.dy || target !== d.target) setDrag({ ...d, dy, target });
    },
    onPointerUp(e: ReactPointerEvent<HTMLElement>) {
      const d = dragRef.current;
      if (!d || d.pointerId !== e.pointerId) return;
      setDrag(null);
      reorder(d.id, d.target);
    },
    onPointerCancel() {
      setDrag(null);
    },
  });

  const offsetOf = (index: number): number => {
    if (!drag) return 0;
    if (index === drag.from) return drag.dy;
    if (drag.from < drag.target && index > drag.from && index <= drag.target) return -drag.height;
    if (drag.target < drag.from && index >= drag.target && index < drag.from) return drag.height;
    return 0;
  };

  if (entries.length === 0) {
    return <Empty>{dm ? "Nobody is in the fight yet. Add tokens below." : "Nobody you can see is in the fight yet."}</Empty>;
  }

  return (
    <ol ref={orderRef} style={{ margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 0 }}>
      {entries.map((entry, index) => {
        const run = tieRun(entries, index);
        const tied = run.end - run.start > 1;
        const rowDrag: RowDrag | null = dm
          ? {
              ...(tied ? { handle: handleFor(index) } : {}),
              slot: keepsDragSlot(orderPx, tied),
              offset: offsetOf(index),
              dragging: drag?.id === entry.id,
              canMoveUp: tied && index > run.start,
              canMoveDown: tied && index < run.end - 1,
              moveBy: (step) => reorder(entry.id, index + step),
            }
          : null;
        return (
          <EntryRow
            key={entry.id}
            entry={entry}
            active={entry.id === activeEntryId}
            role={you.role}
            mine={facts.mine(entry)}
            expanded={expanded === entry.id}
            picking={multi}
            selected={multi && entry.tokenId !== undefined && selectedIds.includes(entry.tokenId)}
            onExpand={() => setExpanded(expanded === entry.id ? null : entry.id)}
            onShow={() => show(entry.tokenId)}
            onShowToken={show}
            drag={rowDrag}
            rowRef={(el) => {
              if (el) rows.current.set(entry.id, el);
              else rows.current.delete(entry.id);
            }}
          />
        );
      })}
    </ol>
  );
}

function ValueEntryFromView(props: { onDone(): void }) {
  const entries = useSortedEntries();
  return <ValueEntry entries={entries} onDone={props.onDone} />;
}

/**
 * "Multi-select" for the tracker, and one damage or healing entry for
 * every creature picked (features section 10). Picks can also come from the
 * map, with the same mode or Shift.
 */
function SelectedCreatures() {
  const ui = useRoomUi();
  const multi = useRoomView((s) => s.local.multi);
  const selectedIds = useRoomView((s) => s.local.selectedIds);
  const tokens = useRoomView((s) => s.view?.tokens);
  const picked = useMemo(() => selectedIds.flatMap((id) => tokens?.[id] ?? []), [selectedIds, tokens]);
  return (
    <Section label="Several at once" style={COLUMN}>
      <Switch
        label="Multi-select"
        help="Tap rows or tokens to pick creatures, then enter damage or healing once for all of them."
        checked={multi}
        onChange={(on) => ui.setMultiSelect(on)}
      />
      {picked.length >= 2 ? (
        <>
          <span style={{ overflowWrap: "anywhere" }}>
            <strong>{picked.length} selected:</strong> {picked.map((t) => displayName(t)).join(", ")}
          </span>
          <GroupHpEntry tokens={picked} place="panel" />
          <Wrap>
            <Button size="sm" icon="close" iconOnly="always" title="Clear the selection" onClick={() => ui.select(null)}>
              Clear
            </Button>
          </Wrap>
        </>
      ) : multi ? (
        <Help>{picked.length === 1 ? `${displayName(picked[0]!)} is picked. Tap more rows.` : "Tap rows to pick creatures."}</Help>
      ) : null}
    </Section>
  );
}

// ---------------------------------------------------------------- building the fight

const NO_CANDIDATES: Record<AddMode, Token[]> = { selected: [], scene: [], visible: [] };

/**
 * The whole view, since "Visible to players" asks projection's own rule,
 * which reads both fog layers and the party's sight besides the tokens.
 */
function useCandidates(selectedTokenId: string | null): Record<AddMode, Token[]> {
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  return useMemo(
    () =>
      view
        ? {
            selected: addCandidates(view, sceneId, "selected", selectedTokenId),
            scene: addCandidates(view, sceneId, "scene", selectedTokenId),
            visible: addCandidates(view, sceneId, "visible", selectedTokenId),
          }
        : NO_CANDIDATES,
    [view, sceneId, selectedTokenId],
  );
}

/**
 * The rows tokens join a fight with, by the rule every path into a fight
 * shares (combat/state.ts useFightJoin): a creature placed in its lair
 * joins with In lair on. Every offered token's block starts loading as the
 * panel shows them, the selected one's too, which may not be in the
 * scene's list.
 */
function useJoinBatches(candidates: Record<AddMode, Token[]>): { batches(tokens: Token[]): EntryInput[][]; stateOf(tokens: readonly Token[]): JoinState } {
  const actions = useRoomActions();
  const offered = useMemo(() => [...candidates.scene, ...candidates.selected.filter((t) => !candidates.scene.includes(t))], [candidates]);
  const join = useFightJoin(offered);
  return { batches: (tokens) => entryBatches(tokens, actions.newId).map((batch) => batch.map(join.mark)), stateOf: join.stateOf };
}

function StartFight(props: { selectedTokenId: string | null }) {
  const actions = useRoomActions();
  const candidates = useCandidates(props.selectedTokenId);
  const join = useJoinBatches(candidates);
  const start = (tokens: Token[]) => {
    const [first = [], ...rest] = join.batches(tokens);
    actions.dispatch({ t: "encounter.start", entries: first });
    for (const batch of rest) actions.dispatch({ t: "encounter.add", entries: batch });
  };
  return (
    <Section label="Start a fight with" style={COLUMN}>
      <Wrap>
        <AddButtons candidates={candidates} stateOf={join.stateOf} onAdd={start} />
        <Button size="sm" onClick={() => start([])} style={GROW}>
          Nobody yet
        </Button>
      </Wrap>
      <JoinFailed candidates={candidates} stateOf={join.stateOf} />
    </Section>
  );
}

/**
 * The tracker's ways to add tokens. Each waits busy while a block it needs
 * to tell a creature placed in its lair loads, and stays off where one did
 * not load (JoinFailed says so), so none adds a row marked off for a lair
 * it could not read.
 */
function AddButtons(props: { candidates: Record<AddMode, Token[]>; stateOf(tokens: readonly Token[]): JoinState; onAdd(tokens: Token[]): void }) {
  const { candidates } = props;
  const selected = candidates.selected[0];
  const button = (tokens: Token[], words: ReactNode) => {
    const state = props.stateOf(tokens);
    return (
      <Button size="sm" disabled={tokens.length === 0 || state === "failed"} busy={state === "loading"} onClick={() => props.onAdd(tokens)} style={GROW}>
        {words}
      </Button>
    );
  };
  return (
    <>
      {button(candidates.selected, selected ? displayName(selected) : "Selected token")}
      {button(candidates.scene, `Everyone here (${candidates.scene.length})`)}
      {button(candidates.visible, `Visible to players (${candidates.visible.length})`)}
    </>
  );
}

/** The load failure's line and reload, where a block the tracker's adds need did not load. */
function JoinFailed(props: { candidates: Record<AddMode, Token[]>; stateOf(tokens: readonly Token[]): JoinState }) {
  const { selected, scene } = props.candidates;
  return props.stateOf([...selected, ...scene]) === "failed" ? <SrdLoadFailed what="The stat blocks" inline /> : null;
}

/**
 * What the DM uses to set the order up, right after it: Auto initiative
 * with the card of what it rolled under its button, where the DM just
 * pressed, then the other ways to set values, then Add to the fight
 * (docs/design-v1-combat-flow.md 3.2).
 */
function DmSetup(props: { selectedTokenId: string | null; editingValues: boolean; onEditValues(): void }) {
  const actions = useRoomActions();
  const candidates = useCandidates(props.selectedTokenId);
  const entries = useSortedEntries();
  const facts = useRowFacts();
  const scores = useRoomView((s) => s.view?.meta.settings.monsterInitScore ?? false);
  const fills = useMemo(() => (scores ? scoreFills(facts.view, entries) : []), [scores, facts.view, entries]);

  const join = useJoinBatches(candidates);
  const add = (tokens: Token[]) => {
    for (const batch of join.batches(tokens)) actions.dispatch({ t: "encounter.add", entries: batch });
  };

  return (
    <>
      <Section label="Auto Initiative" style={COLUMN}>
        <AutoInitiativeControls />
        <AutoInitiativeResult />
      </Section>
      <Section label="Initiative" style={COLUMN}>
        <Wrap>
          <Button size="sm" disabled={props.editingValues || entries.length === 0} onClick={props.onEditValues}>
            Type several values
          </Button>
          {fills.length > 0 ? (
            <Button
              size="sm"
              onClick={() => {
                for (let i = 0; i < fills.length; i += MAX_ENTRIES_PER_OP) {
                  actions.dispatch({ t: "encounter.setValues", values: fills.slice(i, i + MAX_ENTRIES_PER_OP) });
                }
              }}
            >
              Fill monster scores ({fills.length})
            </Button>
          ) : null}
        </Wrap>
        <Switch
          label="Monsters use Initiative scores"
          help="10 + DEX modifier instead of a roll. New monster rows start with it."
          checked={scores}
          onChange={(on) => actions.dispatch({ t: "room.update", settings: { monsterInitScore: on } })}
        />
      </Section>
      <Section label="Add to the fight" style={COLUMN}>
        <Wrap>
          <AddButtons candidates={candidates} stateOf={join.stateOf} onAdd={add} />
        </Wrap>
        <JoinFailed candidates={candidates} stateOf={join.stateOf} />
      </Section>
    </>
  );
}

/** The DM's rarely used parts, low in the panel: the turn timer, a setting, and ending the fight, which is destructive and armed. */
function DmSettings() {
  const actions = useRoomActions();
  const timerSec = useRoomView((s) => s.view?.meta.settings.turnTimerSec ?? 0);
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => {
    if (!confirmEnd) return;
    const t = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(t);
  }, [confirmEnd]);

  return (
    <>
      <Section label="Turn timer" style={COLUMN}>
        <Help>Counts each turn down for everyone, and nudges whoever acts when time is up. It never ends a turn.</Help>
        <Segmented
          label="Turn timer"
          value={timerSec}
          options={timerChoices(timerSec)}
          onChange={(turnTimerSec) => actions.dispatch({ t: "room.update", settings: { turnTimerSec } })}
        />
      </Section>
      <Section label="End" style={COLUMN}>
        <Wrap>
          <Button
            size="sm"
            variant="danger"
            armed={confirmEnd}
            onClick={() => {
              if (!confirmEnd) {
                setConfirmEnd(true);
                return;
              }
              setConfirmEnd(false);
              actions.dispatch({ t: "encounter.end" });
            }}
          >
            {confirmEnd ? "Tap again to end the fight" : "End the fight"}
          </Button>
        </Wrap>
      </Section>
    </>
  );
}

/** A player adds their own creatures on the scene. The server answers before the row appears. */
function JoinFight() {
  const you = useYou();
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const sceneId = useRoomView((s) => s.sceneId);
  const own = useMemo(
    () => ownCandidates({ tokens: tokens ?? {}, characters: characters ?? {}, encounter }, you.memberId, sceneId),
    [tokens, characters, encounter, you.memberId, sceneId],
  );
  if (own.length === 0) return null;
  return (
    <Section label="Join the fight" style={COLUMN}>
      <Wrap>
        {own.map((token) => (
          <JoinButton key={token.id} token={token} />
        ))}
      </Wrap>
    </Section>
  );
}

function JoinButton(props: { token: Token }) {
  const actions = useRoomActions();
  const { send, waiting } = useSend();
  return (
    <Button size="sm" busy={waiting} onClick={() => send({ t: "encounter.add", entries: [{ id: actions.newId(), tokenId: props.token.id }] })}>
      Add {displayName(props.token)}
    </Button>
  );
}

function SoundSwitch() {
  const on = useSoundOn();
  const dm = useYou().role === "dm";
  const follow = useFollowTurn();
  return (
    <Section label="This device" style={COLUMN}>
      <Switch label="Turn sound" help="A short chime on your turn. Android phones also vibrate." checked={on} onChange={setSoundOn} />
      {dm ? (
        <Switch
          label="Camera follows the turn"
          help="Your map pans to whoever acts each time the turn moves. Players' maps stay where they are."
          checked={follow}
          onChange={setFollowTurn}
        />
      ) : null}
    </Section>
  );
}
