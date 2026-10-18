import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type Ref } from "react";
import { createPortal } from "react-dom";
import { useStore } from "zustand";
import type { LogEntry } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { askedAlerts, barDockSlot, CARD_MAX, columnFacts, columnRoom, columnTop, EDGE, raisedRow, SHADOW_ROOM, SUMMARY_ROW, type AskedAlerts } from "../../canvas/barDock.ts";
import { ScrollForMore } from "../../canvas/TokenActionBar.tsx";
import { useAlertsSummaryEntry } from "../../components/sheetFocus.ts";
import { useBackClose } from "../../lib/backClose.ts";
import { containTab, inertOutside } from "../../lib/modalDialog.ts";
import { focusMap, mapFocusSlot } from "../../pages/mapFocus.ts";
import { useModalSlot } from "../../pages/modalSlot.tsx";
import { theme } from "../../lib/theme.ts";
import { screenHeight, useLayoutSize } from "../device/layout.ts";
import { effectChip } from "../../lib/tokenView.ts";
import { drawn, focusAlert, usePublishAlerts, useUnderSheet, type AlertsSummary, type ColumnAlert } from "../../pages/fold.ts";
import { SummaryButton, useDockSummary } from "../../pages/RoomDock.tsx";
import { useScoped } from "../../state/scope.ts";
import { useUiScale } from "../device/settings.ts";
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
import { CARD_MIN_WIDTH } from "../rolls/logic.ts";
import { bonusFor } from "#shared/dice/bonus.ts";
import { creatureRolls } from "../dice/creature.ts";
import { readUsed } from "../dice/options.ts";
import { presetFor } from "../dice/presets.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useActOnce, useRollBlocked } from "../dice/useRollOption.ts";
import { alertCard as card } from "./alertCard.ts";
import { CardButtons, CardChips, rollTrouble, useCardRoll, useCardSend } from "./CardRoll.tsx";
import { RechargeCard, RechargeWait, rechargeAlertId, useRechargePrompts } from "./RechargeCard.tsx";
import { SaveEndsCard, saveAlertId, usePendingSaves } from "./SaveEndsCard.tsx";
import {
  cardRoll,
  CONCENTRATION_TEST,
  concentrationCard,
  concentrationResistOp,
  concentrationRollTo,
  concentrationWords,
  endConcentrationOps,
  legendaryLeft,
  rechargeTurn,
  saveEndsWords,
  turnStarted,
  type CardChip,
  type ConcentrationAction,
  type RechargeTurn,
} from "./saveCards.ts";

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
  const turnSlot = useModalSlot("turn");
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
        {yours ? <YourTurn notice={props.notice} fontSize={theme.font.small} inline slot={turnSlot} /> : null}
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
  const turnSlot = useModalSlot("turn");
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
        {current && yours ? <YourTurn notice={props.notice} fontSize={theme.font.small} slot={turnSlot} /> : null}
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
      // A backdrop to what stands over it: the alerts' summary row may cover part of it (FightAlerts), as the band's own parts do.
      data-rvtt-backdrop=""
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

