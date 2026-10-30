import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bonusFor, testOf } from "#shared/dice/bonus.ts";
import { ANSWERED_MEANWHILE } from "#shared/permissions.ts";
import { ABILITY_ABBR } from "#shared/rules/skills.ts";
import { useStore } from "zustand";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Input } from "../../components/Field.tsx";
import { MarkedText, ProficiencyLabel } from "../../components/ProficiencyMark.tsx";
import { useAlertsSummary } from "../../components/sheetFocus.ts";
import { revealAndFocus } from "../../lib/reveal.ts";
import { theme } from "../../lib/theme.ts";
import { dockSlot, focusAlert } from "../../pages/fold.ts";
import { focusMap, mapFocusSlot } from "../../pages/mapFocus.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { sheetOpen } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { CastCard } from "../dice/cast/CastCard.tsx";
import { castWho, deskAsks, foldedWithAsks } from "../dice/cast/castStart.ts";
import { creatureRolls } from "../dice/creature.ts";
import { useRestoreGroupSave } from "../dice/groupSave/start.ts";
import { useGroupSave } from "../dice/groupSave/store.ts";
import { presetFor } from "../dice/presets.ts";
import { NEEDS_CONNECTION, sendRoll, useRollSender } from "../dice/send.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { useProficiency } from "../dice/useProficiency.ts";
import { refusalWords } from "../dice/useReceipt.ts";
import { useLayoutSize } from "../device/layout.ts";
import { AskRow } from "./AskRow.tsx";
import { askRowText, bestChoice, dmRoll, knownOrTyped } from "./card.ts";
import {
  allAnsweredIds,
  answered,
  answeredCount,
  cardAfterClose,
  chipStack,
  chipsStayShown,
  deskLayout,
  dcText,
  dmAnswerText,
  foldedChips,
  heldBySaveEnds,
  newestFirst,
  PHONE_CHIPS,
  tallyText,
  targetKey,
  targetName,
  targetRef,
  testShortText,
  wantsMark,
} from "./logic.ts";
import { answerChoiceMarks, requestMarks, rowTest, type LevelOf } from "./marks.ts";
import { askSlot, closeAsk } from "./open.ts";
import { RequestSheet } from "./RequestSheet.tsx";
import { deskTraps, foldedWithTraps } from "../traps/desk.ts";
import { TrapCard } from "../traps/TrapCard.tsx";
import { cardStyle, ResultBadge } from "./parts.tsx";

const NO_ROLLS = {};
const NO_CASTS = {};
const NO_TRAPS = {};

/**
 * How many of the desk's waiting things its summary words leave out
 * (docs/design-v1-visual.md 3.2.1): the words name the traps that went
 * off, else the asks for saves, else the roll requests, so the rest count
 * in the summary's "+N". "Dart plate went off +2" with two asks for saves
 * waiting, where the row once read "Dart plate went off" alone
 * (LP16-PT-3).
 */
export function deskUnnamed(counts: { traps: number; asks: number; cards: number }): number {
  if (counts.traps > 0) return counts.asks + counts.cards;
  if (counts.asks > 0) return counts.cards;
  return 0;
}

/**
 * The DM's side of request a roll (docs/design-v1-dm-tools.md 3.3): the
 * sheet, opened from the party bar or a token's action bar, and a live card
 * per open request in the fight alerts column, newest on top. Each card
 * lists every creature asked, "waiting" or its answer, with Pass and Fail
 * to mark a roll with no DC or to overrule, Reopen on an answer, and Close.
 * Loaded only for a DM.
 *
 * On a phone the cards follow the player's chips (docs/design-v1-visual.md
 * 3.3.1): the newest two show, then one "Rolls d/a" disclosure for the
 * rest, since six folded cards covered most of the map. Under a sheet in
 * portrait the whole stack folds into one summary, which the dock on the
 * sheet's edge stands for.
 *
 * A player's ask for saves is a card above the live cards
 * (docs/design-v1-player-save-spell.md 3.3), counted with them in the
 * newest two and the summary, and it leads the dock's summary, since it
 * waits for the DM. The ask the open group save holds has no card until
 * that page is discarded.
 *
 * A trap that went off with something left for the DM (docs/design-v1-traps.md
 * 4.3) is a card above both, newest first, while its springing waits: it
 * waits for the DM too, so it leads the summary.
 */
