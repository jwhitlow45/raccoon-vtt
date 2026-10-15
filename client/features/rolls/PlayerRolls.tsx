import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type Ref, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Effect, RollRequest, RollTarget, RoomState } from "#shared/model.ts";
import { rollReminders } from "#shared/rules/rollReminders.ts";
import { choiceText } from "#shared/rules/skills.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { dockSummaryButton, RETURN_RANK, sheetFocusSlot, useAlertsSummary, useSheetReturnFocus } from "../../components/sheetFocus.ts";
import { useBackClose } from "../../lib/backClose.ts";
import { displayName } from "../../lib/scene.ts";
import { theme } from "../../lib/theme.ts";
import { revealAndFocus } from "../../lib/reveal.ts";
import { useStore } from "zustand";
import { barDockSlot } from "../../canvas/barDock.ts";
import { useScoped } from "../../state/scope.ts";
import { sheetOpen, type OpAnswer } from "../../state/types.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { announceTurn } from "../encounter/alerts.ts";
import { chromeZoom, screenHeight, smallUi, useLayoutSize } from "../device/layout.ts";
import { useUiScale } from "../device/settings.ts";
import {
  answered,
  answerKey,
  answerLabel,
  askLine,
  CARD_MIN_WIDTH,
  cardFoldsUnderSheet,
  chipLine,
  chipName,
  chipStack,
  chipsStayShown,
  dcText,
  deskLayout,
  draftKey,
  finalAnswerText,
  finalForPlayer,
  foldedChips,
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
import { cardStyle, focusable } from "./parts.tsx";

const NO_ROLLS = {};

/** What a summary activation focuses once the sheet has closed: a request's card, or the newest chip when no card opens. */
type FocusAfter = { card: string } | { chip: true };

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
 * summary whose tap closes the sheet and opens the request to answer.
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
   */
  const dockStore = useScoped(barDockSlot);
  const zoom = useUiScale();
  const compactBar = useStore(dockStore, (s) => s.bar?.mode === "compact");
  const atFoot = shown !== undefined && width < CARD_MIN_WIDTH;
  const yieldsToBar = atFoot && compactBar;
  useLayoutEffect(() => {
    dockStore.setState({ footYields: yieldsToBar });
  }, [dockStore, yieldsToBar]);
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
  useLayoutEffect(() => () => dockStore.setState({ foot: 0, footYields: false }), [dockStore]);
  const foldsUnderSheet = cardFoldsUnderSheet({ width, height: size.height, wideMinWidth: theme.layout.wideMinWidth });
  const cardHidden = shown !== undefined && covered && foldsUnderSheet;
  // As the DM's cards do: the column sits above a phone's sheets in portrait, so everything folds into one summary
  // while one is open. A card folded under a sheet in landscape takes the chips with it into the same summary.
  const underSheet = deskLayout({ width, height: size.height, wideMinWidth: theme.layout.wideMinWidth, sheetOpen: covered }).folded || cardHidden;
  const stack = chipStack({ count: chips.length + (cardHidden ? 1 : 0), phone: width < theme.layout.wideMinWidth, underSheet, expanded });
  const keepShown = chipsStayShown(requests.length);
  useEffect(() => {
    if (!keepShown) setExpanded(false);
  }, [keepShown]);

  /*
   * Activating the summary, here or in the dock (3.2.1), is a request to
   * answer: the sheets close and the card to answer takes focus. A card
   * already mounted under the sheet wins, so an unsent total is never
   * dropped, and only with none does the newest waiting request come back
   * from Later, as a chip's tap brings it (requestToOpen). Focus moves
   * once the card has unfolded, in the effect after.
   */
  const open = () => {
    const target = requestToOpen(requests, needs, folded, opened);
    ui.closeSheets();
    if (target && !target.mounted) setOpened(target.id);
    setFocusAfter(target ? { card: target.id } : { chip: true });
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
  useAlertsSummary(published ? { ...published, requests: requests.length, open } : null);

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

  const summary = stack.button === "sheet" ? sheetSummary(requests, opens) : stack.button ? foldedChips(chips.slice(PHONE_CHIPS), stack.button) : null;
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
      style={{ pointerEvents: "auto", boxShadow: theme.shadow.float }}
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
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: theme.space(2),
            pointerEvents: "auto",
          }}
        >
          {chips.slice(0, stack.shown).map((r, i) => (
            <RollChip key={r.id} buttonRef={i === 0 ? firstChip : undefined} request={r} onOpen={() => setOpened(r.id)} />
          ))}
          {summaryButton}
        </div>
      )}
      {card && width < CARD_MIN_WIDTH ? createPortal(card, document.body) : null}
    </>
  );
}

