import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Effect, RollRequest, RollTarget, RoomState } from "#shared/model.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { bonusFor, testOf } from "#shared/dice/bonus.ts";
import { rollReminders } from "#shared/rules/rollReminders.ts";
import { choiceText } from "#shared/rules/skills.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import { Button } from "../../components/Button.tsx";
import { Chip } from "../../components/Chip.tsx";
import { Menu } from "../../components/Menu.tsx";
import { Popover, usePopover } from "../../components/Popover.tsx";
import { MarkedText, ProficiencyLabel, spokenProficiency, spokenText } from "../../components/ProficiencyMark.tsx";
import type { Rect } from "../../components/popoverPlace.ts";
import { popoverSlot } from "../../components/popoverRules.ts";
import { Input } from "../../components/Field.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { SheetGrabber, useGrabberRoom } from "../../components/SheetGrabber.tsx";
import { dockSummaryButton, RETURN_RANK, sheetFocusSlot, useAlertsSummary, useSheetReturnFocus } from "../../components/sheetFocus.ts";
import { useBackClose } from "../../lib/backClose.ts";
import { bodyHoldsField, useFieldInView, useKeyboardView, useTypingWithin } from "../../lib/keyboardInset.ts";
import { displayName } from "../../lib/scene.ts";
import { GRAB_ATTR, GRAB_STYLE, useSheetSwipe } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { revealAndFocus } from "../../lib/reveal.ts";
import { useStore } from "zustand";
import { barDockSlot, placedChrome, stripSqueezed, type CardAt } from "../../canvas/barDock.ts";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { useScoped } from "../../state/scope.ts";
import { sheetOpen, type OpAnswer, type OpRefusal } from "../../state/types.ts";
import { playersTypeTotals } from "#shared/permissions.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { creatureProficiency, creatureRolls } from "../dice/creature.ts";
import { presetFor } from "../dice/presets.ts";
import { findMarks, marksTest } from "../dice/proficiencyPresentation.ts";
import { NEEDS_CONNECTION, sendRoll, useRollSender } from "../dice/send.ts";
import { useRollModeMenu } from "../dice/useRollModeMenu.tsx";
import type { RollModeOverride } from "../dice/rollMode.ts";
import { useRollBlocked } from "../dice/useRollOption.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useProficiency } from "../dice/useProficiency.ts";
import { refusalWords } from "../dice/useReceipt.ts";
import { useOpenPcStats } from "../pcstats/open.ts";
import { editsPcStats } from "../tokens/access.ts";
import { announceTurn } from "../encounter/alerts.ts";
import { chromeZoom, screenHeight, smallUi, useLayoutSize } from "../device/layout.ts";
import { uiScale, useUiScale } from "../device/settings.ts";
import { askedText, askItems, askKept, bestChoice, cardRoll, choiceLabel, KEPT, naturalText, normalResult, requestRollSource, rolledText, RollResultLine, parseBonus, rolledDice, rolledNews, verdictText, type AskItem, type RollInputs } from "./card.ts";
import {
  answered,
  answerFlow,
  answerKey,
  answerLabel,
  answerOffers,
  IDLE,
  landingOf,
  type AnswerEvent,
  type AnswerFlow,
  type AnswerOffers,
  type AnswerOp,
  askLine,
  CARD_MIN_WIDTH,
  cardFoldsUnderSheet,
  chipLine,
  chipName,
  chipStack,
  chipsStayShown,
  deskLayout,
  draftKey,
  finalAnswerText,
  finalForPlayer,
  foldedChips,
  foldsAfterSend,
  forgetStaleDrafts,
  keepFocusFor,
  lookAtRequests,
  newestFirst,
  parseTotal,
  PHONE_CHIPS,
  playerNeedsAnswer,
  requestToOpen,
  rollsSummary,
  sheetSummary,
  shownRequest,
  startingAnswer,
  targetKey,
  targetRef,
  type AnswerDraft,
} from "./logic.ts";
import { answerChoiceMarks, requestMarks, rowTest, type LevelOf } from "./marks.ts";
import { cardStyle, focusable } from "./parts.tsx";

const NO_ROLLS = {};

/** What a summary activation focuses once the sheet has closed: a request's card, or the newest chip when no card opens. */
type FocusAfter = { card: string } | { chip: true };

/** What a card at the screen's foot must show, in its own pixels (RollCard onMeasure). */
type FootNeed = {
  /** Its header and everything down to its first answer row: the creature's name, the choice, the reminders, the total and Send. */
  whole: number;
  /** Its header and its first answer row alone, scrolled to sit under the header as it sticks. */
  least: number;
};

/**
 * What a card at the screen's foot needs before it has been measured: its
 * padding, a header of two lines beside Later, and one answer row.
 * Measured from then on.
 */
const FOOT_NEED_ESTIMATE: FootNeed = { whole: 134, least: 106 };

/** What a card at the screen's foot stands on, and how high it may reach (RollCard `stand`). */
type FootStand = "options" | "toolbar" | "screen";

/**
 * A player's side of request a roll (docs/design-v1-dm-tools.md 3.3). A
 * request for one of their creatures comes up as a card, a bottom sheet on
 * a phone and a card in the fight alerts column from 600 px up, with a
 * vibration on Android and the turn chime when sound is on. After Send it
 * folds into a chip in the column, and the map is clear again. A tap on
 * the chip opens the card to change the answer, unless the answer is
 * final. Their projection holds only their own targets, so nothing here
 * can show another player's answer, a hidden DC or a hidden result.
 *
 * The card is the prompt, but it never covers an open sheet
 * (docs/design-v1-visual.md 3.3.1): under one it folds, mounted but
 * hidden so what was typed survives, and with the chips it becomes one
 * summary whose tap closes the sheet and opens the request to answer. A
 * card at a narrow screen's foot folds the same way while a popover of the
 * tool's options is open, since that popover rises from the row the card
 * stands on and the card stands over popovers (docs/design-v1-tool-options.md 7.6).
 */