function YourTurn(props: { notice: boolean; fontSize: number; inline?: boolean; slot?: HTMLElement | null }) {
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
  /*
   * A sheet in the very short mode is modal and leaves the strip out of
   * reach, so while it shows the flare speaks and shows inside it, at the
   * top of its body (pages/modalSlot.tsx), and the strip's pill under it
   * only shows.
   */
  if (props.slot) {
    return (
      <>
        <span aria-hidden className="rvtt-turn-notice" style={{ ...text, ...colors, padding: `0 ${PILL_PAD}px`, margin: props.inline ? 0 : `0 -${PILL_PAD}px`, borderRadius: theme.radius.pill, background: theme.color.accentSoft, color: theme.color.ink }}>
          Your turn
        </span>
        {createPortal(
          <span
            role="status"
            aria-live="assertive"
            style={{ padding: `${theme.space(1)}px ${theme.space(3)}px`, borderRadius: theme.radius.pill, background: theme.color.accentSoft, color: theme.color.ink, fontSize: theme.font.body14, fontWeight: theme.weight.bold, boxShadow: theme.shadow.float }}
          >
            Your turn
          </span>,
          props.slot,
        )}
      </>
    );
  }
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
 *
 * It shares the right of the map with the docked token action bar
 * (docs/design-v1-bar-dock.md 1.3, canvas/barDock.ts shareLane). It
 * publishes its content's height and its first card's, and reads only the
 * bar's box, so neither feeds back on the other. Stacked, it stops 8 px
 * above the bar and says "Scroll for more" while that cuts it short.
 * Where even its first card leaves the bar too little, it shows the same
 * summary as the dock in one 44 px row, with its cards hidden as under a
 * sheet, and a tap on the row hides the bar and shows them. It starts
 * below the notices that last when they span the map over it (Room.tsx).
 *
 * It stops at the active tool's options, so it never covers Select
 * several's Actions. Where that leaves it under one whole card, as with
 * the Ruler at 480 x 320 at 130%, the row stands for its cards too
 * (`forRoom`), uncapped, since a card cut to a strip takes no tap. Its tap
 * opens what it stands for (`asked`, barDock.ts askedAlerts): a waiting
 * roll's card at a phone's foot; or the cards where they are, down to the
 * toolbar over the tool's options, until a tap lands outside them or
 * nothing waits, when the first card fits whole there; or else the alerts
 * over the screen, a dialog from the safe top to the toolbar, or to the
 * screen's foot where even that is too short for the first card, with
 * Close, which Escape and Back close too, as does nothing left waiting. The
 * column's cards are the ones it shows, never copies, so a half-answered
 * roll keeps its total.
 */
function FightAlerts() {
  const { width, height } = useViewport();
  const panelOpen = useRoomView((s) => sheetOpen(s.local));
  const folded = useUnderSheet();
  const wide = width >= theme.layout.wideMinWidth;
  // A sheet docked on the right in phone landscape would sit under this column, so the column steps left of it.
  const sheetWidth = !wide && width > height && panelOpen ? Math.min(theme.layout.landscapeSheetWidth, width * 0.6) : 0;
  const zoom = useUiScale();
  const ui = useRoomUi();

  useEffect(() => unlockAudioOnTap(), []);

  const { prompts, dismissPrompt, notices, dismissNotice, notify, recharge, dismissRecharge } = useLogAlerts();
  const timeUp = useTimeUp();
  const view = useRowFacts().view;
  const saves = usePendingSaves();
  const recharges = useRechargePrompts(recharge.turn, recharge.dismissed);
  const rechargeFor = recharge.turn;
  // Keyed on the names, not the view, which changes with every op: the dock and Room read what this publishes.
  const who = prompts.map((p) => entryName(view, p.target)).join("\n");
  /*
   * The dock's summary has no kind of its own for a save-ends or recharge
   * card (pages/fold.ts ColumnAlert), so they go as notices, whose words
   * are the card's own, keyed on their ids and words.
   */
  const cardLines = [
    ...saves.map((p) => `${saveAlertId(p)}\t${saveEndsWords(entryName(view, p.target), p.effect).head}`),
    ...recharges.prompts.map((p) => `${rechargeAlertId(p)}\t${p.text}`),
  ].join("\n");
  const alerts = useMemo<ColumnAlert[]>(() => {
    const names = who.split("\n");
    const list: ColumnAlert[] = prompts.map((p, i) => {
      const name = names[i] ?? "";
      return { id: p.logId, kind: "concentration", who: name, says: `Concentration check for ${name}.` };
    });
    if (timeUp.text) list.push({ id: timeUp.key, kind: "timeUp", says: timeUp.text });
    for (const line of cardLines ? cardLines.split("\n") : []) {
      const [id = "", text = ""] = line.split("\t");
      list.push({ id, kind: "notice", text, says: text });
    }
    for (const n of notices) list.push({ id: n.id, kind: "notice", text: n.text, says: n.text });
    return list;
  }, [prompts, notices, timeUp.text, timeUp.key, who, cardLines]);
  const publishColumn = usePublishAlerts(alerts);
  const top = useTopBars();

  // ------------------------------------------------ the lane it shares with the token bar
  const dock = useScoped(barDockSlot);
  const chrome = useStore(dock, (s) => s.chrome);
  const lasting = useStore(dock, (s) => s.notices);
  const bar = useStore(dock, (s) => s.bar);
  const footYields = useStore(dock, (s) => s.footYields);
  const rollAsked = useStore(dock, (s) => s.columnRollAsked);
  const barSummary = useDockSummary("bar");
  const roomSummary = useDockSummary("room");
  const rolls = useAlertsSummaryEntry();
  const laneTop = chrome ? chrome.top + EDGE : null;
  const colTop = laneTop === null ? null : columnTop(laneTop, lasting);
  const push = laneTop !== null && colTop !== null ? colTop - laneTop : 0;
  // A roll card folded at the screen's foot, for a compact bar or a screen too short for it, needs the row to stand for it, room or not (PlayerRolls.tsx).
  const forFootCard = !folded && footYields && barSummary !== null;
  // The first card's height as last drawn, which the row standing in for the cards keeps: measured afresh whenever what waits changes.
  const [firstHeight, setFirstHeight] = useState(0);
  const [asked, setAsked] = useState<AskedAlerts | null>(null);
  const toOptions = chrome ? height - chrome.top - chrome.bottom - push : Infinity;
  const cramped = !folded && roomSummary !== null && firstHeight > 0 && toOptions < EDGE + firstHeight;
  const forRoom = cramped && !asked && !forFootCard;
  const summary = forRoom ? roomSummary : barSummary;
  const summarized = forFootCard || forRoom || (!folded && bar?.lane === "summary" && summary !== null);
  useLayoutEffect(() => {
    if (dock.getState().columnCramped !== forRoom) dock.setState({ columnCramped: forRoom });
  }, [dock, forRoom]);
  useLayoutEffect(() => () => dock.setState({ columnCramped: false }), [dock]);
  // What waits changed: the cards are measured again, which a hidden card cannot be. Asked for, they stay shown while anything waits, since opening a roll's card changes the summary's words too.
  const waits = roomSummary?.name ?? null;
  // The last alert answered over the screen takes the alerts and the row with it: focus goes to the map, never to the page (pages/mapFocus.ts).
  const focusMapNext = useRef(false);
  useLayoutEffect(() => {
    if (waits === null) {
      if (asked !== null && asked !== "column") focusMapNext.current = true;
      setAsked(null);
    }
    setFirstHeight(0);
  }, [waits]);
  const overlay = asked !== null && asked !== "column" && !folded;
  useLayoutEffect(() => {
    if (dock.getState().alertsOverlay !== overlay) dock.setState({ alertsOverlay: overlay });
  }, [dock, overlay]);
  useLayoutEffect(() => () => dock.setState({ alertsOverlay: false }), [dock]);
  const stacked = bar?.lane === "stacked" && colTop !== null ? columnRoom({ lane: "stacked", columnTop: colTop, bar: bar.box }) : null;
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cardsRef = useRef<HTMLDivElement>(null);
  /*
   * Where the summary row stands (barDock.ts raisedRow). Its place is under
   * the top bars and any lasting notice. Where that would put it over the
   * tool's option buttons, as in a fight at 480 x 320 at 130%, it rises, over
   * the turn band and then the top bar's row if it must. It never meets a
   * lasting notice, which paints above the column and would hide it. Over a
   * button in the top bars it moves left into a gap between them, 8 px
   * clear of each, End turn above all, since a player who chose Later must
   * still be able to end their turn. `rowPlace` is how far it rose and
   * moved left, and how far in from its usual edges it stops, in the
   * column's own pixels. It never moves right, which would take the
   * column past the window: a gap to its right narrows it from the left.
   */
  const rowRef = useRef<HTMLButtonElement>(null);
  const [rowPlace, setRowPlace] = useState<RowPlace>(NOT_RAISED);
  const appliedPlace = useRef(rowPlace);
  appliedPlace.current = rowPlace;
  useLayoutEffect(() => {
    const row = rowRef.current;
    const box = boxRef.current;
    const header = box?.parentElement;
    if (!row || !box || !header || !chrome) {
      setRowPlace(NOT_RAISED);
      return;
    }
    const r = row.getBoundingClientRect();
    const applied = appliedPlace.current;
    const usual = {
      left: r.left + (applied.shift - applied.insetLeft) * zoom,
      right: r.right + (applied.shift + applied.insetRight) * zoom,
      top: r.top + applied.lift * zoom,
      height: r.height,
    };
    const controls = Array.from(header.querySelectorAll("button"))
      .filter((b) => !box.contains(b) && !b.hasAttribute("data-rvtt-backdrop"))
      .map((b) => b.getBoundingClientRect());
    const rules = {
      row: usual,
      // Its shadow keeps inside the window.
      minLeft: (chrome.safe.left + SHADOW_ROOM) * zoom,
      ceiling: header.firstElementChild?.getBoundingClientRect().top ?? 0,
      floor: (height - chrome.controls - theme.space(1)) * zoom,
      taken: lasting === null ? [] : [{ top: chrome.top * zoom, bottom: (lasting + theme.space(1)) * zoom }],
      controls,
      gap: EDGE * zoom,
      minWidth: theme.touch * zoom,
    };
    /*
     * Best above the whole of the tool's options, its hint included, where
     * a spot is left there, such as over the room's name at 480 x 320 at
     * 130%. Else above its buttons and readings, over the hint only. Where
     * no spot keeps above the tool's buttons, as with capped options
     * scrolled at 130%, the row lets that rule go too and stands as high
     * as the others allow, over as little of them as it can.
     */
    const place =
      raisedRow({ ...rules, floor: (height - chrome.bottom - theme.space(1)) * zoom }) ?? raisedRow(rules) ?? raisedRow({ ...rules, floor: Infinity, highest: true });
    const shift = place ? Math.max(0, Math.round((usual.left - place.left) / zoom)) : 0;
    const next = place
      ? {
          lift: Math.round((usual.top - place.top) / zoom),
          shift,
          insetLeft: Math.max(0, Math.ceil((place.left - (usual.left - shift * zoom)) / zoom)),
          insetRight: Math.max(0, Math.ceil((usual.right - shift * zoom - place.right) / zoom)),
        }
      : NOT_RAISED;
    // A measure taken with the place applied differs from the last only by rounding, so it keeps the place and draws nothing again.
    const near = (a: RowPlace, b: RowPlace) => Math.abs(a.lift - b.lift) <= 1 && Math.abs(a.shift - b.shift) <= 1 && Math.abs(a.insetLeft - b.insetLeft) <= 1 && Math.abs(a.insetRight - b.insetRight) <= 1;
    setRowPlace((prev) => (near(prev, next) ? prev : next));
  });
  // Asked for where they are, the cards stand over the tool's options until a tap lands outside them.
  useEffect(() => {
    if (asked !== "column") return;
    const off = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setAsked(null);
    };
    document.addEventListener("pointerdown", off, true);
    return () => document.removeEventListener("pointerdown", off, true);
  }, [asked]);
  // The alerts over the screen close with Close, Escape or Back, and focus goes back to the row that opened them.
  const focusRow = useRef(false);
  const closeOverlay = useCallback(() => {
    setAsked(null);
    focusRow.current = true;
  }, []);
  useBackClose(overlay, closeOverlay);
  // Modal as a <dialog> is (lib/modalDialog.ts) without becoming one, which would mount its cards afresh and drop a half-typed total: the page behind takes no focus and no tap, and Tab keeps inside.
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!overlay || !box) return;
    const undo = inertOutside(box);
    const onKey = (e: KeyboardEvent) => containTab(box, e);
    box.addEventListener("keydown", onKey);
    return () => {
      box.removeEventListener("keydown", onKey);
      undo();
    };
  }, [overlay]);
  useEffect(() => {
    if (!overlay) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeOverlay();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [overlay, closeOverlay]);
  // Measured again once closed, the cards stand in the column for a moment before the row returns, so focus waits for it.
  const mapFocus = useScoped(mapFocusSlot);
  useLayoutEffect(() => {
    if (focusMapNext.current && !overlay) {
      focusMapNext.current = false;
      focusRow.current = false;
      const active = document.activeElement;
      if (active === null || active === document.body || !active.isConnected) focusMap(mapFocus);
      return;
    }
    if (!focusRow.current || !rowRef.current) return;
    focusRow.current = false;
    rowRef.current.focus({ preventScroll: true });
  });
  const overlayTitle = useId();
  const [clipped, setClipped] = useState(false);
  const columnRef = useCallback(
    (el: HTMLDivElement | null) => {
      boxRef.current = el;
      publishColumn(el);
    },
    [publishColumn],
  );

  // The cards' measures, while they are drawn. Folded or summarized they keep the last ones, so hiding them never reads as having none, at the column's top now (barDock.ts columnFacts).
  useLayoutEffect(() => {
    const cards = cardsRef.current;
    if (!cards || colTop === null) return;
    // Where the summary row stands while it has risen over the bars, so a bar under it may take the room it left.
    const row = summarized && rowPlace.lift > 0 ? colTop - rowPlace.lift : undefined;
    const measure = () => {
      // The row standing in for a folded foot card, or for cards with no room, is the column's first card then, so the bar keeps below it, wherever it stands.
      if ((forFootCard || forRoom) && dock.getState().bar?.lane !== "summary") {
        const top = row ?? colTop;
        const prev = dock.getState().column;
        if (prev?.top !== top || prev.first !== SUMMARY_ROW || prev.content !== SUMMARY_ROW) dock.setState({ column: { top, content: SUMMARY_ROW, first: SUMMARY_ROW } });
        return;
      }
      // Over the screen the cards are as wide as it, so they say nothing of the column: its last measures stand.
      if (overlay) return;
      const measured = drawn(cards) ? { content: cards.getBoundingClientRect().height / zoom, first: firstCardHeight(cards) / zoom } : null;
      if (measured) setFirstHeight(measured.first);
      const prev = dock.getState().column;
      const next = columnFacts(prev, { top: colTop, measured, ...(row === undefined ? null : { row }) });
      if (next !== prev) dock.setState({ column: next });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cards);
    return () => observer.disconnect();
  }, [dock, colTop, zoom, alerts, summarized, folded, forFootCard, forRoom, overlay, rowPlace.lift]);
  useLayoutEffect(() => () => dock.setState({ column: null }), [dock]);

  const clip = () => {
    const el = boxRef.current;
    setClipped(!!el && el.scrollHeight - el.clientHeight - el.scrollTop > 4);
  };
  useLayoutEffect(clip, [stacked, alerts]);

  // The summary row's tap hides the bar, and once the cards show again, opens a roll that waits for this viewer or focuses the alert it named, as the dock's does.
  const [showAfter, setShowAfter] = useState<{ kind: "rolls" } | { kind: "alert"; first: AlertsSummary["first"] } | null>(null);
  useLayoutEffect(() => {
    if (!showAfter || summarized) return;
    // Drawn again once the bar steps aside, the cards may turn out to have no room for one whole card: measured now, they open where they fit before the request is met.
    const cards = cardsRef.current;
    const first = cards ? firstCardHeight(cards) / zoom : 0;
    const footRoll = showAfter.kind === "rolls" && width < CARD_MIN_WIDTH;
    if (!asked && !footRoll && chrome && first > 0 && toOptions < EDGE + first) {
      setAsked(askedWhere(first));
      return;
    }
    setShowAfter(null);
    if (showAfter.kind === "rolls") rolls?.open({ barAway: true });
    else focusAlert(boxRef.current, showAfter.first);
  });

  // Where the cards show once asked for (barDock.ts askedAlerts), from the first card's height and the room the bars leave.
  const askedWhere = (first = firstHeight): AskedAlerts =>
    chrome
      ? askedAlerts({ first, column: height - chrome.top - chrome.toolbar - push, overlay: height - chrome.safe.top - chrome.toolbar - OVERLAY_HEAD - 2 * OVERLAY_PAD })
      : "column";
  /*
   * The tap on the row beside the token bar asks for the cards it stands
   * for, and the bar steps aside. Where the cards, drawn again, turn out to
   * have no room for one whole card, the column's own row stands for them
   * now, and the tap asks as that row's tap would, so one tap is enough.
   */
  // Asked for, the cards keep to where they fit as the room changes, such as a turn band arriving over an open column: the first card goes over the screen where the column no longer holds it whole, and back.
  useLayoutEffect(() => {
    if (!asked || !chrome || firstHeight <= 0) return;
    const where = askedWhere();
    if (where !== asked) setAsked(where);
  });
  // A roll's card opened in the column by its chip asks as the row's tap would, the chip being in the column too: once, so Close on the alerts over the screen holds.
  const rollPending = useRef(false);
  const rollBefore = useRef(false);
  useLayoutEffect(() => {
    if (rollAsked && !rollBefore.current) rollPending.current = true;
    if (!rollAsked) rollPending.current = false;
    rollBefore.current = rollAsked;
    if (rollPending.current && forRoom) {
      rollPending.current = false;
      setAsked(askedWhere());
      return;
    }
    if (!showAfter || !forRoom) return;
    if (showAfter.kind === "rolls" && width < CARD_MIN_WIDTH) {
      setShowAfter(null);
      rolls?.open({ barAway: true });
      return;
    }
    setAsked(askedWhere());
  });


  /*
   * The column scrolls as a whole once its cards outgrow the room between
   * the bars: a concentration card over the DM's roll desk, or a roll card
   * over two chips in a landscape phone, pushed the last button under the
   * toolbar, where it showed through and took no tap. A scrolling box
   * clips what it holds, the cards' shadows included, so the box reaches
   * past its cards by padding: SHADOW_ROOM at the left where the window
   * has it and at the foot (but over a stacked bar), and only the 8 px
   * margin at the right, so it never reaches past the screen or a
   * landscape sheet, and a card scrolled into view never scrolls the room
   * (LPD-DMPHONE-4). The box itself runs from the top bar to the active
   * tool's options or the toolbar, or to 8 px above a stacked token bar,
   * and no further, since what scrolls through its padding shows there,
   * and scroll-padding keeps a card that takes focus clear of it.
   */
  // The right safe area as the map sees it: none beside the side panel (theme.safe.mapRight).
  const rightPad = sheetWidth > 0 ? `${EDGE}px` : `calc(${theme.safe.mapRight} + ${EDGE}px)`;
  // The safe areas and a sheet take their share of the width (barDock.ts columnCards, the same rule in numbers).
  const cardWidth = `min(${CARD_MAX}px, calc(100% - ${sheetWidth + 2 * EDGE}px - ${theme.safe.left} - ${sheetWidth > 0 ? "0px" : theme.safe.mapRight}))`;
  // The shadow's room at the left, but never past the window's left edge on a phone the cards span.
  const leftPad = `min(${SHADOW_ROOM}px, calc(100% - ${cardWidth} - ${rightPad}))`;
  return (
    <div
      ref={columnRef}
      hidden={folded}
      onScroll={clip}
      {...(overlay ? { role: "dialog", "aria-modal": true, "aria-labelledby": overlayTitle } : null)}
      style={{
        position: "absolute",
        top: `calc(100% + ${push - (summarized ? rowPlace.lift : 0)}px)`,
        right: sheetWidth + (summarized ? rowPlace.shift : 0),
        width: `calc(${cardWidth} + ${leftPad} + ${rightPad})`,
        // Before Room has measured its bars: the screen's height in the zoomed bar's own pixels (features/device/layout.ts), less the bars.
        // Summarized, the row is all it holds, and it always shows whole, however little the bars leave.
        maxHeight: summarized
          ? undefined
          : stacked !== null
            ? stacked + EDGE
            : chrome
              ? Math.max(0, height - chrome.top - (asked === "column" ? chrome.toolbar : chrome.bottom) - push)
              : `calc(${screenHeight(100)} - ${theme.safe.top} - ${theme.safe.bottom} - ${top + theme.layout.toolbar + push}px)`,
        // Stacked over the bar, the foot keeps no shadow room: it would count as more to scroll to, and the bar sits 8 px below anyway.
        padding: `${EDGE}px ${rightPad} ${stacked !== null ? 0 : SHADOW_ROOM}px ${leftPad}`,
        scrollPadding: `${EDGE}px 0 ${stacked !== null ? 0 : SHADOW_ROOM}px`,
        overflowY: "auto",
        overscrollBehavior: "contain",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        gap: theme.space(2),
        pointerEvents: "none",
        // Over the screen: from the safe top to the toolbar, or to the screen's foot, edge to edge on an opaque fill, its body scrolling under its header.
        ...(overlay && chrome
          ? {
              top: theme.safe.top,
              left: 0,
              right: 0,
              width: "auto",
              height: `calc(${asked === "fullScreen" ? height : height - chrome.toolbar}px - ${theme.safe.top})`,
              maxHeight: undefined,
              padding: 0,
              overflowY: "hidden",
              gap: 0,
              background: theme.color.surface,
              pointerEvents: "auto",
            }
          : null),
      }}
    >
      {overlay ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: theme.space(2),
            flex: "none",
            boxSizing: "border-box",
            height: OVERLAY_HEAD,
            padding: `0 calc(${theme.safe.mapRight} + ${theme.space(3)}px) 0 calc(${theme.safe.left} + ${theme.space(3)}px)`,
            borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
          }}
        >
          <h2 id={overlayTitle} style={{ flex: 1, margin: 0, fontSize: theme.font.input, fontWeight: theme.weight.bold }}>
            Alerts
          </h2>
          <Button size="sm" icon="close" iconOnly="always" onClick={closeOverlay}>
            Close
          </Button>
        </div>
      ) : null}
      {summarized && summary ? (
        <SummaryButton
          ref={rowRef}
          summary={summary}
          onClick={() => {
            ui.showActions(false);
            // A card at a phone's foot opens at once, since it may stay folded for want of room until asked for, and the column has no room to show it.
            if (forFootCard || (forRoom && rolls?.waiting && width < CARD_MIN_WIDTH)) {
              rolls?.open({ barAway: true });
              return;
            }
            if (forRoom) setAsked(askedWhere());
            setShowAfter(rolls?.waiting ? { kind: "rolls" } : { kind: "alert", first: summary.first });
          }}
          style={{ ...card, minHeight: SUMMARY_ROW, padding: `0 ${theme.space(3)}px`, marginLeft: rowPlace.insetLeft, marginRight: rowPlace.insetRight }}
        />
      ) : null}
      <div
        ref={cardsRef}
        hidden={summarized}
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: theme.space(2),
          ...(overlay
            ? {
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                overscrollBehavior: "contain",
                padding: `${OVERLAY_PAD}px calc(${theme.safe.mapRight} + ${theme.space(3)}px) ${asked === "fullScreen" ? `calc(${theme.safe.bottom} + ${OVERLAY_PAD}px)` : `${OVERLAY_PAD}px`} calc(${theme.safe.left} + ${theme.space(3)}px)`,
              }
            : null),
        }}
      >
        {prompts.map((p) => (
          <ConcentrationCard key={p.logId} prompt={p} onDone={() => dismissPrompt(p.logId)} onResult={notify} />
        ))}
        {saves.map((p) => (
          <SaveEndsCard key={p.effect.due.id} pending={p} onResult={notify} />
        ))}
        {rechargeFor ? recharges.prompts.map((p) => <RechargeCard key={p.id} prompt={p} creature={rechargeFor.creature} holder={rechargeFor.holder} onDone={() => dismissRecharge(p.id)} />) : null}
        {recharges.loading || recharges.failed ? <RechargeWait failed={recharges.failed} /> : null}
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
      {stacked !== null && clipped ? <ScrollForMore /> : null}
    </div>
  );
}