export function DmDesk() {
  const scope = useRoomScope();
  const asking = useStore(useScoped(askSlot), (s) => s.asking);
  const rolls = useRoomView((s) => s.view?.rolls ?? NO_ROLLS);
  const cards = useMemo(() => newestFirst(rolls), [rolls]);
  const casts = useRoomView((s) => s.view?.casts ?? NO_CASTS);
  useRestoreGroupSave();
  const heldAsk = useGroupSave((s) => (s.page && s.page.phase !== "applied" ? (s.page.cast?.ask.id ?? null) : null));
  const asked = useMemo(() => deskAsks(casts, heldAsk), [casts, heldAsk]);
  const askWho = useRoomView((s) => (s.view && asked.length === 1 ? castWho(s.view, asked[0]!) : ""));
  const traps = useRoomView((s) => s.view?.traps ?? NO_TRAPS);
  const sprung = useMemo(() => deskTraps(traps), [traps]);
  const items = sprung.length + asked.length + cards.length;
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const held = useMemo(() => (tokens && characters ? heldBySaveEnds({ tokens, characters, rolls }) : new Set<string>()), [tokens, characters, rolls]);
  const done = useMemo(() => allAnsweredIds(rolls), [rolls]);
  const actions = useRoomActions();
  const ui = useRoomUi();
  const size = useLayoutSize();
  const covered = useRoomView((s) => sheetOpen(s.local));
  const layout = deskLayout({ width: size.width, height: size.height, wideMinWidth: theme.layout.wideMinWidth, sheetOpen: covered });
  // Which cards the DM folded or unfolded by hand. Otherwise deskLayout decides.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  // Whether a phone shows the cards past the newest two (chipStack).
  const [expanded, setExpanded] = useState(false);
  const stack = chipStack({ count: items, phone: size.width < theme.layout.wideMinWidth, underSheet: layout.folded, expanded });
  const keepShown = chipsStayShown(items);
  useEffect(() => {
    if (!keepShown) setExpanded(false);
  }, [keepShown]);

  // Each card's toggle, by its request, which takes focus for its card.
  const toggles = useRef(new Map<string, HTMLButtonElement>());
  const toggleRef = (id: string) => (el: HTMLButtonElement | null) => {
    if (el) toggles.current.set(id, el);
    else toggles.current.delete(id);
  };

  // The summary, here or in the dock (3.2.1), closes the sheets and puts focus on the newest card once it shows.
  const [focusAfter, setFocusAfter] = useState(false);
  const open = () => {
    ui.closeSheets();
    setFocusAfter(true);
  };
  useEffect(() => {
    if (!focusAfter || layout.folded) return;
    // The column scrolls as a whole, and kept its place while the sheet folded it.
    const first = sprung[0]?.due.id ?? asked[0]?.id ?? cards[0]?.id;
    revealAndFocus(first ? toggles.current.get(first) : null);
    setFocusAfter(false);
  }, [focusAfter, layout.folded]);

  /*
   * Close and "Close all answered" go with the cards they close, and focus
   * fell to the page. Once those cards are gone, focus goes to the card
   * after the one closed (the first card left, after Close all answered),
   * else the column's first alert, else the map. A close applies to this
   * view at once, before the server answers (state/store.ts), so the cards
   * go and focus moves straight away. One the server refuses brings its
   * card back later, with focus wherever it is by then. A close whose cards
   * are still there when its answer comes is forgotten then, so it cannot
   * move focus later, when those cards close some other way.
   */
  const afterClose = useRef<{ ids: readonly string[]; next: string | null } | null>(null);
  const close = (ids: readonly string[], by: "card" | "all") => {
    const ask = { ids, next: cardAfterClose(cards.map((c) => c.id), ids, by) };
    afterClose.current = ask;
    const settled = () => {
      if (afterClose.current === ask) afterClose.current = null;
    };
    // "Close all answered" lets the server skip a request an ask or a reopen reached after the tap (docs/design-v1-roll-request.md 1.1).
    const op = { t: "roll.close" as const, rollIds: [...ids], ...(by === "all" ? { ifSettled: true as const } : {}) };
    if (actions.dispatch(op, { onAnswer: settled }) === null) settled();
  };
  useLayoutEffect(() => {
    const ask = afterClose.current;
    if (!ask || cards.some((c) => ask.ids.includes(c.id))) return;
    afterClose.current = null;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    if (revealAndFocus(ask.next === null ? null : toggles.current.get(ask.next))) return;
    if (focusAlert(scope.get(dockSlot).getState().column, null)) return;
    focusMap(scope.get(mapFocusSlot));
  }, [cards, scope]);
  // A player's ask to change a roll waits for the DM, so then the rolls lead the dock's summary (docs/design-v1-roll-request.md 6).
  const asks = cards.reduce((n, c) => n + c.targets.filter((t) => t.change !== undefined).length, 0);
  const counted = answeredCount(cards);
  // An ask for saves waits for the DM too, so it leads: "Thorn asks for saves".
  const forSaves = asked.length === 0 ? null : asked.length === 1 ? `${askWho} asks for saves` : `${asked.length} asks for saves`;
  const wentOff = sprung.length === 0 ? null : sprung.length === 1 ? `${sprung[0]!.trap.name} went off` : `${sprung.length} traps went off`;
  const rollsName = cards.length > 0 ? (asks > 0 ? `${counted.name}, ${asks} ${asks === 1 ? "asks" : "ask"} to change a roll` : counted.name) : null;
  useAlertsSummary(
    items > 0
      ? {
          text: wentOff ?? forSaves ?? counted.text,
          name: [wentOff, forSaves, rollsName].filter((x): x is string => x !== null).join(", "),
          waiting: asks > 0 || forSaves !== null || wentOff !== null,
          requests: items,
          unnamed: deskUnnamed({ traps: sprung.length, asks: asked.length, cards: cards.length }),
          open,
        }
      : null,
  );

  // A card with an ask unfolds on a computer, since it waits for the DM. A phone's folded line names the ask instead.
  const phone = size.width < theme.layout.wideMinWidth;
  // One its save-ends card holds stays folded: Allow and Keep show once, on that card.
  const opensAt = (request: RollRequest, i: number) => !held.has(request.id) && (layout.startsOpen(i) || (!phone && request.targets.some((t) => t.change !== undefined)));
  // The traps stand first, then the asks, so the newest two are counted over all three, and what folds is the rest of each.
  const shownTraps = sprung.slice(0, stack.shown);
  const shownAsks = asked.slice(0, Math.max(0, stack.shown - sprung.length));
  const shownCards = cards.slice(0, Math.max(0, stack.shown - sprung.length - asked.length));
  const foldedCards = stack.button === "sheet" ? cards : cards.slice(Math.max(0, PHONE_CHIPS - sprung.length - asked.length));
  const foldedAsks = stack.button === "sheet" ? asked : asked.slice(Math.max(0, PHONE_CHIPS - sprung.length));
  const foldedTraps = stack.button === "sheet" ? sprung : sprung.slice(PHONE_CHIPS);
  const summary = stack.button
    ? foldedWithTraps(foldedWithAsks(foldedCards.length > 0 ? foldedChips(foldedCards, stack.button) : null, foldedAsks.length, stack.button), foldedTraps.length, stack.button)
    : null;
  const summaryButton = summary ? (
    <Button
      size="sm"
      aria-label={summary.label}
      title={summary.label}
      onClick={() => (stack.button === "sheet" ? open() : setExpanded(stack.button === "more"))}
      // Showing and folding the cards past the newest two is a disclosure. The sheet's kind closes the sheet instead, so it has none.
      expanded={stack.button === "sheet" ? undefined : stack.button === "less"}
      style={{ pointerEvents: "auto", justifySelf: stack.button === "sheet" ? "end" : undefined, boxShadow: theme.shadow.float, fontVariantNumeric: "tabular-nums" }}
    >
      {summary.text}
    </Button>
  ) : null;

  return (
    <>
      {items > 0 && stack.button === "sheet" ? (
        summaryButton
      ) : items > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: theme.space(2),
            pointerEvents: "auto",
          }}
        >
          {cards.length > 1 && done.length > 0 ? (
            <Button size="sm" onClick={() => close(done, "all")} style={{ boxShadow: theme.shadow.float }}>
              Close all answered ({done.length})
            </Button>
          ) : null}
          {shownTraps.map(({ trap, due }) => (
            <TrapCard
              key={due.id}
              trap={trap}
              due={due}
              toggleRef={toggleRef(due.id)}
              // A springing waits for the DM, so it opens on a computer, and a phone's card starts folded to its first line.
              open={toggled[due.id] ?? !phone}
              onToggle={() => setToggled((t) => ({ ...t, [due.id]: !(t[due.id] ?? !phone) }))}
            />
          ))}
          {shownAsks.map((ask) => (
            <CastCard
              key={ask.id}
              ask={ask}
              toggleRef={toggleRef(ask.id)}
              // An ask waits for the DM, so it opens on a computer, and a phone's card starts folded to its first line.
              open={toggled[ask.id] ?? !phone}
              onToggle={() => setToggled((t) => ({ ...t, [ask.id]: !(t[ask.id] ?? !phone) }))}
            />
          ))}
          {shownCards.map((request, i) => (
            <DmCard
              key={request.id}
              toggleRef={toggleRef(request.id)}
              onClose={() => close([request.id], "card")}
              request={request}
              open={toggled[request.id] ?? opensAt(request, i)}
              onToggle={() => setToggled((t) => ({ ...t, [request.id]: !(t[request.id] ?? opensAt(request, i)) }))}
            />
          ))}
          {summaryButton}
        </div>
      ) : null}
      {asking ? <RequestSheet from={asking} onClose={() => closeAsk(scope)} /> : null}
    </>
  );
}