export function PlayerRolls() {
  const rolls = useRoomView((s) => s.view?.rolls ?? NO_ROLLS);
  const requests = useMemo(() => newestFirst(rolls), [rolls]);
  // The layout size at the interface size, as the room lays out (docs/design-v1-dm-tools.md 3.16).
  const size = useLayoutSize();
  const width = size.width;
  const ui = useRoomUi();
  const covered = useRoomView((s) => sheetOpen(s.local));
  // Folded by Send or Later. The card shown is the one tapped open or being answered, else the newest that still needs an answer.
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [opened, setOpened] = useState<string | null>(null);
  // Whether a phone shows the chips past the first two (chipStack).
  const [expanded, setExpanded] = useState(false);
  const [focusAfter, setFocusAfter] = useState<FocusAfter | null>(null);
  const needs = useMemo(() => new Map(requests.map((r) => [r.id, playerNeedsAnswer(r)])), [requests]);
  const before = useRef<ReadonlyMap<string, boolean> | null>(null);
  const cardRef = useRef<HTMLElement | null>(null);
  const summaryRef = useRef<HTMLButtonElement | null>(null);
  const firstChip = useRef<HTMLButtonElement | null>(null);
  // What was typed and not sent, which outlives the card: turning the phone moves the card between the screen's foot and the column.
  const drafts = useRef(new Map<string, AnswerDraft>());
  useEffect(() => forgetStaleDrafts(drafts.current, requests), [requests]);

  // A request that arrives, or one the DM reopened, comes up again (cameUp), counted from the first look with the state loaded.
  // One that arrives under a sheet comes up folded with the card, and still chimes.
  const loaded = useRoomView((s) => s.view !== null);
  useEffect(() => {
    const { seen, unfold, chime } = lookAtRequests(before.current, needs, loaded);
    before.current = seen;
    if (unfold.length === 0) return;
    setFolded((f) => new Set([...f].filter((id) => !unfold.includes(id))));
    if (chime) announceTurn();
  }, [needs, loaded]);

  const shown = shownRequest(requests, needs, folded, opened);
  useEffect(() => keepFocusFor(drafts.current, shown?.id), [shown?.id]);
  const fold = (id: string) => {
    setFolded((f) => new Set([...f, id]));
    setOpened((o) => (o === id ? null : o));
    setSummoned((r) => (r === id ? null : r));
  };
  const chips = requests.filter((r) => r.id !== shown?.id);
  /*
   * A card at a narrow screen's foot and the token action bar must never
   * cover each other (docs/design-v1-bar-dock.md, LPD-PLAYER-2). The card
   * says how tall it stands, and a docked or spanning bar keeps above it.
   * Where that leaves the bar too little room, it opens compact, and then
   * the card folds as under a sheet, with what was typed kept, and the
   * alerts column's summary row stands for it. The row's tap hides the bar
   * and opens the card.
   *
   * The card's title and Later must always show and take a tap, and the
   * Multi-select bar it stands on must stay in reach. So where the room
   * between the top bars and that bar is too short for the card's header
   * and all of it down to its first answer row (`need.whole`, measured),
   * the card folds the same way, the row standing in. The row's tap then
   * opens it (`summoned`), standing on the toolbar over the tool's options,
   * until it is answered or put off with Later. Where even that leaves too
   * little room, as at 480 x 320 at 130%, it rises over the top bars and
   * the turn band to the screen's top. Where the screen is too short for
   * the choice as well, the card opens scrolled down to its answer row
   * under the sticking header, so its question, Later, total and Send all
   * show and take a tap at once (`need.least`). Only where even that does
   * not fit does the header stop sticking and the whole card scroll, so
   * each can be read and tapped in turn.
   */
  const dockStore = useScoped(barDockSlot);
  const zoom = useUiScale();
  const compactBar = useStore(dockStore, (s) => s.bar?.mode === "compact");
  // An upright phone's strip held open, shown or hidden for a drag: a card that would take the free area under 148 folds for it (docs/design-v1-bar-compact.md 3.2, review BC-OPUS-21).
  const heldStrip = useStore(dockStore, (s) => s.heldMode === "span" && s.barOpen);
  const footHeight = useStore(dockStore, (s) => s.foot);
  const chrome = useStore(dockStore, (s) => s.chrome);
  const [need, setNeed] = useState(FOOT_NEED_ESTIMATE);
  const measured = useCallback((next: FootNeed) => setNeed((n) => (n.whole === next.whole && n.least === next.least ? n : next)), []);
  const [summoned, setSummoned] = useState<string | null>(null);
  const atFoot = shown !== undefined && width < CARD_MIN_WIDTH;
  /*
   * Where it stands and whether it yields, from the chrome as it stands
   * without the on-screen keyboard (barDock.ts Typing), and held as they
   * were while someone types in the card: a keyboard that left the card
   * too little room would fold it away with its Total in focus, and a page
   * a browser shrinks for its keyboard would too (docs/design.md 14.4).
   */
  const typingHere = useTypingWithin(cardRef);
  const room = chrome ? size.height - chrome.top - chrome.bottom : Infinity;
  const tooShort = atFoot && room < need.whole;
  const onToolbar = tooShort && summoned === shown?.id;
  const squeezed = chrome !== null && stripSqueezed({ viewport: size, chrome, foot: footHeight, held: heldStrip });
  const toolbarRoom = chrome ? size.height - chrome.top - chrome.toolbar : Infinity;
  const screenRoom = chrome ? size.height - chrome.safe.top - chrome.toolbar : Infinity;
  const decided = {
    yieldsToBar: atFoot && (compactBar || (tooShort && !onToolbar) || squeezed),
    stand: (!onToolbar ? "options" : toolbarRoom >= need.whole ? "toolbar" : "screen") as FootStand,
    sticky: !onToolbar || toolbarRoom >= need.whole || screenRoom >= need.least,
  };
  const kept = useRef(decided);
  if (!typingHere) kept.current = decided;
  const { yieldsToBar, stand } = kept.current;
  const stickyHeader = kept.current.sticky;
  useLayoutEffect(() => {
    dockStore.setState({ footYields: yieldsToBar });
  }, [dockStore, yieldsToBar]);
  // Where the card stands, for the bar's opening rule (barDock.ts openMode, review BAR-ASTRA-10): standing or folded at the foot, or summoned onto the toolbar or the screen.
  const cardAt: CardAt = !atFoot ? null : !onToolbar ? "foot" : stand === "screen" ? "screen" : "toolbar";
  useLayoutEffect(() => {
    if (dockStore.getState().cardAt !== cardAt) dockStore.setState({ cardAt });
  }, [dockStore, cardAt]);
  // Asked for in the alerts column, by its chip or a summary, the card must show whole there or over the screen (InitiativeStrip.tsx FightAlerts).
  const columnRollAsked = shown !== undefined && summoned === shown.id && width >= CARD_MIN_WIDTH;
  useLayoutEffect(() => {
    if (dockStore.getState().columnRollAsked !== columnRollAsked) dockStore.setState({ columnRollAsked });
  }, [dockStore, columnRollAsked]);
  useLayoutEffect(() => () => dockStore.setState({ columnRollAsked: false }), [dockStore]);
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!atFoot || !el) {
      if (dockStore.getState().foot !== 0) dockStore.setState({ foot: 0 });
      return;
    }
    // Folded, the card has no height: it keeps the last it had, so folding it never moves the bar.
    const measure = () => {
      const height = el.getBoundingClientRect().height / zoom;
      if (height > 0 && dockStore.getState().foot !== height) dockStore.setState({ foot: height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [dockStore, atFoot, zoom, shown?.id]);
  useLayoutEffect(() => () => dockStore.setState({ foot: 0, footYields: false, cardAt: null }), [dockStore]);
  const foldsUnderSheet = cardFoldsUnderSheet({ width, height: size.height, wideMinWidth: theme.layout.wideMinWidth });
  const toolPopover = useStore(dockStore, (s) => s.toolPopover);
  const foldedBySheet = covered && foldsUnderSheet;
  // A card already folded for the token bar or a short screen has its own summary row, so a popover leaves it as it is.
  const underPopover = atFoot && toolPopover && !foldedBySheet && !yieldsToBar;
  // Never while someone types in it (typingHere above).
  const cardHidden = shown !== undefined && !typingHere && (foldedBySheet || underPopover);
  // As the DM's cards do: the column sits above a phone's sheets in portrait, so everything folds into one summary
  // while one is open. A card folded under a sheet in landscape, or under a popover of the tool's options, takes the chips with it into the same summary.
  const underSheet = deskLayout({ width, height: size.height, wideMinWidth: theme.layout.wideMinWidth, sheetOpen: covered }).folded || cardHidden;
  const stack = chipStack({ count: chips.length + (cardHidden ? 1 : 0), phone: width < theme.layout.wideMinWidth, underSheet, expanded });
  const keepShown = chipsStayShown(requests.length);
  useEffect(() => {
    if (!keepShown) setExpanded(false);
  }, [keepShown]);

  /*
   * The one way a card is asked for, by a summary or a chip. Asked from
   * the alerts column, by its summary row or a chip, the token bar steps
   * aside first, keeping its token or group (`barAway`), since a compact
   * bar keeps a card at a phone's foot folded (`yieldsToBar`) and a card
   * asked for must show at once. The dock's summary leaves the bar as it
   * was: closing the sheet brings it back. Asked for, the card shows even
   * where it is too tall to stand on the tool's options (`onToolbar`).
   */
  const summon = (id: string, barAway: boolean) => {
    if (barAway) ui.showActions(false);
    setSummoned(id);
    setFocusAfter({ card: id });
  };

  /*
   * Activating the summary, here or in the dock (3.2.1), is a request to
   * answer: the sheets close and the card to answer takes focus. A card
   * already mounted under the sheet wins, so an unsent total is never
   * dropped, and only with none does the newest waiting request come back
   * from Later, as a chip's tap brings it (requestToOpen). Focus moves
   * once the card has unfolded, in the effect after.
   */
  const popovers = useScoped(popoverSlot);
  const open = (options?: { barAway?: boolean }) => {
    const target = requestToOpen(requests, needs, folded, opened);
    ui.closeSheets();
    // A press on the summary closes the tool's popover as it starts, as any press outside it does, and the card unfolds
    // with it. A click alone, as a screen reader's, reaches here with the popover still open.
    if (underPopover) popovers.closeOpen("press");
    if (!target) {
      setSummoned(null);
      setFocusAfter({ chip: true });
      return;
    }
    if (!target.mounted) setOpened(target.id);
    summon(target.id, options?.barAway === true);
  };
  // A chip's tap asks for its card as the Roll asked row does, and takes focus from the chip, which goes as it opens.
  const openChip = (id: string) => {
    setOpened(id);
    summon(id, true);
  };
  useEffect(() => {
    if (!focusAfter) return;
    if ("card" in focusAfter) {
      // A request the DM closed meanwhile leaves nothing to show.
      if (shown?.id === focusAfter.card) {
        if (cardHidden || yieldsToBar) return;
        // In the alerts column, which scrolls as a whole, the card may have scrolled out of sight.
        revealAndFocus(cardRef.current);
      }
    } else {
      if (underSheet) return;
      revealAndFocus(firstChip.current);
    }
    setFocusAfter(null);
  }, [focusAfter, shown?.id, cardHidden, yieldsToBar, underSheet]);

  // The rolls' part of the dock's alerts summary, which the dock shows while a portrait sheet folds the column (3.2.1).
  // It names the request its tap opens, as this stack's own summary does.
  const opens = requestToOpen(requests, needs, folded, opened)?.id ?? null;
  const published = requests.length > 0 ? rollsSummary(requests, opens) : null;
  const drawnIds = [...(shown && width >= CARD_MIN_WIDTH && !cardHidden && !yieldsToBar ? [`roll:${shown.id}`] : []), ...chips.slice(0, stack.shown).map((r) => `chip:${r.id}`), ...(stack.button ? ["rolls:summary"] : [])];
  useAlertsSummary(published ? { ...published, requests: requests.length, drawnIds, open } : null);

  // The card is the first place focus returns to once a sheet that was hiding it closes (3.2.1). A request put off with Later has no card, so it is never a target.
  useSheetReturnFocus(cardRef, RETURN_RANK.rollCard, shown !== undefined && foldsUnderSheet);

  // Focus inside the card when it folds moves to the summary that stands for it (3.3.1): this stack's own, or the dock's that Room publishes.
  const focusInCard = useRef(false);
  const sheetFocus = useScoped(sheetFocusSlot);
  useLayoutEffect(() => {
    if (!cardHidden || !focusInCard.current) return;
    focusInCard.current = false;
    revealAndFocus(focusable(summaryRef.current) ? summaryRef.current : dockSummaryButton(sheetFocus));
  }, [cardHidden, sheetFocus]);

  const summary = stack.button === "sheet" ? sheetSummary(requests, opens, underPopover ? "popover" : "sheet") : stack.button ? foldedChips(chips.slice(PHONE_CHIPS), stack.button) : null;
  const tapSummary = () => {
    if (stack.button === "sheet") open();
    else setExpanded(stack.button === "more");
  };
  const summaryButton = summary ? (
    <Button
      ref={summaryRef}
      size="sm"
      aria-label={summary.label}
      title={summary.label}
      onClick={tapSummary}
      // Showing and folding the chips past the first two is a disclosure. The sheet's kind closes the sheet instead, so it has none.
      expanded={stack.button === "sheet" ? undefined : stack.button === "less"}
      style={{ pointerEvents: "auto", boxShadow: theme.shadow.float, fontVariantNumeric: "tabular-nums" }}
    >
      {summary.text}
    </Button>
  ) : null;

  const card = shown ? (
    <RollCard
      key={shown.id}
      cardRef={cardRef}
      request={shown}
      drafts={drafts.current}
      sheet={width < CARD_MIN_WIDTH}
      hidden={cardHidden || yieldsToBar}
      stand={stand}
      stickyHeader={stickyHeader}
      whole={need.whole}
      onMeasure={measured}
      onFold={() => fold(shown.id)}
      onEngage={() => setOpened(shown.id)}
      onFocusWithin={(inside) => {
        focusInCard.current = inside;
      }}
    />
  ) : null;
  return (
    <>
      {card && width >= CARD_MIN_WIDTH ? card : null}
      {stack.shown === 0 ? (
        summaryButton
      ) : (
        <div
          data-alert-stack=""
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: theme.space(2),
            pointerEvents: "auto",
          }}
        >
          {chips.slice(0, stack.shown).map((r, i) => (
            <RollChip key={r.id} buttonRef={i === 0 ? firstChip : undefined} request={r} onOpen={() => openChip(r.id)} />
          ))}
          {summaryButton}
        </div>
      )}
      {card && width < CARD_MIN_WIDTH ? createPortal(card, document.body) : null}
    </>
  );
}