/** The first card as drawn: the first child with a box, looking inside a wrapper with `display: contents`, as the rolls' is. */
function firstCard(cards: HTMLElement): HTMLElement | null {
  for (const child of cards.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (getComputedStyle(child).display === "contents") {
      const inner = firstCard(child);
      if (inner) return inner;
      continue;
    }
    if (child.getBoundingClientRect().height > 0) return child;
  }
  return null;
}

/** The first card's height as drawn (firstCard). */
function firstCardHeight(cards: HTMLElement): number {
  return firstCard(cards)?.getBoundingClientRect().height ?? 0;
}

/** The alerts over the screen: their header's height, a touch target and a little, with its rule, and the padding above and below their cards. */
const OVERLAY_HEAD = theme.touch + theme.space(1) + theme.line.border;
const OVERLAY_PAD = theme.space(2);

/** Where the summary row stands against its usual place (FightAlerts `rowPlace`): how far it rose and moved left, and how far in from each edge it stops. */
type RowPlace = { lift: number; shift: number; insetLeft: number; insetRight: number };
const NOT_RAISED: RowPlace = { lift: 0, shift: 0, insetLeft: 0, insetRight: 0 };

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
 * Concentration checks, expiry notices and, for the DM, the recharge
 * prompts of a turn that starts, from the log (design 9.5 and 9.6,
 * docs/design-v1-roll-options.md 6.4). Only entries that arrive while the
 * page is open count: the log a snapshot carries is history, and the Log
 * panel shows it. Each turn start replaces the last one's recharge
 * prompts, whose moment has passed.
 */
