import { useEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import type { LogEntry } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { theme } from "../../lib/theme.ts";
import { screenHeight, useLayoutSize } from "../device/layout.ts";
import { effectChip } from "../../lib/tokenView.ts";
import { usePublishAlerts, useUnderSheet, type ColumnAlert } from "../../pages/fold.ts";
import { sheetOpen } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { announceTurn, unlockAudioOnTap } from "./alerts.ts";
import { AutoRollWatch } from "./autoState.ts";
import { BAND_MAX_DISKS, BAND_NAME_MIN_PX, bandFit, TURN_BAND_PX, useTopBars, type BandTimer, type TurnPlacement } from "./band.ts";
import { clockText } from "./timer.ts";
import { useConfirmedSeq, useRowFacts, useSend, useSortedEntries, useTurnTimer, useYou } from "./hooks.ts";
import {
  answersPrompt,
  concentrationPrompt,
  entryActor,
  entryName,
  expiryNotice,
  hasStarted,
  playerOwnedEntry,
  stripRows,
  turnAlert,
  turnMark,
  turnOp,
  turnStatus,
  whoseTurn,
  type ConcentrationPrompt,
  type TurnMark,
} from "./logic.ts";
import { EndTurnPill, Portrait, TimerClock, TURN_PILL_PX } from "./parts.tsx";
import { RollAlerts } from "../rolls/RollAlerts.tsx";

/** How long "Your turn" flares when a player's turn arrives. */
const TURN_NOTICE_MS = 4_000;
const NOTICE_MS = 6_000;
const MAX_NOTICES = 3;

/** The window in the chrome's own pixels, which the interface size divides (features/device/layout.ts). */
function useViewport(): { width: number; height: number } {
  return useLayoutSize();
}

/**
 * The initiative strip (design 14.4, features 10): the creature acting now,
 * large, and for the DM the next few small. Tapping it opens the tracker.
 * It sits in the top bar's row from 900 px up, and on a short landscape
 * phone whose bar has room for it. Elsewhere, a portrait phone above all,
 * the bar has no room for it beside the DM's Undo and Redo or a player's
 * chip, so it is a band of its own across the top of the screen, under
 * the bar, during a fight. band.ts turnPlacement decides which.
 *
 * Players see only who acts now, or "Another creature's turn", never who
 * comes next: their order leaves out hidden and fogged creatures, so it
 * could be wrong, and the server saying it would give away a creature they
 * cannot see (features section 10, logic.ts turnStatus).
 *
 * On a player's own turn the strip itself is their turn's UI: it lights up,
 * says "Your turn", which flares for a few seconds as the turn arrives
 * (`notice`, useYourTurnNotice), and holds End Turn, so nothing about the
 * turn covers the map. `stripRef` is the bar's chip and End Turn, whose box
 * grows with them, so the top bar can tell when its row overflows.
 */
export function InitiativeStrip(props: { placement: TurnPlacement; notice: boolean; stripRef?: Ref<HTMLDivElement> }) {
  return props.placement === "bar" ? <Strip notice={props.notice} stripRef={props.stripRef} /> : <Band notice={props.notice} />;
}

/**
 * What a fight announces to this device, under the top bar: concentration
 * checks for the creatures this viewer answers for, notices when an effect
 * runs out, the turn timer's nudge and the roll requests. They hang from
 * the top bar because it is the one piece of the room that is always on
 * screen. For the same reason it clears the DM's auto initiative card once
 * it goes stale.
 *
 * The top bar mounts it once, apart from the strip, which moves between
 * the bar's row and the band when the bar runs out of room (band.ts): the
 * alerts and their timers must not start over when it does.
 */
export function FightWatch() {
  const dm = useYou().role === "dm";
  return (
    <>
      <FightAlerts />
      {dm ? <AutoRollWatch /> : null}
    </>
  );
}

/** Whether "Your turn" flares now: for a player, for a few seconds as their turn arrives. Read once per top bar, so a strip that moves keeps it. */
export function useYourTurnNotice(): boolean {
  const dm = useYou().role === "dm";
  return useTurnNotice(!dm);
}

/**
 * The top bar's turn chip: the round, who acts, the turn timer and for the
 * DM the next few, in an outlined pill like the bar's other chips, with a
 * player's End Turn beside it on their turn.
 */
function Strip(props: { notice: boolean; stripRef?: Ref<HTMLDivElement> }) {
  const you = useYou();
  const round = useRoomView((s) => s.view?.encounter?.round ?? null);
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const started = useRoomView((s) => (s.view?.encounter ? hasStarted(s.view.encounter) : false));
  const entries = useSortedEntries();
  const facts = useRowFacts();
  const timer = useTurnTimer();
  const { width } = useViewport();
  const wide = width >= theme.layout.wideMinWidth;
  const { current, next } = useMemo(
    () => stripRows({ dm: you.role === "dm", entries, activeEntryId, count: wide ? 5 : 3, skip: facts.skip }),
    [entries, activeEntryId, wide, you.role, facts.skip],
  );
  if (round === null) return null;

  const yours = current !== null && facts.mine(current);
  const { name, line } = whoseTurn({ dm: you.role === "dm", started, activeName: current ? entryName(facts.view, current) : null, yours });
  return (
    // The room name beside it gives way instead, so the strip never cuts a picture in half.
    <div ref={props.stripRef} style={{ flex: "none", display: "flex", alignItems: "center", gap: theme.space(2) }}>
      <div
        style={{
          ...chip(yours),
          gap: theme.space(1.5),
          height: TURN_PILL_PX,
          // "Your turn" brings its own padding, so the pill stays even at its end.
          padding: `0 ${yours ? 2 : theme.space(3)}px 0 ${theme.space(3)}px`,
        }}
      >
        <TrackerTarget label={`Initiative, round ${round}. ${line}. Open the tracker.`} reach={(theme.touch - TURN_PILL_PX) / 2} />
        <span aria-hidden style={roundStyle}>
          R{round}
        </span>
        {current ? (
          <Portrait entry={current} size={26} ring={theme.color.accentSoft} />
        ) : started ? (
          <span aria-hidden style={{ ...unknownDot, width: 26, height: 26 }}>
            ?
          </span>
        ) : null}
        <span
          aria-hidden
          data-rvtt-strip-name=""
          style={{
            minWidth: 0,
            /*
             * Narrower on the player's turn, to leave room for "Your turn"
             * and End Turn on a small laptop. A phone's bar gets the same
             * room as a computer's: cut shorter there, "Another creature"
             * read "Another cre…", while a name that does not fit makes the
             * row overflow and hands the strip to the band (band.ts).
             */
            maxWidth: yours ? 120 : 180,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: theme.font.body14,
            fontWeight: theme.weight.bold,
            color: current ? theme.color.accentSoft : theme.color.textMuted,
          }}
        >
          {name}
        </span>
        {yours ? <YourTurn notice={props.notice} fontSize={theme.font.small} inline /> : null}
        {timer && current ? <TimerClock state={timer} /> : null}
        {next.map((entry) => (
          <Portrait key={entry.id} entry={entry} size={22} />
        ))}
      </div>
      {you.role === "player" ? <EndTurnButton /> : null}
    </div>
  );
}

/**
 * The phone's turn band: the acting creature's picture and name, large,
 * its turn timer, and for the DM the next few, small. On a player's turn
 * the whole row lights up, with "Your turn" under the name and End Turn at
 * the row's end.
 */
function Band(props: { notice: boolean }) {
  const you = useYou();
  const round = useRoomView((s) => s.view?.encounter?.round ?? null);
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const started = useRoomView((s) => (s.view?.encounter ? hasStarted(s.view.encounter) : false));
  const entries = useSortedEntries();
  const facts = useRowFacts();
  const timer = useTurnTimer();
  const { width } = useViewport();
  const dm = you.role === "dm";
  const { current, next } = useMemo(
    () => stripRows({ dm, entries, activeEntryId, count: BAND_MAX_DISKS, skip: facts.skip }),
    [entries, activeEntryId, dm, facts.skip],
  );
  if (round === null) return null;

  const yours = current !== null && facts.mine(current);
  const { name, line } = whoseTurn({ dm, started, activeName: current ? entryName(facts.view, current) : null, yours });
  const clock: BandTimer = timer && current ? (timer.over ? "over" : { clock: clockText(timer) }) : "none";
  const fit = bandFit({ width, round, timer: clock, endTurn: !dm && yours, next: next.length });
  const shownNext = next.slice(0, fit.disks);
  const gutter = theme.space(3);
  return (
    <div
      style={{
        position: "relative",
        display: "flex",
        alignItems: "center",
        gap: theme.space(2),
        height: TURN_BAND_PX,
        // Edge to edge, past the top bar's padding, so the lit row spans the screen.
        margin: `0 calc(-1 * (${theme.safe.right} + ${gutter}px)) 0 calc(-1 * (${theme.safe.left} + ${gutter}px))`,
        padding: `0 calc(${theme.safe.right} + ${gutter}px) 0 calc(${theme.safe.left} + ${gutter}px)`,
        borderTop: `${theme.line.border}px solid ${theme.color.border}`,
        background: yours ? theme.color.turnTint : "transparent",
        color: theme.color.text,
        fontFamily: theme.font.body,
      }}
    >
      <TrackerTarget label={`Initiative, round ${round}. ${line}. Open the tracker.`} reach={0} />
      {fit.round ? (
        <span aria-hidden style={roundStyle}>
          R{round}
        </span>
      ) : null}
      {current ? (
        <Portrait entry={current} size={36} ring={theme.color.accentSoft} />
      ) : started ? (
        <span aria-hidden style={{ ...unknownDot, width: 36, height: 36 }}>
          ?
        </span>
      ) : null}
      <span
        style={{
          flex: 1,
          // A few letters of the name stay, and what stands beside it gives way first (band.ts bandFit).
          minWidth: BAND_NAME_MIN_PX + 2 * PILL_PAD,
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr)",
          /*
           * Short of room, the name and "Your turn" give way here instead
           * of drawing over the timer beside them. Only across: the flare's
           * ripple still spreads above and below. The padding, which the
           * margins take back, leaves the flare's pill its reach past the
           * words (PILL_PAD) inside the clip.
           */
          overflowX: "clip",
          margin: `0 -${PILL_PAD}px 0 ${theme.space(1) - PILL_PAD}px`,
          padding: `0 ${PILL_PAD}px`,
        }}
      >
        <span
          aria-hidden
          data-rvtt-strip-name=""
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: theme.font.input,
            fontWeight: theme.weight.bold,
            color: current ? theme.color.accentSoft : theme.color.textMuted,
          }}
        >
          {current ? name : line}
        </span>
        {current && yours ? <YourTurn notice={props.notice} fontSize={theme.font.small} /> : null}
      </span>
      {timer && current ? <TimerClock state={timer} size={theme.font.body14} stack /> : null}
      {shownNext.length > 0 ? (
        <span aria-hidden style={{ flex: "none", display: "flex", alignItems: "center", gap: theme.space(1) }}>
          <span style={{ fontSize: theme.font.tiny, color: theme.color.textMuted }}>Next</span>
          {shownNext.map((entry) => (
            <Portrait key={entry.id} entry={entry} size={24} />
          ))}
        </span>
      ) : null}
      {dm ? null : <EndTurnButton stack={fit.stackEnd} />}
    </div>
  );
}