/** The creature a target names, as this player's view holds it: its name and the effects its reminders read. */
function useCreature(target: RollTarget): { name: string; effects: readonly Effect[] } {
  const token = useRoomView((s) => (target.tokenId !== undefined ? s.view?.tokens[target.tokenId] : undefined));
  const characterId = target.characterId ?? (token && "ref" in token.actor ? token.actor.ref : undefined);
  const character = useRoomView((s) => (characterId !== undefined ? s.view?.characters[characterId] : undefined));
  const name = token ? displayName(token) : (character?.name ?? "Your creature");
  const effects = token && "inline" in token.actor ? token.actor.inline.effects : (character?.actor.effects ?? []);
  return { name, effects };
}

function RollCard(props: {
  cardRef: RefObject<HTMLElement | null>;
  request: RollRequest;
  drafts: Map<string, AnswerDraft>;
  sheet: boolean;
  /** Folded under a sheet: still mounted, so a typed total and a chosen roll survive, but out of sight, the focus order and the accessibility tree. */
  hidden: boolean;
  onFold(): void;
  /** The first keystroke or roll choice: the card then stays up when a newer request arrives. */
  onEngage(): void;
  onFocusWithin(inside: boolean): void;
}) {
  const { request } = props;
  const dc = dcText(request, "player");
  const zoom = useUiScale();
  // Only while it shows, so a card folded under a sheet, or one that arrived there, never takes Back from the sheet.
  useBackClose(props.sheet && !props.hidden, props.onFold);
  const sent = (key: string) => {
    // Folds once every creature it asked about has an answer, this one included.
    const rest = request.targets.filter((t) => targetKey(t) !== key);
    if (rest.every(answered)) props.onFold();
  };
  const body = (
    <>
      <div style={{ display: "flex", alignItems: "flex-start", gap: theme.space(2) }}>
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
          <div style={{ fontSize: theme.font.input, fontWeight: theme.weight.bold, lineHeight: theme.leading.tight }}>{askLine(request)}</div>
          {dc ? <div style={{ fontSize: theme.font.body14, color: theme.color.textMuted }}>{dc}</div> : null}
        </div>
        <Button size="sm" aria-label="Fold it into a chip, to answer later" title="Fold it into a chip, to answer later" onClick={props.onFold}>
          Later
        </Button>
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
    </>
  );
  // The dialog itself takes focus when the summary opens it: it reads its request and opens no keyboard.
  const common = {
    ref: props.cardRef as Ref<HTMLElement>,
    role: "dialog",
    "aria-label": "The DM asks for a roll",
    tabIndex: -1,
    hidden: props.hidden,
    onFocus: () => props.onFocusWithin(true),
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
  // and text then scale with the toolbar it stands on (docs/design-v1-dm-tools.md 3.16).
  return (
    <section
      {...common}
      {...smallUi(zoom)}
      style={{
        ...chromeZoom(zoom),
        position: "fixed",
        left: 0,
        right: 0,
        bottom: `calc(${theme.safe.bottom} + ${theme.layout.toolbar}px)`,
        zIndex: theme.z.overBars,
        maxHeight: screenHeight(70),
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
 * One creature's answer: which choice it rolled when there are two, the
 * reminders its conditions and statuses give for that choice, the total,
 * Send, and on a save "Fail without rolling". Send waits for the server,
 * since a player's view of a request lacks what the reducer reads.
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
  const { name, effects } = useCreature(target);
  const two = request.test.choices.length > 1;
  const key = draftKey(request.id, target);
  const [start] = useState(() => startingAnswer(target, drafts.get(key)));
  const [choice, setChoice] = useState<0 | 1>(start.choice);
  const [text, setText] = useState(start.text);
  const keep = (draft: { text?: string; choice?: 0 | 1; focused?: boolean }) =>
    drafts.set(key, { text, choice, focused: drafts.get(key)?.focused === true, ...draft, base: answerKey(target) });
  const field = useRef<HTMLInputElement>(null);
  // A card mounted afresh by turning the phone gives focus back to the field being typed in.
  useLayoutEffect(() => {
    if (start.focused) revealAndFocus(field.current);
  }, [start]);
  const [sending, setSending] = useState(false);
  const connected = useRoomView((s) => s.connection === "open");
  const [error, setError] = useState<string | null>(null);
  const reminders = rollReminders(effects, request.test, two ? choice : undefined);
  const final = finalForPlayer(request, target);

  const send = (op: { total: number } | { fail: true }) => {
    if (sending) return;
    const answer = "fail" in op ? { result: "fail" as const } : { total: op.total, ...(two ? { choice } : {}) };
    const onAnswer = (a: OpAnswer) => {
      setSending(false);
      if (a === "refused") {
        setError("Not sent.");
        return;
      }
      drafts.delete(key);
      props.onSent();
    };
    if (actions.dispatch({ t: "roll.answer", rollId: request.id, target: targetRef(target), ...answer }, { onAnswer }) === null) {
      setError("That answer could not be sent.");
      return;
    }
    setError(null);
    setSending(true);
  };

  const submit = () => {
    const parsed = parseTotal(text);
    if (!parsed.ok) setError(parsed.error);
    else send({ total: parsed.total });
  };

  return (
    <div
      style={{
        display: "grid",
        gap: theme.space(2),
        borderTop: props.several ? `${theme.line.border}px solid ${theme.color.border}` : undefined,
        paddingTop: props.several ? theme.space(2) : 0,
      }}
    >
      {props.several || target.tokenId !== undefined ? <strong style={{ fontSize: theme.font.input }}>{name}</strong> : null}
      {final ? (
        <div style={{ fontSize: theme.font.body14 }}>{finalAnswerText(target, request.test)}. Final. Ask the DM to change it.</div>
      ) : (
        <>
          {two ? (
            <Segmented
              label="Which one you rolled"
              value={choice}
              grow
              options={request.test.choices.map((c, i) => ({ value: i as 0 | 1, label: choiceText(c) }))}
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
              error={error !== null}
              onChange={(e) => {
                setText(e.target.value);
                keep({ text: e.target.value });
                setError(null);
                props.onEngage();
              }}
              onFocus={() => keep({ focused: true })}
              onBlur={() => {
                if (drafts.has(key)) keep({ focused: false });
              }}
              style={{ flex: 1, width: 0 }}
            />
            <Button variant="primary" size="sm" busy={sending} disabled={!sending && text.trim() === ""} onClick={submit}>
              {answerLabel(sending, connected, answered(target))}
            </Button>
          </form>
          {request.test.kind === "save" ? (
            <Button size="sm" disabled={sending} onClick={() => send({ fail: true })}>
              Fail without rolling
            </Button>
          ) : null}
          {answered(target) ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{chipLine(request, target)}</div> : null}
          {error ? (
            <div role="alert" style={{ fontSize: theme.font.small, color: theme.color.dangerText }}>
              {error}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * A folded request: "Dex save: sent 17. Pass." per creature. A tap opens
 * the card to change the answer while the request is open, except when
 * every answer on it is final, which the chip then says in plain text.
 */
function RollChip(props: { buttonRef?: RefObject<HTMLButtonElement | null>; request: RollRequest; onOpen(): void }) {
  const { request } = props;
  const names = useRoomView((s) => (s.view ? request.targets.map((t) => creatureName(s.view!, t)).join("|") : ""));
  const several = request.targets.length > 1;
  const lines = request.targets.map((t, i) => chipLine(request, t, several ? { name: names.split("|")[i] ?? "" } : {}));
  const changeable = request.targets.some((t) => !finalForPlayer(request, t));
  const style = {
    ...cardStyle,
    minHeight: theme.touch,
    textAlign: "left",
    fontSize: theme.font.body14,
    fontFamily: theme.font.body,
    display: "grid",
    gap: theme.space(0.5),
  } as const;
  const text = lines.map((line, i) => <span key={i}>{line}</span>);
  if (!changeable) {
    return (
      <div role="status" style={style}>
        {text}
      </div>
    );
  }
  return (
    <button ref={props.buttonRef} type="button" onClick={props.onOpen} aria-label={chipName(request, lines)} style={{ ...style, cursor: "pointer" }}>
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