export function DmCard(props: { toggleRef(el: HTMLButtonElement | null): void; onClose(): void; request: RollRequest; open: boolean; onToggle(): void }) {
  const { request } = props;
  const tally = tallyText(request);
  const asking = request.targets.filter((t) => t.change !== undefined);
  const askName = useRoomView((s) => (s.view && asking.length === 1 ? targetName(s.view, asking[0]!, s.sceneId) : ""));
  const asks = asking.length === 1 && asking[0]!.change ? askRowText(asking[0]!.change, askName) : tally.asks;
  const dc = dcText(request, "dm");
  const title = `${testShortText(request.test)}${dc ? `, ${dc}` : ""}`;
  // The title marks its test only for one creature. With several, each row's name carries its own (D-261029-415).
  const levelOf = useProficiency();
  const titleMarks = request.targets.length === 1 ? requestMarks(title, request, request.targets[0]!, levelOf, { short: true }) : [];
  const hidden = request.resultShown ? "" : ", pass or fail hidden from players";
  return (
    <section role="group" aria-label={`Roll request: ${title}`} style={{ ...cardStyle, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(1) }}>
        <button
          ref={props.toggleRef}
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.open}
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: theme.touch,
            display: "grid",
            alignContent: "center",
            padding: 0,
            background: "transparent",
            border: "none",
            color: theme.color.text,
            fontFamily: theme.font.body,
            textAlign: "left",
            cursor: "pointer",
          }}
        >
          <span style={{ fontWeight: theme.weight.bold, fontSize: theme.font.body14 }}>
            <MarkedText text={title} marks={titleMarks} />
          </span>
          <span style={{ fontSize: theme.font.small, color: theme.color.textMuted, fontVariantNumeric: "tabular-nums" }}>
            {tally.answered}
            {hidden}
          </span>
          {asks ? <span style={{ fontSize: theme.font.small, color: theme.color.text }}>{asks}</span> : null}
        </button>
        <Button
          size="sm"
          aria-label={`Close the ${testShortText(request.test)} request`}
          title={`Close the ${testShortText(request.test)} request`}
          onClick={props.onClose}
        >
          Close
        </Button>
      </div>
      {props.open ? (
        <>
          {request.note ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{request.note}</div> : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(1) }}>
            {request.targets.map((target) => (
              <TargetRow key={targetKey(target)} request={request} target={target} levelOf={levelOf} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function TargetRow(props: { request: RollRequest; target: RollTarget; levelOf: LevelOf }) {
  const { request, target } = props;
  const actions = useRoomActions();
  const name = useRoomView((s) => (s.view ? targetName(s.view, target, s.sceneId) : ""));
  const ref = targetRef(target);
  const waiting = !answered(target);
  // With several creatures the title stays neutral, so a row's name carries its mark. A recorded choice of two is marked where the answer names it.
  const nameTest = request.targets.length > 1 ? rowTest(request, target) : null;
  const answerText = dmAnswerText(target, request.test);
  const mark = (result: "pass" | "fail") => {
    if (target.result === result) return;
    actions.dispatch({ t: "roll.answer", rollId: request.id, target: ref, result, tag: actions.newId() });
  };
  // Tight, so the name and both marks fit the column's 300 px card.
  const markStyle = { padding: `0 ${theme.space(2)}px` };
  return (
    <li
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(1),
        borderTop: `${theme.line.border}px solid ${theme.color.border}`,
        paddingTop: theme.space(1),
      }}
    >
      <div style={{ flex: 1, minWidth: 0, display: "grid" }}>
        <span style={{ display: "flex", alignItems: "center", gap: theme.space(1), minWidth: 0 }}>
          <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: theme.font.body14 }}>{nameTest ? <ProficiencyLabel level={props.levelOf(ref, nameTest)}>{name}</ProficiencyLabel> : name}</strong>
          <ResultBadge result={target.result} wantsMark={wantsMark(request, target)} />
        </span>
        <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
          <MarkedText text={answerText} marks={answerChoiceMarks(answerText, request, target, props.levelOf)} />
        </span>
        {answered(target) ? (
          // It acts in place, so it reads as a quiet button rather than a link's accent (docs/design-v1-visual.md F24).
          <Button
            variant="quiet"
            size="sm"
            onClick={() => actions.dispatch({ t: "roll.reopen", rollId: request.id, target: ref })}
            style={{ justifySelf: "start", padding: 0, fontSize: theme.font.small }}
          >
            Reopen for one more answer
          </Button>
        ) : waiting ? (
          <DmRollButton request={request} target={target} name={name} />
        ) : null}
        {target.change ? <AskRow request={request} target={target} change={target.change} name={name} /> : null}
      </div>
      <Button size="sm" icon="pass" pressed={target.result === "pass"} aria-label={`Mark ${name} passed`} title={`Mark ${name} passed`} onClick={() => mark("pass")} style={markStyle}>
        Pass
      </Button>
      <Button size="sm" icon="fail" pressed={target.result === "fail"} aria-label={`Mark ${name} failed`} title={`Mark ${name} failed`} onClick={() => mark("fail")} style={markStyle}>
        Fail
      </Button>
    </li>
  );
}