/** The turn chip's outline, like the top bar's other chips, lit on the player's own turn as the tracker lights the active row. */
function chip(lit: boolean): CSSProperties {
  return {
    position: "relative",
    display: "flex",
    alignItems: "center",
    borderRadius: theme.radius.pill,
    border: `${theme.line.border}px solid ${lit ? theme.color.accentSoft : theme.color.border}`,
    background: lit ? theme.color.turnTint : "transparent",
    color: theme.color.text,
    fontFamily: theme.font.body,
  };
}

const roundStyle: CSSProperties = { flex: "none", fontSize: theme.font.small, fontWeight: theme.weight.bold, color: theme.color.textMuted };

/**
 * The whole strip opens the tracker. The button lies over the strip's
 * contents rather than holding them, because "Your turn" inside it would
 * be a live region inside a button, which screen readers may not announce,
 * and End Turn cannot be a button inside a button. `reach` grows it past
 * the chip above and below, to a 44 px target.
 */
function TrackerTarget(props: { label: string; reach: number }) {
  const ui = useRoomUi();
  return (
    <button
      type="button"
      onClick={() => ui.openPanel("tracker")}
      aria-label={props.label}
      style={{
        position: "absolute",
        top: -props.reach,
        left: 0,
        width: "100%",
        height: `calc(100% + ${props.reach * 2}px)`,
        margin: 0,
        padding: 0,
        border: "none",
        borderRadius: "inherit",
        background: "transparent",
        cursor: "pointer",
      }}
    />
  );
}

