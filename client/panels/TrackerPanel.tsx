import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { Token } from "#shared/model.ts";
import { MAX_ENTRIES_PER_OP } from "#shared/protocol.ts";
import { Button } from "../components/Button.tsx";
import { Empty } from "../components/Empty.tsx";
import { Help, Section } from "../components/Panel.tsx";
import { Segmented } from "../components/Segmented.tsx";
import { Switch } from "../components/Switch.tsx";
import { useSoundOn, setSoundOn } from "../features/encounter/alerts.ts";
import { AutoInitiativeControls, AutoInitiativeResult } from "../features/encounter/AutoInitiative.tsx";
import { HpLog } from "../features/encounter/HpLog.tsx";
import { setFollowTurn, useFollowTurn } from "../features/encounter/followTurn.ts";
import { useRowFacts, useSend, useSortedEntries, useTurnTimer, useYou } from "../features/encounter/hooks.ts";
import {
  addCandidates,
  dropIndex,
  entryBatches,
  entryName,
  hasStarted,
  ownCandidates,
  reorderTie,
  scoreFills,
  tieRun,
  turnOp,
  turnStatus,
  whoseTurn,
  type AddMode,
} from "../features/encounter/logic.ts";
import { panAnchor, requestPan } from "../features/encounter/pan.ts";
import { EndTurnPill, TimerClock } from "../features/encounter/parts.tsx";
import { timerChoices } from "../features/encounter/timer.ts";
import { EntryRow, type RowDrag } from "../features/encounter/Row.tsx";
import { ValueEntry } from "../features/encounter/ValueEntry.tsx";
import { GroupHpEntry } from "../features/tokens/GroupHpEntry.tsx";
import type { PanelProps } from "../features/panels.ts";
import { displayName, footprint } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
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
        <Empty>No fight is running.</Empty>
        {dm ? <StartFight selectedTokenId={props.selectedTokenId} /> : null}
        <SoundSwitch />
      </Stack>
    );
  }

  return (
    <Stack>
      <Section divider={false} style={COLUMN}>
        <TurnControls />
        {dm ? <AutoInitiativeResult /> : null}
        {dm && editingValues ? <ValueEntryFromView onDone={() => setEditingValues(false)} /> : <EntryList close={props.close} />}
      </Section>
      {editingValues ? null : <SelectedCreatures />}
      {editingValues ? null : (
        <Section label="HP changes" style={COLUMN}>
          <HpLog />
        </Section>
      )}
      {dm ? (
        <DmTools selectedTokenId={props.selectedTokenId} editingValues={editingValues} onEditValues={() => setEditingValues(true)} />
      ) : (
        <JoinFight />
      )}
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

// ---------------------------------------------------------------- turns

function TurnControls() {
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

  const heading = (
    <div style={{ flex: 1, minWidth: 0 }}>
      {/* Beside the DM's Previous and Next, "Time's up +1:05" leaves no room, so the clock goes under the round rather than splitting "Round" from its number. */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: theme.space(2) }}>
        <span style={{ fontSize: theme.font.title, fontWeight: theme.weight.bold, whiteSpace: "nowrap" }}>Round {round}</span>
        {timer && active ? <TimerClock state={timer} size={theme.font.body14} /> : null}
      </div>
      <div style={{ color: theme.color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {whoseTurn({ dm: you.role === "dm", started, activeName: active ? entryName(facts.view, active) : null, yours: status === "yours" }).line}
      </div>
    </div>
  );

  if (you.role === "dm") {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        {heading}
        <Button size="sm" disabled={!canGoBack} onClick={() => actions.dispatch(turnOp("encounter.prev", store.getState()))} aria-label="Previous turn">
          Previous
        </Button>
        <Button size="sm" variant="primary" disabled={entries.length === 0} onClick={() => actions.dispatch(turnOp("encounter.next", store.getState()))}>
          {activeEntryId === null ? "Start" : "Next"}
        </Button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
      {heading}
      {status === "yours" || endTurn.waiting ? <EndTurnPill waiting={endTurn.waiting} onClick={() => endTurn.send(turnOp("encounter.next", store.getState()))} /> : null}
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
    <ol style={{ margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 0 }}>
      {entries.map((entry, index) => {
        const run = tieRun(entries, index);
        const tied = run.end - run.start > 1;
        const rowDrag: RowDrag | null = dm
          ? {
              ...(tied ? { handle: handleFor(index) } : {}),
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
 * "Select several" for the tracker, and one damage or healing entry for
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
        label="Select several"
        help="Tap rows or tokens to pick creatures, then enter damage or healing once for all of them."
        checked={multi}
        onChange={(on) => ui.setMultiSelect(on)}
      />
      {picked.length >= 2 ? (
        <>
          <span style={{ overflowWrap: "anywhere" }}>
            <strong>{picked.length} selected:</strong> {picked.map((t) => displayName(t)).join(", ")}
          </span>
          <GroupHpEntry tokens={picked} />
          <Wrap>
            <Button size="sm" onClick={() => ui.select(null)}>
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

function StartFight(props: { selectedTokenId: string | null }) {
  const actions = useRoomActions();
  const candidates = useCandidates(props.selectedTokenId);
  const start = (tokens: Token[]) => {
    const [first = [], ...rest] = entryBatches(tokens, actions.newId);
    actions.dispatch({ t: "encounter.start", entries: first });
    for (const batch of rest) actions.dispatch({ t: "encounter.add", entries: batch });
  };
  return (
    <Section label="Start a fight with" style={COLUMN}>
      <Wrap>
        <AddButtons candidates={candidates} onAdd={start} />
        <Button size="sm" onClick={() => start([])}>
          Nobody yet
        </Button>
      </Wrap>
    </Section>
  );
}

function AddButtons(props: { candidates: Record<AddMode, Token[]>; onAdd(tokens: Token[]): void }) {
  const { candidates } = props;
  const selected = candidates.selected[0];
  return (
    <>
      <Button size="sm" disabled={!selected} onClick={() => props.onAdd(candidates.selected)}>
        {selected ? displayName(selected) : "Selected token"}
      </Button>
      <Button size="sm" disabled={candidates.scene.length === 0} onClick={() => props.onAdd(candidates.scene)}>
        Everyone here ({candidates.scene.length})
      </Button>
      <Button size="sm" disabled={candidates.visible.length === 0} onClick={() => props.onAdd(candidates.visible)}>
        Visible to players ({candidates.visible.length})
      </Button>
    </>
  );
}

function DmTools(props: { selectedTokenId: string | null; editingValues: boolean; onEditValues(): void }) {
  const actions = useRoomActions();
  const candidates = useCandidates(props.selectedTokenId);
  const entries = useSortedEntries();
  const facts = useRowFacts();
  const scores = useRoomView((s) => s.view?.meta.settings.monsterInitScore ?? false);
  const timerSec = useRoomView((s) => s.view?.meta.settings.turnTimerSec ?? 0);
  const fills = useMemo(() => (scores ? scoreFills(facts.view, entries) : []), [scores, facts.view, entries]);
  const [confirmEnd, setConfirmEnd] = useState(false);

  useEffect(() => {
    if (!confirmEnd) return;
    const t = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(t);
  }, [confirmEnd]);

  const add = (tokens: Token[]) => {
    for (const batch of entryBatches(tokens, actions.newId)) actions.dispatch({ t: "encounter.add", entries: batch });
  };

  return (
    <>
      <Section label="Add to the fight" style={COLUMN}>
        <Wrap>
          <AddButtons candidates={candidates} onAdd={add} />
        </Wrap>
      </Section>
      <Section label="Auto initiative" style={COLUMN}>
        <AutoInitiativeControls />
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
          label="Monsters use initiative scores"
          help="10 + Dex modifier instead of a roll. New monster rows start with it."
          checked={scores}
          onChange={(on) => actions.dispatch({ t: "room.update", settings: { monsterInitScore: on } })}
        />
      </Section>
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