/**
 * Roll for a creature still waiting (docs/design-v1-roll-request.md 6),
 * where Reopen stands on an answered row: shown only while the creature is
 * in the DM's view, so a token on a scene the DM is not viewing has none.
 * One with no stat block rolls with a bonus the DM types beside it, never
 * a "+0" no one gave. The preset reads every effect over the DM's view and the request's
 * `spell`, and two choices roll the higher bonus. It sends `unanswered`,
 * so an answer that came first stands and this roll is refused before any
 * draw. Its result shows in the row itself, which the answer fills.
 */
function DmRollButton(props: { request: RollRequest; target: RollTarget; name: string }) {
  const { request, target, name } = props;
  const ui = useRoomUi();
  const sender = useRollSender();
  const store = useRoomStore();
  const actions = useRoomActions();
  const ref = useMemo(() => targetRef({ tokenId: target.tokenId, characterId: target.characterId }), [target.tokenId, target.characterId]);
  const creatures = useMemo(() => [ref], [ref]);
  const { dice } = useDiceView(creatures);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const connected = useRoomView((s) => s.connection === "open");
  const rolls = dice ? creatureRolls(dice, ref) : null;
  const two = request.test.choices.length > 1;
  const bonuses = request.test.choices.map((_, i) => (rolls?.numbers ? bonusFor(rolls.numbers, testOf(request, i)) : null));
  const choice = two ? bestChoice(bonuses) : 0;
  const known = bonuses[choice] ?? null;
  if (!dice || !rolls) return null;
  const { bonus, waits, error } = knownOrTyped(known, text, true);
  const test = testOf(request, choice);
  const picked = request.test.choices[choice]!;
  const roll = dmRoll({ bonus, typed: known === null, preset: presetFor(dice, ref, test, { rolls }), ...(two ? { ability: ABILITY_ABBR[picked.ability] } : {}) });
  const tap = () => {
    if (busy || bonus === null) return;
    // Read again at the tap, so the effects and Magic Resistance then decide (doc 3 3.2).
    const now = dmRoll({ bonus, typed: known === null, preset: presetFor(dice, ref, test, { rolls }) });
    const tag = actions.newId();
    const op = { t: "roll.dice" as const, tag, rollId: request.id, target: ref, ...(two ? { choice } : {}), ...now.fields, unanswered: true as const };
    const n = sendRoll(sender, op, {
      onAnswer: (answer, refusal) => {
        setBusy(false);
        if (store.getState().view?.rolls[request.id]) sender.receipts.announced(tag);
        if (answer !== "refused") return;
        ui.notify(refusal?.message === ANSWERED_MEANWHILE ? `${name} answered before your roll.` : (refusalWords(refusal) || "The roll was refused."), "error");
      },
    });
    if (n === null) ui.notify(NEEDS_CONNECTION, "error");
    else setBusy(true);
  };
  const button = (
    <Button
      variant="quiet"
      size="sm"
      busy={busy}
      disabled={!connected || waits !== null}
      title={!connected ? NEEDS_CONNECTION : (waits ?? undefined)}
      aria-label={`${roll.label} for ${name}`}
      onClick={tap}
      style={{ justifySelf: "start", padding: 0, fontSize: theme.font.small, textAlign: "left" }}
    >
      {roll.label}
    </Button>
  );
  if (known !== null) return button;
  return (
    <span style={{ display: "flex", alignItems: "center", gap: theme.space(1), flexWrap: "wrap" }}>
      <Input
        aria-label={`Bonus for ${name}`}
        value={text}
        placeholder="+0"
        enterKeyHint="done"
        autoComplete="off"
        maxLength={3}
        error={error}
        onChange={(e) => setText(e.target.value)}
        style={{ width: 64, flex: "none", textAlign: "center" }}
      />
      {button}
    </span>
  );
}