/**
 * "Your turn" in the strip, on the player's own turn. As the turn arrives
 * it flares for a few seconds as a filled pill with a ripple, then settles
 * into the plain text that stays for the rest of the turn (keyframes in
 * globals.css). Only the flare is a live region, so a screen reader hears
 * it once a turn. `inline` sits it after the name in the top bar's chip,
 * where it keeps its padding. Under the name in the band, the pill reaches
 * past the text instead, so the words line up with the name.
 */
const PILL_PAD = 6;

function YourTurn(props: { notice: boolean; fontSize: number; inline?: boolean }) {
  const text: CSSProperties = {
    flex: "none",
    justifySelf: "start",
    padding: props.inline ? `0 ${PILL_PAD}px` : 0,
    fontSize: props.fontSize,
    fontWeight: theme.weight.bold,
    lineHeight: "20px",
    whiteSpace: "nowrap",
    pointerEvents: "none",
    // Under the name in the band it ends in an ellipsis when the row is short of room, as the name does.
    ...(props.inline ? null : { maxWidth: "100%", overflow: "hidden", textOverflow: "ellipsis" }),
  };
  if (!props.notice) {
    return (
      <span aria-hidden style={{ ...text, color: theme.color.accentSoft }}>
        Your turn
      </span>
    );
  }
  const colors = {
    "--rvtt-notice-fill": theme.color.accentSoft,
    "--rvtt-notice-ink": theme.color.ink,
    "--rvtt-notice-settled": theme.color.accentSoft,
  } as CSSProperties;
  return (
    <span
      role="status"
      aria-live="assertive"
      className="rvtt-turn-notice"
      style={{
        ...text,
        ...colors,
        padding: `0 ${PILL_PAD}px`,
        margin: props.inline ? 0 : `0 -${PILL_PAD}px`,
        ...(props.inline ? null : { maxWidth: `calc(100% + ${2 * PILL_PAD}px)` }),
        borderRadius: theme.radius.pill,
        background: theme.color.accentSoft,
        color: theme.color.ink,
        animation: `rvtt-turn-notice ${TURN_NOTICE_MS}ms ease-out both`,
      }}
    >
      Your turn
    </span>
  );
}