function useLogAlerts() {
  const log = useRoomView((s) => s.view?.log);
  const roomId = useRoomView((s) => s.roomId);
  const store = useRoomStore();
  const confirmedSeq = useConfirmedSeq();
  const you = useYou();
  const facts = useRowFacts();
  const factsRef = useRef(facts);
  factsRef.current = facts;
  const seen = useRef<Set<string> | null>(null);
  const [prompts, setPrompts] = useState<ConcentrationPrompt[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [recharge, setRecharge] = useState<{ turn: RechargeTurn | null; dismissed: ReadonlySet<string> }>(NO_RECHARGE);
  const told = useRef(0);

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
    let started: { turn: RechargeTurn | null } | null = null;
    for (const entry of fresh) {
      const turnOf = you.role === "dm" ? turnStarted(entry) : null;
      if (turnOf !== null) {
        const state = store.getState().view;
        // Used is read as the turn starts: an action marked Used later waits for its next turn (6.4).
        started = { turn: state ? rechargeTurn(state, entry.id, turnOf, readUsed(roomId)) : null };
      }
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
    if (started) setRecharge(started.turn ? { turn: started.turn, dismissed: new Set() } : NO_RECHARGE);
  }, [log, confirmedSeq, you, store, roomId]);

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
    /** A card's roll that decided it, told as a notice since the card goes with it. */
    notify: (text: string) => setNotices((n) => [...n, { id: `told:${++told.current}`, text }].slice(-MAX_NOTICES)),
    recharge,
    dismissRecharge: (id: string) => setRecharge((r) => ({ ...r, dismissed: new Set([...r.dismissed, id]) })),
  };
}