/**
 * The creature a target names, as this player's view holds it: its name,
 * the effects its reminders read, and the character with no stat block
 * yet, whose card offers "Add a stat block" (docs/design-v1-roll-request.md 5.2).
 */
function useCreature(target: RollTarget): { name: string; effects: readonly Effect[]; noBlock: string | null } {
  const token = useRoomView((s) => (target.tokenId !== undefined ? s.view?.tokens[target.tokenId] : undefined));
  const characterId = target.characterId ?? (token && "ref" in token.actor ? token.actor.ref : undefined);
  const character = useRoomView((s) => (characterId !== undefined ? s.view?.characters[characterId] : undefined));
  const you = useRoomView((s) => s.you);
  const name = token ? displayName(token) : (character?.name ?? "Your creature");
  const effects = token && "inline" in token.actor ? token.actor.inline.effects : (character?.actor.effects ?? []);
  // Only a character the player owns offers its editor: a lent NPC's token is theirs to roll for, not to change.
  return { name, effects, noBlock: character && character.stats === undefined && editsPcStats(you, character) ? character.id : null };
}

export function RollCard(props: {
  cardRef: RefObject<HTMLElement | null>;
  request: RollRequest;
  drafts: Map<string, AnswerDraft>;
  sheet: boolean;
  /** Folded under a sheet: still mounted, so a typed total and a chosen roll survive, but out of sight, the focus order and the accessibility tree. */
  hidden: boolean;
  /**
   * At the screen's foot, what it stands on and how high it may reach: on
   * the active tool's options under the top bars, on the toolbar under
   * them once the viewer asked for it on a screen too short for both, or
   * on the toolbar up to the screen's top where even that is too short.
   */
  stand: FootStand;
  /** The header sticks to the card's top while the card has room for it and an answer row under it. */
  stickyHeader: boolean;
  /** At the screen's foot, all it needs to show down to its answer block (FootNeed `whole`), in its own pixels. */
  whole: number;
  /** At the screen's foot, how tall it must stand to show what matters (FootNeed). */
  onMeasure(need: FootNeed): void;
  onFold(): void;
  /** The first keystroke or roll choice: the card then stays up when a newer request arrives. */
  onEngage(): void;
  onFocusWithin(inside: boolean): void;
}) {
  const { request } = props;
  const levelOf = useProficiency();
  const zoom = useUiScale();
  // The toolbar and the active tool's options as Room measured them (canvas/barDock.ts Chrome), in the card's own pixels, lifted onto the on-screen keyboard while someone types (placedChrome).
  const measured = useStore(useScoped(barDockSlot), (s) => s.chrome);
  const typing = useStore(useScoped(barDockSlot), (s) => s.typing);
  /*
   * Where what shows over the keyboard is too short for its total and Send
   * under its header, as at 320 x 568 at 130% in a fight over a 300 px
   * keyboard, the card first rises over the bars, then its header stops
   * sticking: one step at a time, each once the card has laid out, held
   * until the keyboard closes so nothing moves under a finger on its way to
   * Send. 0 is neither, 1 over the bars, 2 over the bars and unstuck.
   */
  const [cramped, setCramped] = useState(0);
  const chrome = useMemo(() => (measured ? placedChrome(measured, typing, cramped > 0) : null), [measured, typing, cramped]);
  // Only while it shows, so a card folded under a sheet, or one that arrived there, never takes Back from the sheet.
  useBackClose(props.sheet && !props.hidden, props.onFold);
  // At the screen's foot a swipe down puts it off as Later does, with what was typed kept, so unsaved input never holds it (docs/design-v1-sheet-swipe.md section 3).
  useSheetSwipe(props.cardRef, { enabled: props.sheet && !props.hidden, onClose: props.onFold, item: props.request.id, clip: "screen", keeps: true });
  // At the foot it stands on the on-screen keyboard (placedChrome above), and its total shows with Send.
  const view = useKeyboardView();
  useFieldInView(props.cardRef, useMemo(() => ({ view, cramped }), [view, cramped]), theme.space(2));
  /*
   * A roll that lands while the card shows, from its Roll or from the Dice
   * panel, is news to the player, so the card shows its result in place
   * and stays up until Done (docs/design-v1-roll-request.md 5.4). Each
   * target's answer is remembered as the card first saw it, so a rolled
   * answer it opened on is no news.
   */
  const seen = useRef<Map<string, string | undefined> | null>(null);
  const focusedAnswer = useRef<{ key: string; node: HTMLElement } | null>(null);
  const [rolledHere, setRolledHere] = useState<ReadonlySet<string>>(() => new Set());
  const [news, setNews] = useState("");
  const headerButton = useRef<HTMLButtonElement>(null);
  const names = useRoomView((s) => (s.view ? request.targets.map((t) => creatureName(s.view!, t)).join("|") : ""));
  const { onEngage } = props;
  useEffect(() => {
    const before = seen.current;
    seen.current = new Map(request.targets.map((t) => [targetKey(t), t.tag]));
    if (!before) return;
    const landed = request.targets.filter((t) => t.dice !== undefined && before.has(targetKey(t)) && before.get(targetKey(t)) !== t.tag);
    if (landed.length === 0) return;
    setRolledHere((r) => new Set([...r, ...landed.map(targetKey)]));
    const list = names.split("|");
    setNews(landed.map((t) => rolledNews(list[request.targets.indexOf(t)] || "Your creature", t)).join(" "));
    onEngage();
    // A sibling's result must leave an unchanged row's control or open menu focused.
    const card = props.cardRef.current;
    const active = document.activeElement;
    const prior = focusedAnswer.current;
    const leftRow = prior && !prior.node.isConnected && landed.some((target) => targetKey(target) === prior.key);
    if (card && (active === null || active === document.body || leftRow && (active === card || active === prior.node))) headerButton.current?.focus();
  }, [request.targets, names, onEngage, props.cardRef]);
  const sent = (key: string) => {
    if (foldsAfterSend(request, key, rolledHere)) props.onFold();
  };
  const done = request.targets.every(answered);
  const question = askLine(request);
  /*
   * At the screen's foot the card's header (what to roll, and Later) sticks
   * to its top on an opaque fill, so it shows whatever scrolls under it,
   * and the card reports how tall it must stand (FootNeed), which
   * PlayerRolls folds it, raises it and unsticks the header by.
   */
  const headerRef = useRef<HTMLDivElement>(null);
  /*
   * The header at a phone's foot pads its content the grabber's room above
   * and, once its fill sticks, the same below, so its question and Later
   * stand in the middle of the fill that covers what scrolls under it.
   */
  const headerPad = useGrabberRoom();
  const { onMeasure, request: shownRequest } = props;
  const sticks = props.sheet && props.stickyHeader && cramped < 2;
  // A header that sticks covers the card's top: the field keepers keep a field below it (lib/keyboardInset.ts reads the scroll padding).
  useLayoutEffect(() => {
    const card = props.cardRef.current;
    if (card) card.style.scrollPaddingTop = sticks && headerRef.current ? `${headerRef.current.offsetHeight}px` : "";
  });
  useLayoutEffect(() => {
    if (typing === null) setCramped(0);
    else if (props.sheet && !props.hidden && cramped < 2 && props.cardRef.current && bodyHoldsField(props.cardRef.current, theme.space(2)) === false) setCramped(cramped + 1);
  });
  useLayoutEffect(() => {
    const card = props.cardRef.current;
    const header = headerRef.current;
    if (!props.sheet || !card || !header) return;
    const measure = () => {
      // Folded, the card has no size: the last measures stand.
      if (card.offsetHeight === 0) return;
      // Measured as a sticking header stands, its fill taking in the card's top padding, which every header at the foot reaches over, and as much under it, so whether it sticks never changes the answer.
      const lift = sticks ? 0 : headerPad;
      const head = header.offsetHeight + lift;
      const edges = 2 * theme.line.border;
      // The answer block (5.7): from "Fail (Stunned)" or the roll row down to the total and Send.
      const row = card.querySelector<HTMLElement>("[data-answer]");
      if (!row) {
        const whole = edges + head + theme.space(4);
        onMeasure({ whole, least: whole });
        return;
      }
      // The row's offset in the card takes in all that stands above it: the header, the creature's name, the choice and the reminders.
      onMeasure({ whole: edges + row.offsetTop + lift + row.offsetHeight + theme.space(4), least: edges + head + row.offsetHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(card);
    // Capped, the card keeps its size as a choice brings reminders over the row, so its parts are watched too. A sent total remounts them, and the changed request watches the new ones.
    for (const part of card.children) observer.observe(part);
    return () => observer.disconnect();
  }, [props.sheet, props.cardRef, onMeasure, sticks, shownRequest, headerPad]);
  /*
   * Shown where it is too short for all of it, the card scrolls to show its
   * answer block whole under the header as it sticks. Where the block is
   * taller than that room, its top wins: Roll, Adv and Dis stay in sight
   * first and the total follows a scroll, since Roll is the card's primary
   * (docs/design-v1-roll-request.md 5.2). A scroll left from an earlier,
   * smaller stand never keeps the block's top under the header.
   */
  useLayoutEffect(() => {
    const card = props.cardRef.current;
    const row = card?.querySelector<HTMLElement>("[data-answer]");
    const header = headerRef.current;
    if (!props.sheet || props.hidden || !card || !row) return;
    // How much of the card's top the header covers once it sticks: all of it, from the card's top edge (its `top` takes back the padding).
    const cover = sticks && header ? header.offsetHeight : 0;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    let next = card.scrollTop;
    if (bottom > next + card.clientHeight) next = bottom - card.clientHeight;
    if (top - cover < next) next = top - cover;
    card.scrollTop = Math.max(0, next);
  }, [props.sheet, props.hidden, props.stand, props.cardRef, sticks, props.whole]);
  const body = (
    <>
      <div
        ref={headerRef}
        {...(props.sheet ? { [GRAB_ATTR]: "" } : {})}
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: theme.space(2),
          // At the foot it reaches over the card's top padding, taken back from its margin, so the grabber drawn there is on the grab area, stuck or not. Its content stands the grabber's room under the card's top edge, as a sheet header's buttons do.
          ...(props.sheet ? { ...GRAB_STYLE, position: "relative", margin: `-${theme.space(4)}px 0 0`, padding: `${headerPad}px 0 0` } : null),
          ...(sticks
            ? {
                position: "sticky",
                // A sticky box keeps inside its scroller's padding, so at 0 the header stood a padding's height below its place and its fill covered the top of the row under it.
                top: -theme.space(4),
                zIndex: 1,
                // The card's top and side padding, taken back so the fill covers what scrolls under it. The fill pads its content the same above and below.
                margin: `-${theme.space(4)}px calc(-1 * (${theme.safe.right} + ${theme.space(4)}px)) 0 calc(-1 * (${theme.safe.left} + ${theme.space(4)}px))`,
                padding: `${headerPad}px calc(${theme.safe.right} + ${theme.space(4)}px) ${headerPad}px calc(${theme.safe.left} + ${theme.space(4)}px)`,
                background: theme.color.surface,
              }
            : null),
        }}
      >
        {/* In the header's top padding, the grabber's room. */}
        {props.sheet ? <SheetGrabber /> : null}
        {/* Set down so its first line's middle meets Later's, as a checkbox meets its label's first line (docs/design-v1-polish.md R1): a question on several lines starts beside Later rather than centering on it. */}
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5), paddingTop: QUESTION_DROP }}>
          {/* The DC joins the question's line (5.1), one line less on every card. */}
          <div style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>
            <MarkedText text={question} marks={request.targets.length === 1 ? requestMarks(question, request, request.targets[0]!, levelOf, { from: "The DM asks for ".length }) : []} />
          </div>
        </div>
        {done ? (
          <Button ref={headerButton} size="sm" aria-label="Done, fold it into a chip" title="Done, fold it into a chip" onClick={props.onFold}>
            Done
          </Button>
        ) : (
          <Button ref={headerButton} size="sm" aria-label="Fold it into a chip, to answer later" title="Fold it into a chip, to answer later" onClick={props.onFold}>
            Later
          </Button>
        )}
      </div>
      {request.targets.map((target) => (
        // Keyed by the total too, so an answer sent from this player's other device fills the field here.
        <CreatureAnswer
          key={`${targetKey(target)}:${target.total ?? ""}`}
          request={request}
          target={target}
          drafts={props.drafts}
          several={request.targets.length > 1}
          onEngage={props.onEngage}
          onSent={() => sent(targetKey(target))}
        />
      ))}
      <div role="status" aria-live="polite" style={VISUALLY_HIDDEN}>
        {news}
      </div>
    </>
  );
  // The dialog itself takes focus when the summary opens it: it reads its request and opens no keyboard.
  const common = {
    ref: props.cardRef as Ref<HTMLElement>,
    role: "dialog",
    "aria-label": "The DM asks for a roll",
    tabIndex: -1,
    hidden: props.hidden,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      const key = e.target.closest<HTMLElement>("[data-roll-answer-row]")?.dataset.rollAnswerRow;
      if (key) focusedAnswer.current = { key, node: e.target };
      props.onFocusWithin(true);
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onFocusWithin(false);
    },
  };
  if (!props.sheet) {
    return (
      <section {...common} style={{ ...cardStyle, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14 }}>
        {body}
      </section>
    );
  }
  // Portaled out of the zoomed room, so it takes the interface size itself, as Sheet does: its bottom inset
  // and text then scale with the toolbar it stands on (docs/design-v1-dm-tools.md 3.16). It stands on the
  // active tool's options too, once Room has measured them, so Multi-select's Actions and Done stay in reach.
  return (
    <section
      {...common}
      {...smallUi(zoom)}
      style={{
        ...chromeZoom(zoom),
        position: "fixed",
        left: 0,
        right: 0,
        // Cramped over the keyboard, whatever its stand, it stands on the visible area's foot (placedChrome's `bottom` then), over the toolbar where the page still shows it.
        bottom: chrome ? (cramped > 0 || props.stand === "options" ? chrome.bottom : chrome.toolbar) : `calc(${theme.safe.bottom} + ${theme.layout.toolbar}px)`,
        zIndex: theme.z.overBars,
        // At most 70% of the screen, and never past the top bars: standing on the options bar of a short phone, 70% reached above the screen and took the card's Later with it. What does not fit scrolls. Asked for where even the toolbar leaves too little, it may reach the screen's top. Cramped, all of the visible area.
        maxHeight: !chrome
          ? `min(${screenHeight(70)}, calc(${screenHeight(100)} - ${theme.safe.top} - ${theme.safe.bottom} - ${theme.layout.topBar + theme.layout.toolbar}px))`
          : cramped > 0
            ? `calc(${screenHeight(100)} - ${chrome.top + chrome.bottom}px)`
            : props.stand === "screen"
              ? `calc(${screenHeight(100)} - ${chrome.safe.top + chrome.toolbar}px)`
              : // 70% of the screen, or all it needs where its stand was chosen for having that room (PlayerRolls `tooShort`), so it never scrolls there.
                `min(max(${screenHeight(70)}, ${props.whole}px), calc(${screenHeight(100)} - ${chrome.top + (props.stand === "options" ? chrome.bottom : chrome.toolbar)}px))`,
        overflowY: "auto",
        overscrollBehavior: "contain",
        display: "grid",
        gridTemplateColumns: "minmax(0, 1fr)",
        gap: theme.space(3),
        padding: `${theme.space(4)}px calc(${theme.safe.right} + ${theme.space(4)}px) ${theme.space(4)}px calc(${theme.safe.left} + ${theme.space(4)}px)`,
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: `${theme.radius.lg}px ${theme.radius.lg}px 0 0`,
        boxShadow: theme.shadow.sheet,
        color: theme.color.text,
        fontFamily: theme.font.body,
        fontSize: theme.font.body14,
      }}
    >
      {body}
    </section>
  );
}