const unknownDot: CSSProperties = {
  flex: "none",
  display: "grid",
  placeItems: "center",
  borderRadius: theme.radius.round,
  background: theme.color.surfaceRaised,
  color: theme.color.textMuted,
  fontWeight: theme.weight.bold,
  fontSize: theme.font.small,
};

// ---------------------------------------------------------------- alerts

type Notice = { id: string; text: string };

/**
 * The column of alert cards under the top bar. On a phone in portrait an
 * open sheet folds it (pages/fold.ts): it takes the `hidden` attribute,
 * so the global `[hidden]` rule beats its inline `display: flex`, its
 * cards leave the focus order and the accessibility tree, and everything
 * in it stays mounted with its state. One summary in the dock on the
 * sheet's edge names what waits meanwhile, from what this column
 * publishes, and Room's status region announces each alert that arrives
 * folded. `data-alert` marks each card's kind, so the summary's tap can
 * show the one it names.
 */
function FightAlerts() {
  const { width, height } = useViewport();
  const panelOpen = useRoomView((s) => sheetOpen(s.local));
  const folded = useUnderSheet();
  const wide = width >= theme.layout.wideMinWidth;
  // A sheet docked on the right in phone landscape would sit under this column, so the column steps left of it.
  const sheetWidth = !wide && width > height && panelOpen ? Math.min(theme.layout.landscapeSheetWidth, width * 0.6) : 0;

  useEffect(() => unlockAudioOnTap(), []);

  const { prompts, dismissPrompt, notices, dismissNotice } = useLogAlerts();
  const timeUp = useTimeUp();
  const view = useRowFacts().view;
  // Keyed on the names, not the view, which changes with every op: the dock and Room read what this publishes.
  const who = prompts.map((p) => entryName(view, p.target)).join("\n");
  const alerts = useMemo<ColumnAlert[]>(() => {
    const names = who.split("\n");
    const list: ColumnAlert[] = prompts.map((p, i) => {
      const name = names[i] ?? "";
      return { id: p.logId, kind: "concentration", who: name, says: `Concentration check for ${name}.` };
    });
    if (timeUp.text) list.push({ id: timeUp.key, kind: "timeUp", says: timeUp.text });
    for (const n of notices) list.push({ id: n.id, kind: "notice", text: n.text, says: n.text });
    return list;
  }, [prompts, notices, timeUp.text, timeUp.key, who]);
  const columnRef = usePublishAlerts(alerts);
  const top = useTopBars();

  /*
   * The column scrolls as a whole once its cards outgrow the room between
   * the bars: a concentration card over the DM's roll desk, or a roll card
   * over two chips in a landscape phone, pushed the last button under the
   * toolbar, where it showed through and took no tap. A scrolling box
   * clips what it holds, the cards' shadows included, so the box reaches
   * past its cards by padding that a negative margin takes back:
   * SHADOW_ROOM at the sides and the foot, and only the gap under the top
   * bar at its head. The box itself runs from the top bar to the toolbar
   * and no further, since what scrolls through its padding shows there,
   * and scroll-padding keeps a card that takes focus clear of it.
   */
  return (
    <div
      ref={columnRef}
      hidden={folded}
      style={{
        position: "absolute",
        top: `calc(100% + ${theme.space(2)}px)`,
        right: `calc(${theme.safe.right} + ${sheetWidth + theme.space(2)}px)`,
        width: `calc(min(300px, calc(100% - ${sheetWidth + theme.space(4)}px)) + ${2 * SHADOW_ROOM}px)`,
        // The screen's height in the zoomed bar's own pixels (features/device/layout.ts), less the bars.
        maxHeight: `calc(${screenHeight(100)} - ${theme.safe.top} - ${theme.safe.bottom} - ${top + theme.layout.toolbar}px)`,
        margin: `-${theme.space(2)}px -${SHADOW_ROOM}px -${SHADOW_ROOM}px`,
        padding: `${theme.space(2)}px ${SHADOW_ROOM}px ${SHADOW_ROOM}px`,
        scrollPadding: `${theme.space(2)}px 0 ${SHADOW_ROOM}px`,
        overflowY: "auto",
        overscrollBehavior: "contain",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: theme.space(2),
        pointerEvents: "none",
      }}
    >
      {prompts.map((p) => (
        <ConcentrationCard key={p.logId} prompt={p} onDone={() => dismissPrompt(p.logId)} />
      ))}
      {/* No box of its own, so the rolls' cards and chips stay items of the column. */}
      <div data-alert="rolls" style={{ display: "contents" }}>
        <RollAlerts />
      </div>
      {timeUp.text ? (
        <button
          type="button"
          role="status"
          data-alert="timeUp"
          onClick={timeUp.dismiss}
          style={{ ...card, minHeight: theme.touch, textAlign: "left", fontSize: theme.font.body14, cursor: "pointer", fontFamily: theme.font.body, borderColor: theme.color.danger }}
        >
          {timeUp.text}
        </button>
      ) : null}
      {notices.map((n) => (
        <button
          key={n.id}
          type="button"
          role="status"
          data-alert="notice"
          data-alert-id={n.id}
          onClick={() => dismissNotice(n.id)}
          style={{ ...card, minHeight: theme.touch, textAlign: "left", fontSize: theme.font.body14, cursor: "pointer", fontFamily: theme.font.body }}
        >
          {n.text}
        </button>
      ))}
    </div>
  );
}