const NO_RECHARGE: { turn: RechargeTurn | null; dismissed: ReadonlySet<string> } = { turn: null, dismissed: new Set() };

function seqOf(entry: LogEntry): number {
  const n = Number(entry.id.split(":")[0]);
  return Number.isFinite(n) ? n : 0;
}

/**
 * A concentration check (design 9.5, docs/design-v1-roll-options.md 6.2):
 * Passed dismisses it and Failed ends the creature's concentration, with
 * Roll beside them for whoever answers it, by the creature's preset and
 * the card's own Adv and Dis, so Bless, Bane and Exhaustion count and a
 * feature such as War Caster takes Adv. With the DC on the card the roll
 * decides it. A creature the DM runs with Legendary Resistance left waits
 * on a fail, rolled or tapped, until the DM spends a use or accepts it.
 * Without the DC the total shows and Passed or Failed decide.
 */
function ConcentrationCard(props: { prompt: ConcentrationPrompt; onDone(): void; onResult(text: string): void }) {
  const { prompt } = props;
  const dm = useYou().role === "dm";
  const actions = useRoomActions();
  const room = useRoomStore();
  const facts = useRowFacts();
  const blocked = useRollBlocked();
  const name = entryName(facts.view, prompt.target);
  const actor = entryActor(facts.view, prompt.target);
  const effects = actor?.effects ?? [];
  const spell = effects.find((e) => e.key === "concentrating")?.spell;
  const creatures = useMemo(() => [prompt.target], [prompt.target]);
  const { dice, failed } = useDiceView(creatures);
  const rolls = dice ? creatureRolls(dice, prompt.target) : null;
  const bonus = rolls?.numbers ? bonusFor(rolls.numbers, CONCENTRATION_TEST) : null;
  const preset = dice && rolls ? presetFor(dice, prompt.target, CONCENTRATION_TEST, { rolls }) : null;
  // Only the DM spends Legendary Resistance (actor.outcome is the DM's).
  const left = dm ? legendaryLeft(actor) : 0;
  const [chip, setChip] = useState<CardChip>(null);
  const [failTapped, setFailTapped] = useState(false);
  const own = useCardRoll(`concentration|${prompt.logId}`);
  const send = useCardSend<ConcentrationAction>();

  const end = () => {
    // Its effects as they stand now: a second tap, or another device, may have ended it already.
    const now = room.getState().view;
    const current = now ? (entryActor(now, prompt.target)?.effects ?? []) : effects;
    send.send("fail", endConcentrationOps(prompt.target, current));
    props.onDone();
  };
  useActOnce(own.tag, own.rolls, (landed) => {
    const total = landed[0]?.total;
    if (total === undefined || prompt.dc === undefined) return;
    const decided = total >= prompt.dc ? "pass" : left === 0 ? "fail" : null;
    if (decided === null) return;
    // The card goes as the roll decides it, so its result stays a moment as a notice.
    props.onResult(concentrationWords(name, total, decided));
    if (decided === "pass") props.onDone();
    else end();
  });

  const model = concentrationCard({ dc: prompt.dc, bonus, loading: !failed && rolls === null, preset, legendaryLeft: left, failTapped, rolled: own.rolls[0]?.total ?? null });
  const trouble = rollTrouble(own.receipt, own.unsent);
  const tap = (action: ConcentrationAction) => {
    switch (action) {
      case "roll":
        if (bonus !== null && preset) {
          const state = room.getState().view;
          if (state) own.roll([cardRoll(prompt.target, bonus, preset, CONCENTRATION_TEST, chip)], concentrationRollTo(state, dm, prompt));
        }
        return;
      case "pass":
        props.onDone();
        return;
      case "fail":
        if (left > 0) setFailTapped(true);
        else end();
        return;
      case "resist":
        if (send.send("resist", [concentrationResistOp(prompt.target, actions.newId())])) props.onDone();
        return;
      case "accept":
        end();
        return;
    }
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
      {model.status || trouble ? (
        <div role="status" style={{ display: "grid", gap: theme.space(1), fontSize: theme.font.body14 }}>
          {model.status ? <span>{model.status}</span> : null}
          {trouble ? <span style={{ color: own.receipt?.state === "refused" ? theme.color.dangerText : theme.color.textMuted }}>{trouble}</span> : null}
        </div>
      ) : null}
      {model.rollNote ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{model.rollNote}</div> : null}
      {model.buttons.some((b) => b.action === "roll") ? <CardChips chip={chip} onChange={setChip} name={name} /> : null}
      <CardButtons buttons={model.buttons} busy={send.busy} rollBusy={own.waiting || model.rollLoading} blocked={blocked} onTap={tap} />
    </section>
  );
}