/**
 * One creature's answer (docs/design-v1-roll-request.md 5): which choice it
 * rolls when there are two, the reminders its conditions and statuses give,
 * and one answer path at a time. While the creature waits, Roll rolls on the
 * server with its bonus, or one the player types, the presets and the
 * player's Adv, Dis and extra dice read at the tap. Or the player types the
 * total and taps Send, and on a save may fail without rolling, or fail by a
 * condition first. A rolled answer shows in place, final. Every op waits for
 * the server, since a player's view of a request lacks what the reducer
 * reads, and its own answer alone ends the busy state (answerFlow).
 */
function CreatureAnswer(props: {
  request: RollRequest;
  target: RollTarget;
  drafts: Map<string, AnswerDraft>;
  several: boolean;
  onEngage(): void;
  onSent(): void;
}) {
  const { request, target, drafts } = props;
  const actions = useRoomActions();
  const store = useRoomStore();
  const sender = useRollSender();
  const openStats = useOpenPcStats();
  const { name, effects, noBlock } = useCreature(target);
  const tkey = targetKey(target);
  const ref = useMemo(() => targetRef({ tokenId: target.tokenId, characterId: target.characterId }), [target.tokenId, target.characterId]);
  const creatures = useMemo(() => [ref], [ref]);
  const { dice } = useDiceView(creatures);
  const rolls = dice ? creatureRolls(dice, ref) : null;
  const levelOf: LevelOf = (creature, test) => (dice ? creatureProficiency(dice, creature, test) : "none");
  const two = request.test.choices.length > 1;
  const bonuses = request.test.choices.map((_, i) => (rolls?.numbers ? bonusFor(rolls.numbers, testOf(request, i)) : null));
  const key = draftKey(request.id, target);
  const [start] = useState(() => startingAnswer(target, drafts.get(key), bestChoice(bonuses)));
  const [choice, setChoice] = useState<0 | 1>(start.choice);
  const [text, setText] = useState(start.text);
  const [inputs, setInputs] = useState<RollInputs>(start.inputs);
  const keep = (draft: { text?: string; choice?: 0 | 1; focused?: boolean; inputs?: RollInputs }) =>
    drafts.set(key, { text, choice, inputs, focused: drafts.get(key)?.focused === true, ...draft, base: answerKey(target) });
  const field = useRef<HTMLInputElement>(null);
  const answerRoot = useRef<HTMLDivElement>(null);
  // A card mounted afresh by turning the phone gives focus back to the field being typed in.
  useLayoutEffect(() => {
    if (start.focused) revealAndFocus(field.current);
  }, [start]);
  const connected = useRoomView((s) => s.connection === "open");
  // The flow is read and stepped at once by a tap, so a ref holds it beside the state that draws it.
  const flowRef = useRef<AnswerFlow>(IDLE);
  const [flow, setFlow] = useState<AnswerFlow>(IDLE);
  const step = (event: AnswerEvent): AnswerFlow => {
    const next = answerFlow(flowRef.current, event);
    flowRef.current = next;
    setFlow(next);
    return next;
  };
  const reminders = rollReminders(effects, request.test, two ? choice : undefined);
  const final = finalForPlayer(request, target);
  const picked = two ? choice : 0;
  const test = testOf(request, picked);
  const bonus = bonuses[picked] ?? null;
  const preset = dice ? presetFor(dice, ref, test, { rolls }) : null;
  const typeTotals = useRoomView((s) => playersTypeTotals(s.view?.meta.settings ?? {}));
  const roll = cardRoll({ bonus, preset, inputs, text, typeTotals });
  const typedBonus = parseBonus(inputs.bonus);
  const offers = answerOffers({ holds: true, request, target, text, connected, bonusReady: bonus !== null || typedBonus?.ok === true, typeTotals });
  const waiting = !answered(target) && (target.retype !== true || !typeTotals);
  const failsFirst = waiting && preset?.fails !== undefined && request.test.kind === "save" && !final;
  const busy = flow.busy?.op ?? null;
  const readingId = useId();
  // Roll's description: why it waits, then how it will roll. Only the reading shows under the roll row (5.3): the field it
  // waits on stands beside it, and a line more would fold the card on a phone on its side.
  const waitsFor = !connected ? NEEDS_CONNECTION : roll.blocked;
  const whyId = useId();
  const failName = preset?.fails ? CONDITIONS[preset.fails].name : null;

  /** Settles one op by its own answer. A lost one is settled by where it landed while the request is open (5.6), never sent again. */
  const settle = (tag: string, answer: OpAnswer, refusal?: OpRefusal) => {
    const latest = store.getState().view?.rolls[request.id];
    const now = latest?.targets.find((t) => targetKey(t) === tkey);
    const landing = answer === "unknown" ? landingOf(now, tag) : undefined;
    step({ t: "answer", tag, answer, ...(refusal ? { text: refusalWords(refusal) } : {}), ...(landing ? { landing } : {}) });
    return answer === "taken" || landing === "mine";
  };

  const rollBlocked = useRollBlocked();
  const liveRoll = () => {
    const state = store.getState();
    const live = state.view?.rolls[request.id];
    const answer = live?.targets.find((t) => targetKey(t) === tkey);
    return state.connection === "open" && !!live && live.rev === request.rev && !!answer && !finalForPlayer(live, answer) && !answered(answer) && flowRef.current.busy === null;
  };
  const tapRoll = (override?: RollModeOverride) => {
    if (override && (rollBlocked || !liveRoll())) return;
    const now = cardRoll({ bonus, preset: dice ? presetFor(dice, ref, test, { rolls }) : null, inputs, text, typeTotals, override });
    if (override && now.blocked) return;
    if (!now.fields.ok) {
      step({ t: "check", error: now.fields.error });
      return;
    }
    const tag = actions.newId();
    if (step({ t: "tap", op: "roll", tag, offers }).busy?.tag !== tag) return;
    props.onEngage();
    const op = { t: "roll.dice" as const, tag, rollId: request.id, target: ref, ...(two ? { choice: picked } : {}), ...now.fields.value };
    const n = sendRoll(sender, op, {
      onAnswer: (answer, refusal) => {
        // Shown here while the request is open. A save-ends pass closes it with the card, and the toast tells the result then (5.4).
        if (store.getState().view?.rolls[request.id]) sender.receipts.announced(tag);
        settle(tag, answer, refusal);
      },
    });
    if (n === null) step({ t: "answer", tag, answer: "refused", text: connected ? "That roll could not be sent." : NEEDS_CONNECTION });
  };

  const rollMenu = useRollModeMenu({
    source: JSON.stringify([requestRollSource(request, target), ref, picked, bonus, inputs, text, typeTotals, preset]),
    name: `${roll.label} for ${name}`,
    capability: { d20: true, visibility: "request" },
    disabled: busy !== null || !offers.roll,
    dm: useRoomView((s) => s.you?.role === "dm"),
    valid: () => !rollBlocked && liveRoll(),
    fallbackFocus: () => answerRoot.current?.closest<HTMLElement>("[role='dialog']") ?? null,
    onTap: () => tapRoll(),
    onRoll: tapRoll,
  });

  const send = (op: { total: number } | { fail: true }) => {
    const tag = actions.newId();
    if (step({ t: "tap", op: "fail" in op ? "fail" : "send", tag, offers: { ...offers, send: !final && typeTotals } }).busy?.tag !== tag) return;
    const answer = "fail" in op ? { result: "fail" as const } : { total: op.total, ...(two ? { choice } : {}) };
    // Quiet: a refusal shows under the rows in the server's words, such as the budget's (W7-P-55), not in a toast as well.
    const n = actions.dispatch(
      { t: "roll.answer", rollId: request.id, target: ref, ...answer, tag },
      {
        quiet: true,
        onAnswer: (a, refusal) => {
          if (!settle(tag, a, refusal)) return;
          drafts.delete(key);
          props.onSent();
        },
      },
    );
    if (n === null) step({ t: "answer", tag, answer: "refused", text: "That answer could not be sent." });
  };

  /*
   * Asking the DM to change a final answer (5.5): each item sends at once,
   * naming the answer it would change by its tag, and a newer item replaces
   * the pending ask. Withdraw clears it. An ask that goes without a new
   * answer, and not by this device's Withdraw, was kept by the DM.
   */
  const ask = (item: AskItem) => {
    if (target.tag === undefined) return;
    const id = actions.newId();
    if (step({ t: "tap", op: "ask", tag: id, offers }).busy?.tag !== id) return;
    const n = actions.dispatch(
      { t: "roll.change", rollId: request.id, target: ref, ask: { id, on: target.tag, ...item.ask } },
      { quiet: true, onAnswer: (a, refusal) => void settle(id, a, refusal) },
    );
    if (n === null) step({ t: "answer", tag: id, answer: "refused", text: "That ask could not be sent." });
  };
  const withdrew = useRef<string | null>(null);
  const withdraw = () => {
    const pending = target.change;
    if (!pending) return;
    const tag = actions.newId();
    if (step({ t: "tap", op: "withdraw", tag, offers }).busy?.tag !== tag) return;
    withdrew.current = pending.id;
    const n = actions.dispatch(
      { t: "roll.change", rollId: request.id, target: ref, clear: pending.id },
      { quiet: true, onAnswer: (a, refusal) => void settle(tag, a, refusal) },
    );
    if (n === null) step({ t: "answer", tag, answer: "refused", text: "That could not be sent." });
  };
  const lastAsk = useRef(target.change);
  const [kept, setKept] = useState(false);
  useEffect(() => {
    const before = lastAsk.current;
    lastAsk.current = target.change;
    if (target.change !== undefined) setKept(false);
    else if (askKept(before, target, withdrew.current)) setKept(true);
  }, [target.change?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = () => {
    // The Total field is hidden while typed totals are off, so no draft of it is ever sent.
    if (!typeTotals) return;
    const parsed = parseTotal(text);
    if (!parsed.ok) step({ t: "check", error: parsed.error });
    else send({ total: parsed.total });
  };
  const setInput = (patch: Partial<RollInputs>) => {
    const next = { ...inputs, ...patch };
    setInputs(next);
    keep({ inputs: next });
    step({ t: "edit" });
    props.onEngage();
  };

  const failButton = (primary: boolean) => (
    <Button
      size="sm"
      variant={primary ? "primary" : "secondary"}
      busy={busy === "fail"}
      disabled={busy !== null && busy !== "fail"}
      onClick={() => send({ fail: true })}
      style={primary ? { justifySelf: "start" } : undefined}
    >
      {primary && failName ? `Fail (${failName})` : "Fail without rolling"}
    </Button>
  );

  return (
    <div
      ref={answerRoot}
      data-roll-answer-row={tkey}
      style={{
        display: "grid",
        gap: theme.space(2),
        borderTop: props.several ? `${theme.line.border}px solid ${theme.color.border}` : undefined,
        paddingTop: props.several ? theme.space(2) : 0,
      }}
    >
      {props.several || target.tokenId !== undefined ? <strong style={{ fontSize: theme.font.input }}>{props.several ? <RowName name={name} request={request} target={target} levelOf={levelOf} /> : name}</strong> : null}
      {target.dice || final ? (
        <>
          {target.dice ? (
            <RolledResult target={target} />
          ) : (
            <div style={{ fontSize: theme.font.body14 }}>
              <MarkedText text={`${finalAnswerText(target, request.test)}. Final.`} marks={answerChoiceMarks(finalAnswerText(target, request.test), request, target, levelOf, "Sent ".length)} />
            </div>
          )}
          <AskChange
            target={target}
            name={name}
            typeTotals={typeTotals}
            offers={offers}
            busy={busy}
            kept={kept}
            onAsk={ask}
            onWithdraw={withdraw}
          />
          {flow.error ? (
            <div role="alert" style={{ fontSize: theme.font.small, color: theme.color.dangerText }}>
              {flow.error}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {two ? (
            <Segmented
              label="Which one you rolled"
              value={choice}
              grow
              options={request.test.choices.map((c, i) => choiceOption(i as 0 | 1, choiceText(c), bonuses[i] ?? null, marksTest(testOf(request, i)) ? levelOf(ref, testOf(request, i)) : null))}
              onChange={(i) => {
                setChoice(i);
                keep({ choice: i });
                props.onEngage();
              }}
            />
          ) : null}
          {reminders.length > 0 ? (
            <ul
              aria-label="Reminders"
              style={{ margin: 0, paddingLeft: theme.space(4), display: "grid", gap: theme.space(0.5), fontSize: theme.font.small, color: theme.color.textMuted }}
            >
              {reminders.map((r) => (
                <li key={r.key}>{r.text}</li>
              ))}
            </ul>
          ) : null}
          {/* The answer block (5.7), which a card at a phone's foot measures so all of it shows and takes a tap at once where it fits. */}
          <div data-answer="" style={{ display: "grid", gap: theme.space(2) }}>
            {failsFirst ? failButton(true) : null}
            {waiting ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  tapRoll();
                }}
                style={{ display: "grid", gap: theme.space(1) }}
              >
                {/*
                 * Roll, Adv and Dis share the first line at every supported
                 * size. The bonus and extra fields follow on it together while
                 * both fit whole, else start the next line together, so the
                 * extra field never stands alone under the rest (Appendix A).
                 * Roll and the fields grow to share the line they stand on, as
                 * a window's buttons do (docs/design-v1-polish.md R6).
                 */}
                <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
                  <Button
                    {...rollMenu.buttonProps}
                    type="submit"
                    onClick={(event) => {
                      event.preventDefault();
                      rollMenu.buttonProps.onClick?.(event);
                    }}
                    size="sm"
                    style={{ flex: "1 1 auto", ...rollMenu.pressStyle }}
                    variant={failsFirst || (typeTotals && text.trim() !== "") ? "secondary" : "primary"}
                    aria-label={`${roll.label} for ${name}`}
                    aria-describedby={rollMenu.describe([waitsFor ? whyId : null, roll.reading ? readingId : null].filter((d) => d !== null).join(" ") || undefined)}
                    busy={busy === "roll"}
                    disabled={busy === null ? !offers.roll : busy !== "roll"}
                  >
                    {roll.label}
                  </Button>
                  {rollMenu.menu}
                  <span style={{ display: "inline-flex", gap: theme.space(1) }}>
                    <Chip pressed={inputs.pressed === "adv"} aria-label="Advantage" disabled={busy !== null} onClick={() => setInput({ pressed: inputs.pressed === "adv" ? null : "adv" })}>
                      Adv
                    </Chip>
                    <Chip pressed={inputs.pressed === "dis"} aria-label="Disadvantage" disabled={busy !== null} onClick={() => setInput({ pressed: inputs.pressed === "dis" ? null : "dis" })}>
                      Dis
                    </Chip>
                  </span>
                  <span style={{ flex: "1 1 auto", display: "flex", gap: theme.space(2) }}>
                    {bonus === null ? (
                      <Input
                        aria-label={`Your bonus for ${name}`}
                        value={inputs.bonus}
                        placeholder="+0"
                        enterKeyHint="go"
                        autoComplete="off"
                        maxLength={3}
                        disabled={busy !== null}
                        error={typedBonus?.ok === false}
                        onChange={(e) => setInput({ bonus: e.target.value })}
                        style={{ width: BONUS_FIELD_WIDTH, flex: "1 1 auto", textAlign: "center" }}
                      />
                    ) : null}
                    <Input
                      aria-label={`Extra dice for ${name}`}
                      value={inputs.extra}
                      placeholder="+1d4"
                      enterKeyHint="go"
                      autoComplete="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      maxLength={roll.extraRoom}
                      disabled={busy !== null}
                      onChange={(e) => setInput({ extra: e.target.value })}
                      style={{ width: EXTRA_FIELD_WIDTH, flex: "1 1 auto" }}
                    />
                  </span>
                </div>
                {waitsFor ? (
                  <span id={whyId} style={VISUALLY_HIDDEN}>
                    {waitsFor}
                  </span>
                ) : null}
                {roll.reading ? (
                  <div id={readingId} style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
                    {roll.reading}
                  </div>
                ) : null}
              </form>
            ) : null}
            {/* Off, a player's answer is rolled on the server, and the server refuses a typed one (shared/permissions.ts playersTypeTotals). */}
            {typeTotals ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submit();
                }}
                style={{ display: "flex", gap: theme.space(2) }}
              >
                <Input
                  ref={field}
                  aria-label={`Total ${name} rolled`}
                  value={text}
                  inputMode="numeric"
                  enterKeyHint="send"
                  autoComplete="off"
                  placeholder="Total"
                  error={flow.error !== null}
                  disabled={busy === "roll"}
                  onChange={(e) => {
                    setText(e.target.value);
                    keep({ text: e.target.value });
                    step({ t: "edit" });
                    props.onEngage();
                  }}
                  onFocus={() => keep({ focused: true })}
                  onBlur={() => {
                    if (drafts.has(key)) keep({ focused: false });
                  }}
                  style={{ flex: 1, width: 0 }}
                />
                <Button
                  type="submit"
                  variant={text.trim() !== "" ? "primary" : "secondary"}
                  size="sm"
                  busy={busy === "send"}
                  disabled={busy === null ? text.trim() === "" : busy !== "send"}
                >
                  {answerLabel(busy === "send", connected, answered(target))}
                </Button>
              </form>
            ) : null}
          </div>
          {/* After the block: the measure stops at the type row (5.7), so a plain fail never pushes Send out of reach. */}
          {(request.test.kind === "save" && !failsFirst) || (waiting && bonus === null && noBlock) ? (
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
              {request.test.kind === "save" && !failsFirst ? failButton(false) : null}
              {waiting && bonus === null && noBlock ? (
                <Button variant="quiet" size="sm" onClick={() => openStats(noBlock)} style={{ fontSize: theme.font.small }}>
                  Add a stat block
                </Button>
              ) : null}
            </div>
          ) : null}
          {answered(target) ? (
            <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
              <MarkedText text={chipLine(request, target)} marks={requestMarks(chipLine(request, target), request, target, levelOf, { short: true })} />
            </div>
          ) : null}
          {flow.error ? (
            <div role="alert" style={{ fontSize: theme.font.small, color: theme.color.dangerText }}>
              {flow.error}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/** A creature's name on a card for several, marked for the one test its row stands for, since the question above stays neutral (D-261029-415). */
function RowName(props: { name: string; request: RollRequest; target: RollTarget; levelOf: LevelOf }) {
  const test = rowTest(props.request, props.target);
  return test ? <ProficiencyLabel level={props.levelOf(targetRef(props.target), test)}>{props.name}</ProficiencyLabel> : <>{props.name}</>;
}

/** One of two choices, "Wisdom (Perception) +5", its words marked where the choice takes a mark, and its name saying so (FL7-R1-08). */
function choiceOption(value: 0 | 1, words: string, bonus: number | null, level: Proficiency | null): { value: 0 | 1; label: ReactNode; title?: string } {
  const text = choiceLabel(words, bonus);
  if (level === null || level === "none") return { value, label: text };
  // One span, so the option's flex box keeps the space before the bonus, as it does in the plain words.
  return { value, label: <span><MarkedText text={text} marks={findMarks(text, [{ label: words, level }])} /></span>, title: `${text}${spokenProficiency(level)}` };
}

/** How far the question stands under Later's top: its first line, 16 px at tight leading, centered on Later's 44 px. */
const QUESTION_DROP = (theme.touch - theme.font.input * theme.leading.tight) / 2;

/** The bonus field, as wide as "-20" in the 16 px field (Appendix A: 64 px). */
const BONUS_FIELD_WIDTH = 64;
/** The extra dice field (Appendix A: 88 px), as wide as "+1d4" with room to spare. */
const EXTRA_FIELD_WIDTH = 88;

/**
 * "Ask to change it" under a final answer (5.5), a menu on the shared
 * popover base whose every item sends at once, and while an ask waits the
 * words of it with Withdraw. A rolled answer offers rerolls, Lucky and
 * Bardic Inspiration, and a typed one "Fix my total".
 */
function AskChange(props: {
  target: RollTarget;
  name: string;
  typeTotals: boolean;
  offers: AnswerOffers;
  busy: AnswerOp | null;
  kept: boolean;
  onAsk(item: AskItem): void;
  onWithdraw(): void;
}) {
  const { target } = props;
  const menu = usePopover({ kind: "menu" });
  const items = askItems(target, props.typeTotals);
  const pending = target.change;
  return (
    <div style={{ display: "grid", gap: theme.space(1), justifyItems: "start" }}>
      {pending ? <div style={{ fontSize: theme.font.small }}>{askedText(pending)}</div> : props.kept ? <div style={{ fontSize: theme.font.small }}>{KEPT}</div> : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        {props.offers.ask ? (
          <>
            <Button
              {...menu.anchorProps}
              size="sm"
              busy={props.busy === "ask"}
              disabled={props.busy !== null && props.busy !== "ask"}
              aria-label={`Ask the DM to change ${props.name}'s answer`}
            >
              Ask to change it
            </Button>
            <Popover handle={menu} side="above" bound={viewportBound}>
              <Menu
                label={`Ask the DM to change ${props.name}'s answer`}
                sections={[{ key: "asks", items: items.map((i) => ({ id: i.id, title: i.label, kind: "action" as const })) }]}
                onPick={(id) => {
                  const item = items.find((i) => i.id === id);
                  if (item) props.onAsk(item);
                }}
              />
            </Popover>
          </>
        ) : null}
        {pending && props.offers.withdraw ? (
          <Button size="sm" busy={props.busy === "withdraw"} disabled={props.busy !== null && props.busy !== "withdraw"} onClick={props.onWithdraw}>
            Withdraw
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** The screen, in the chrome's own px, as the popover base measures. */
function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}

/**
 * A rolled answer in place of the creature's rows (5.4): "Rolled 17
 * (1d20+5 with Advantage: 12, 7 dropped). Pass." with a dropped die struck
 * through, a natural 20 or 1, then "Final."
 */
function RolledResult(props: { target: RollTarget }) {
  const { target } = props;
  const dice = target.dice!;
  const shown = rolledDice(dice);
  const natural = naturalText(dice);
  const verdict = verdictText(target);
  return (
    <RollResultLine as="div" text={`${rolledText(target, false)} Final.`} suffix={normalResult(dice) ? ` ${normalResult(dice)}.` : ""} style={{ fontSize: theme.font.body14 }}>
      Rolled <strong>{target.total ?? dice.total}</strong> ({shown.formula}
      {shown.faces.length > 0 ? ": " : ""}
      {shown.faces.map((f, i) => (
        <Fragment key={i}>
          {i > 0 ? ", " : ""}
          {f.dropped ? (
            <>
              <s>{f.face}</s>
              <span style={VISUALLY_HIDDEN}> dropped</span>
            </>
          ) : (
            f.face
          )}
        </Fragment>
      ))}
      ).{natural ? ` ${natural}.` : ""}
      {verdict ? ` ${verdict}.` : ""} Final.
    </RollResultLine>
  );
}

/**
 * A folded request: "DEX save: sent 17. Pass." per creature. A tap opens
 * the card to change the answer while the request is open, except when
 * every answer on it is final, which the chip then says in plain text.
 */
export function RollChip(props: { buttonRef?: RefObject<HTMLButtonElement | null>; request: RollRequest; onOpen(): void }) {
  const { request } = props;
  const names = useRoomView((s) => (s.view ? request.targets.map((t) => creatureName(s.view!, t)).join("|") : ""));
  const several = request.targets.length > 1;
  const lines = request.targets.map((t, i) => chipLine(request, t, several ? { name: names.split("|")[i] ?? "" } : {}));
  // Each line is one creature's, so each marks its test with that creature's level.
  const levelOf = useProficiency();
  const marks = request.targets.map((t, i) => requestMarks(lines[i]!, request, t, levelOf, { short: true }));
  // A final answer opens the card too, to ask the DM to change it (docs/design-v1-roll-request.md 5.4). Only an answer from before tags, which no ask can name, leaves nothing to open.
  const changeable = request.targets.some((t) => !finalForPlayer(request, t) || t.tag !== undefined);
  const style = {
    ...cardStyle,
    minHeight: theme.touch,
    textAlign: "left",
    fontSize: theme.font.body14,
    fontFamily: theme.font.body,
    display: "grid",
    gap: theme.space(0.5),
  } as const;
  const text = lines.map((line, i) => (
    <span key={i}>
      <MarkedText text={line} marks={marks[i]!} />
    </span>
  ));
  if (!changeable) {
    return (
      <div role="status" style={style}>
        {text}
      </div>
    );
  }
  return (
    <button ref={props.buttonRef} type="button" onClick={props.onOpen} aria-label={chipName(request, lines.map((line, i) => spokenText(line, marks[i]!)))} style={{ ...style, cursor: "pointer" }}>
      {text}
    </button>
  );
}

function creatureName(view: Pick<RoomState, "tokens" | "characters">, target: RollTarget): string {
  if (target.tokenId !== undefined) {
    const token = view.tokens[target.tokenId];
    return token ? displayName(token) : "your creature";
  }
  return view.characters[target.characterId ?? ""]?.name ?? "your creature";
}