/** Room around the alert cards for their shadow (theme.shadow.float reaches about 20 px below a card). */
const SHADOW_ROOM = theme.space(5);

const card: CSSProperties = {
  pointerEvents: "auto",
  padding: `${theme.space(2)}px ${theme.space(3)}px`,
  borderRadius: theme.radius.md,
  background: theme.color.surfaceRaised,
  border: `${theme.line.border}px solid ${theme.color.border}`,
  color: theme.color.text,
  boxShadow: theme.shadow.float,
};

/**
 * Fires "Your turn" once per turn for a player (no "Up next", logic.ts
 * turnStatus says why), true while the strip shows the notice. Android
 * vibrates and, with sound on, the device chimes. The first look after the
 * page opens shows the notice without either.
 */
function useTurnNotice(enabled: boolean): boolean {
  const entries = useSortedEntries();
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const facts = useRowFacts();
  const loaded = useRoomView((s) => s.view !== null);
  const [kind, setKind] = useState<"yours" | null>(null);
  const prev = useRef<TurnMark | null>(null);

  const mark = useMemo(() => {
    const status = enabled && encounter ? turnStatus({ entries, activeEntryId: encounter.activeEntryId, mine: facts.mine }) : "none";
    return turnMark(encounter, status);
  }, [enabled, encounter, entries, facts]);

  useEffect(() => {
    // The room mounts before its snapshot arrives. Until then there is no
    // fight to know about, so the first look is the first one with the
    // state loaded. Otherwise a reload on your turn would buzz the phone.
    if (!loaded) return;
    const alert = turnAlert(prev.current, mark);
    prev.current = mark;
    if (!alert) {
      // The turn moved on, so "Your turn" is stale.
      if (mark.status === "none") setKind(null);
      return;
    }
    setKind(alert.kind);
    if (alert.loud) announceTurn();
  }, [mark, loaded]);

  useEffect(() => {
    if (!kind) return;
    const t = setTimeout(() => setKind(null), TURN_NOTICE_MS);
    return () => clearTimeout(t);
  }, [kind]);

  return kind === "yours";
}

