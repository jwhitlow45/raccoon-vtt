import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useStore } from "zustand";
import type { RollRequest, RollTarget } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { useAlertsSummary } from "../../components/sheetFocus.ts";
import { revealAndFocus } from "../../lib/reveal.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { sheetOpen } from "../../state/types.ts";
import { useRoomActions, useRoomUi, useRoomView } from "../../state/view.ts";
import { useLayoutSize } from "../device/layout.ts";
import {
  allAnsweredIds,
  answered,
  answeredCount,
  chipStack,
  chipsStayShown,
  deskLayout,
  dcText,
  dmAnswerText,
  foldedChips,
  newestFirst,
  PHONE_CHIPS,
  targetKey,
  targetName,
  targetRef,
  testShortText,
  wantsMark,
} from "./logic.ts";
import { askSlot, closeAsk } from "./open.ts";
import { RequestSheet } from "./RequestSheet.tsx";
import { cardStyle, ResultBadge } from "./parts.tsx";

const NO_ROLLS = {};

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
 */
export function DmDesk() {
  const scope = useRoomScope();
  const asking = useStore(useScoped(askSlot), (s) => s.asking);
  const rolls = useRoomView((s) => s.view?.rolls ?? NO_ROLLS);
  const cards = useMemo(() => newestFirst(rolls), [rolls]);
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
  const stack = chipStack({ count: cards.length, phone: size.width < theme.layout.wideMinWidth, underSheet: layout.folded, expanded });
  const keepShown = chipsStayShown(cards.length);
  useEffect(() => {
    if (!keepShown) setExpanded(false);
  }, [keepShown]);

  // The summary, here or in the dock (3.2.1), closes the sheets and puts focus on the newest card once it shows.
  const newest = useRef<HTMLButtonElement | null>(null);
  const [focusAfter, setFocusAfter] = useState(false);
  const open = () => {
    ui.closeSheets();
    setFocusAfter(true);
  };
  useEffect(() => {
    if (!focusAfter || layout.folded) return;
    // The column scrolls as a whole, and kept its place while the sheet folded it.
    revealAndFocus(newest.current);
    setFocusAfter(false);
  }, [focusAfter, layout.folded]);
  // Nothing waits for the DM's own answer, so the rolls never lead the dock's summary for a DM.
  useAlertsSummary(cards.length > 0 ? { ...answeredCount(cards), waiting: false, open } : null);

  const summary = stack.button === "sheet" ? foldedChips(cards, "sheet") : stack.button ? foldedChips(cards.slice(PHONE_CHIPS), stack.button) : null;
  const summaryButton = summary ? (
    <Button
      size="sm"
      aria-label={summary.label}
      title={summary.label}
      onClick={() => (stack.button === "sheet" ? open() : setExpanded(stack.button === "more"))}
      // Showing and folding the cards past the newest two is a disclosure. The sheet's kind closes the sheet instead, so it has none.
      expanded={stack.button === "sheet" ? undefined : stack.button === "less"}
      style={{ pointerEvents: "auto", justifySelf: stack.button === "sheet" ? "end" : undefined, boxShadow: theme.shadow.float }}
    >
      {summary.text}
    </Button>
  ) : null;

  return (
    <>
      {cards.length > 0 && stack.button === "sheet" ? (
        summaryButton
      ) : cards.length > 0 ? (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr)",
            gap: theme.space(2),
            pointerEvents: "auto",
          }}
        >
          {cards.length > 1 && done.length > 0 ? (
            <Button size="sm" onClick={() => actions.dispatch({ t: "roll.close", rollIds: done })} style={{ boxShadow: theme.shadow.float }}>
              Close all answered ({done.length})
            </Button>
          ) : null}
          {cards.slice(0, stack.shown).map((request, i) => (
            <DmCard
              key={request.id}
              toggleRef={i === 0 ? newest : undefined}
              request={request}
              open={toggled[request.id] ?? layout.startsOpen(i)}
              onToggle={() => setToggled((t) => ({ ...t, [request.id]: !(t[request.id] ?? layout.startsOpen(i)) }))}
            />
          ))}
          {summaryButton}
        </div>
      ) : null}
      {asking ? <RequestSheet from={asking} onClose={() => closeAsk(scope)} /> : null}
    </>
  );
}

function DmCard(props: { toggleRef?: RefObject<HTMLButtonElement | null>; request: RollRequest; open: boolean; onToggle(): void }) {
  const { request } = props;
  const actions = useRoomActions();
  const count = request.targets.filter(answered).length;
  const dc = dcText(request, "dm");
  const title = `${testShortText(request.test)}${dc ? `, ${dc}` : ""}`;
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
          <span style={{ fontWeight: theme.weight.bold, fontSize: theme.font.body14 }}>{title}</span>
          <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
            {count} of {request.targets.length} answered{hidden}
          </span>
        </button>
        <Button
          size="sm"
          aria-label={`Close the ${testShortText(request.test)} request`}
          title={`Close the ${testShortText(request.test)} request`}
          onClick={() => actions.dispatch({ t: "roll.close", rollIds: [request.id] })}
        >
          Close
        </Button>
      </div>
      {props.open ? (
        <>
          {request.note ? <div style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{request.note}</div> : null}
          <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: theme.space(1) }}>
            {request.targets.map((target) => (
              <TargetRow key={targetKey(target)} request={request} target={target} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function TargetRow(props: { request: RollRequest; target: RollTarget }) {
  const { request, target } = props;
  const actions = useRoomActions();
  const name = useRoomView((s) => (s.view ? targetName(s.view, target, s.sceneId) : ""));
  const ref = targetRef(target);
  const mark = (result: "pass" | "fail") => {
    if (target.result === result) return;
    actions.dispatch({ t: "roll.answer", rollId: request.id, target: ref, result });
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
          <strong style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: theme.font.body14 }}>{name}</strong>
          <ResultBadge result={target.result} wantsMark={wantsMark(request, target)} />
        </span>
        <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{dmAnswerText(target, request.test)}</span>
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
        ) : null}
      </div>
      <Button size="sm" pressed={target.result === "pass"} aria-label={`Mark ${name} passed`} title={`Mark ${name} passed`} onClick={() => mark("pass")} style={markStyle}>
        Pass
      </Button>
      <Button size="sm" pressed={target.result === "fail"} aria-label={`Mark ${name} failed`} title={`Mark ${name} failed`} onClick={() => mark("fail")} style={markStyle}>
        Fail
      </Button>
    </li>
  );
}