/**
 * A player's End Turn, beside the strip, shown only on their own turn. It
 * is never predicted (design 7.4: it scans the encounter), so it spins
 * until the server's event moves the turn. The wait lives in this
 * component, so it stays mounted and renders nothing off the turn.
 */
function EndTurnButton(props: { stack?: boolean }) {
  const store = useRoomStore();
  const entries = useSortedEntries();
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const facts = useRowFacts();
  const { send, waiting } = useSend();
  const status = turnStatus({ entries, activeEntryId, mine: facts.mine });
  if (status !== "yours" && !waiting) return null;
  return <EndTurnPill waiting={waiting} stack={props.stack} onClick={() => send(turnOp("encounter.next", store.getState()))} />;
}

/**
 * The turn timer's nudge (timer.ts): when time runs out, the device of
 * whoever acts, a player for their own creature or the DM for the ones no
 * player owns, vibrates or chimes like the turn notice and says so. Once
 * per turn, and it never ends the turn. A page opened after time ran out
 * stays quiet, as the notice does on a reload.
 */
function useTimeUp(): { text: string | null; key: string; dismiss(): void } {
  const timer = useTurnTimer();
  const you = useYou();
  const facts = useRowFacts();
  const entries = useSortedEntries();
  const activeEntryId = useRoomView((s) => s.view?.encounter?.activeEntryId ?? null);
  const round = useRoomView((s) => s.view?.encounter?.round ?? 0);
  const active = entries.find((e) => e.id === activeEntryId);
  const answers = active !== undefined && (you.role === "player" ? facts.mine(active) : !playerOwnedEntry(facts.view, active));
  const key = `${round}:${activeEntryId ?? ""}`;
  const [shown, setShown] = useState<{ key: string; text: string } | null>(null);
  const handled = useRef<string | null>(null);
  const over = timer?.over ?? false;
  const left = timer?.left ?? null;
  useEffect(() => {
    if (!active || !answers || !over || handled.current === key) return;
    handled.current = key;
    // Long past the end already: the page opened late, so it stays quiet.
    if (left !== null && left < -5) return;
    announceTurn();
    const who = you.role === "player" ? "your turn" : `${entryName(facts.view, active)}'s turn`;
    setShown({ key, text: `Time is up for ${who}.` });
  }, [active, answers, over, left, key, you.role, facts.view]);
  return { text: shown && shown.key === key ? shown.text : null, key: `timeUp:${key}`, dismiss: () => setShown(null) };
}

/**
 * Concentration checks and expiry notices from the log (design 9.5 and
 * 9.6). Only entries that arrive while the page is open count: the log a
 * snapshot carries is history, and the Log panel shows it.
 */
function useLogAlerts() {
  const log = useRoomView((s) => s.view?.log);
  const confirmedSeq = useConfirmedSeq();
  const you = useYou();
  const facts = useRowFacts();
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const seen = useRef<Set<string> | null>(null);
  const [prompts, setPrompts] = useState<ConcentrationPrompt[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);

  useEffect(() => {
    if (!log) return;
    const confirmed = log.filter((e) => seqOf(e) <= confirmedSeq);
    if (!seen.current) {
      seen.current = new Set(confirmed.map((e) => e.id));
      return;
    }
    const fresh = confirmed.filter((e) => !seen.current!.has(e.id));
    // The state keeps the newest 200 entries, so the seen set never needs more than those.
    seen.current = new Set(confirmed.map((e) => e.id));
    if (fresh.length === 0) return;
    const view = factsRef.current.view;
    const newPrompts: ConcentrationPrompt[] = [];
    const newNotices: Notice[] = [];
    for (const entry of fresh) {
      const prompt = concentrationPrompt(entry);
      if (prompt && answersPrompt(view, you, prompt)) newPrompts.push(prompt);
      const expiry = expiryNotice(entry);
      if (expiry) {
        const who = entryName(view, expiry.target);
        const what = effectChip({ key: expiry.key, ...(expiry.spell !== undefined ? { spell: expiry.spell } : {}) }).label;
        newNotices.push({ id: entry.id, text: `${what} ended on ${who}.` });
      }
    }
    if (newPrompts.length > 0) setPrompts((p) => [...p, ...newPrompts]);
    if (newNotices.length > 0) setNotices((n) => [...n, ...newNotices].slice(-MAX_NOTICES));
  }, [log, confirmedSeq, you]);

  // A check is moot once the creature stops concentrating, whoever ended it.
  useEffect(() => {
    setPrompts((list) => {
      const kept = list.filter((p) => entryActor(facts.view, p.target)?.effects.some((e) => e.key === "concentrating") ?? false);
      return kept.length === list.length ? list : kept;
    });
  }, [facts.view]);

  useEffect(() => {
    if (notices.length === 0) return;
    const t = setTimeout(() => setNotices((n) => n.slice(1)), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notices]);

  return {
    prompts,
    dismissPrompt: (logId: string) => setPrompts((p) => p.filter((x) => x.logId !== logId)),
    notices,
    dismissNotice: (id: string) => setNotices((n) => n.filter((x) => x.id !== id)),
  };
}

function seqOf(entry: LogEntry): number {
  const n = Number(entry.id.split(":")[0]);
  return Number.isFinite(n) ? n : 0;
}

/** Pass does nothing. Fail ends the creature's concentration. */
function ConcentrationCard(props: { prompt: ConcentrationPrompt; onDone(): void }) {
  const { prompt } = props;
  const actions = useRoomActions();
  const facts = useRowFacts();
  const name = entryName(facts.view, prompt.target);
  const effects = entryActor(facts.view, prompt.target)?.effects ?? [];
  const spell = effects.find((e) => e.key === "concentrating")?.spell;
  const fail = () => {
    for (const effect of effects) {
      if (effect.key === "concentrating") actions.dispatch({ t: "actor.effect.remove", target: prompt.target, effectId: effect.id });
    }
    props.onDone();
  };
  return (
    // Focusable from script, not by Tab, so the dock's summary can show it (pages/fold.ts focusAlert).
    <section
      role="group"
      aria-label={`Concentration check for ${name}`}
      tabIndex={-1}
      data-alert="concentration"
      data-alert-id={prompt.logId}
      style={{ ...card, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2) }}
    >
      <div>
        <div style={{ fontWeight: theme.weight.bold }}>Concentration check</div>
        <div style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>
          {name}
          {spell ? ` (${spell})` : ""} took damage.
          {prompt.dc !== undefined ? ` Constitution save, DC ${prompt.dc}.` : " Constitution save."}
        </div>
      </div>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Button size="sm" onClick={props.onDone} style={{ flex: 1 }}>
          Passed
        </Button>
        <Button size="sm" variant="danger" onClick={fail} style={{ flex: 1 }}>
          Failed
        </Button>
      </div>
    </section>
  );
}
