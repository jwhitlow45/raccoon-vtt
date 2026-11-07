import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { useStore } from "zustand";
import { addDie, formatFormula, parseRollText } from "#shared/dice/formula.ts";
import { labelText } from "#shared/logText.ts";
import type { DiceRoll, LogEntry } from "#shared/model.ts";
import type { Proficiency } from "#shared/rules/proficiency.ts";
import { Button } from "../../components/Button.tsx";
import { Chip } from "../../components/Chip.tsx";
import { Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Loading } from "../../components/Loading.tsx";
import { choiceLook } from "../../components/looks.ts";
import { sectionLabelLook } from "../../components/Panel.tsx";
import { markedBy, ProficiencyLabel, proficiencyFrame, spokenProficiency } from "../../components/ProficiencyMark.tsx";
import { ScrollStrip } from "../../components/ScrollStrip.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { diceFillSlot, takeDiceFill } from "./fill.ts";
import { answerVerdict, askedRoll, headerRoll, modeRepeat, readHistory, readingOf, rollsOf, rollVerdict, stepHistory, withHistory, writeHistory, type HeaderRoll } from "./logic.ts";
import { acceptsRollMode, effectiveRollMode, type RollModeOverride } from "./rollMode.ts";
import { useRollModeMenu } from "./useRollModeMenu.tsx";
import { critical } from "./options.ts";
import { marksTest, rollTarget, rollTest } from "./proficiencyPresentation.ts";
import { FACE_CHIP, faceChips } from "./RecentRolls.tsx";
import { Tray } from "./throw/Tray.tsx";
import { useThrows, useThrowView } from "./throw/useThrows.ts";
import { againOf, useDicePanel, useLastRoll, useRollPresses } from "./useDicePanel.ts";
import { ApplyTo } from "./ApplyTo.tsx";
import { useRollBlocked } from "./useRollOption.ts";
import { useProficiency } from "./useProficiency.ts";
import { usePanelShown } from "../panels.ts";
import { useReceipt, useReceiptVoice, type ReceiptState } from "./useReceipt.ts";

/**
 * The top of the Dice panel (docs/design/design-v1-dice.md 8.2): the newest panel
 * roll, sticky at the scroller's top, then the formula field with Roll, its
 * reading, the quick dice and the one-roll choices.
 */

/** The scrolling pane's top padding, which its body publishes (components/Sheet.tsx paneBodyPadding). 0 outside a pane. */
const PAD_TOP = "var(--pane-pad-top, 0px)";
/** The sticky line's height (Appendix C), a touch target's, so Again at its full 44 px never makes the line taller than it is without it. */
export const LAST_LINE_PX = theme.touch;

const ROLLING = "Rolling…";

/**
 * The line under the field is always this tall, empty or not, so a reading,
 * a refusal or the blocked note coming and going while someone types never
 * moves the quick dice. The blocked note shares the line and wins: a blocked
 * panel cannot roll, so its reading and refusals add nothing. Long text cuts
 * with an ellipsis, a reading's before its range, and the full words stay in
 * the field's description.
 */
const NOTE_LINE = 1.3;
// The d20 leads, as the die rolled most: at 130% on a phone the strip scrolls after d10, and at 100% after d12.
const QUICK_DICE = [20, 4, 6, 8, 10, 12, 100] as const;
/**
 * The quick dice strip's room at each end for its first and last focus
 * ring. The strip stands this much wider on each side, in the pane's
 * padding, so the d20 starts on the field's edge (docs/design/design-v1-dice-pass.md
 * 7.7). The second box allowed past the content box, after the sticky
 * line's top, for the same reason: it must be wider than what it shows.
 */
const QUICK_EDGE = 3;

/**
 * The field's hint, shortened where the long one would be cut, as it was at
 * 320 x 568 at 130% (docs/design/design-v1-dice-pass.md 7.9).
 */
const PLACEHOLDER = { long: "1d20+5 or 2d6+3 fire", short: "1d20+5" } as const;

let measurer: CanvasRenderingContext2D | null = null;

/**
 * Whether the long hint fits inside the field's padding, by its words'
 * width in the field's own font. The field's own px and the font's are
 * both before the interface size's zoom, so the answer holds at any size.
 */
function longHintFits(field: HTMLInputElement): boolean {
  measurer ??= document.createElement("canvas").getContext("2d");
  if (!measurer) return true;
  const style = getComputedStyle(field);
  measurer.font = style.font;
  const room = field.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  return measurer.measureText(PLACEHOLDER.long).width <= room;
}

/** The header line's verdict: an answer's pass or fail as its player reads it, else a dice line's against its DC or AC. */
export function shownVerdict(roll: DiceRoll, data: LogEntry["data"]): string | null {
  return data?.type === "roll" ? answerVerdict(roll, data.result) : rollVerdict(roll, data?.type === "dice" ? data : {});
}

/**
 * What the live region says of a verdict: the header line's, except that a
 * weapon's wider critical range says Critical Hit as its Critical chip
 * does (critical()). A panel Attack carries no AC, so the header line's
 * words alone never say it.
 */
export function spokenVerdict(roll: DiceRoll, data: LogEntry["data"]): string | null {
  if (data?.type === "dice" && data.ac === undefined && roll.critOn !== undefined && critical(roll)) return "Critical Hit";
  return shownVerdict(roll, data);
}

/** The live region says the returned mode and visibility with the total once. Proficiency follows its test's name (FL7-SOL-04). */
export function spokenResult(head: HeaderRoll, verdict: string | null, level?: Proficiency, secret = false): string {
  const label = head.label ? `: ${labelText(head.label)}${level ? spokenProficiency(level) : ""}` : "";
  return `Rolled ${head.total}${head.sums ? ` (${head.sums})` : ""}${verdict ? `, ${verdict}` : ""}${label}${head.dice[0] && effectiveRollMode(head.dice[0], secret) ? `, ${effectiveRollMode(head.dice[0], secret)}` : ""}.`;
}

/**
 * What a settled receipt holds for a result line: its first roll, the
 * header roll, the proficiency mark of its label and the words a live region
 * says. The sticky line and a stat block's header line (BlockHeader.tsx)
 * both read their roll through it, so the two show one roll alike. An
 * answer's roll has no label of its own, so `label` names it where the
 * surface knows what it rolled (LP27-A-BLOCK-3).
 */
export function useCommittedRoll(receipt: ReceiptState | null, label?: string) {
  const committed = receipt?.state === "committed" ? receipt : null;
  const rolls = useMemo(() => (committed ? rollsOf(committed.lines) : []), [committed]);
  const first = rolls[0];
  const head = useMemo(() => headerRoll(rolls), [rolls]);
  const firstLine = committed?.lines[0]?.id ?? null;
  const data = committed?.lines[0]?.data;
  const levelOf = useProficiency();
  // The label is the first roll's own unless several damage types share it, which is no test.
  const target = first ? rollTarget(first) : null;
  const test = first && head?.label !== undefined && head.label === first.label ? rollTest(first) : null;
  const level = target && marksTest(test) ? levelOf(target, test) : undefined;
  const secret = data?.type === "dice" && data.to === "dm";
  // A polite live region says each result once, from the render that first holds it, so it is said as it lands on the server even while the dice still fly.
  const said = first && head ? spokenResult(head.label === undefined && label !== undefined ? { ...head, label } : head, spokenVerdict(first, data), level, secret) : "";
  return { rolls, first, head, data, firstLine, level, secret, said };
}

/** A result's total in heading type, as the sticky line and a stat block's line draw it. */
export function ResultTotal(props: { total: number }) {
  return <span style={{ flex: "none", fontSize: theme.font.heading, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>{props.total.toLocaleString("en-US")}</span>;
}

/**
 * The newest panel roll, from the first roll on: "Rolling..." while it
 * waits, then its total, label, dice and Again, or the refusal's words. It
 * sticks to the scroller's top, as Initiative's round header does, so an
 * option rolled at the sheet's foot shows its result at the top too. A tap
 * on it opens the whole roll in Recent rolls.
 *
 * A roll the panel throws holds its result until the dice land
 * (docs/design/design-v1-roll-animation.md 3.4): the live region says it at once,
 * and the line shows it 1 s later, or at once on any tap or key. Again
 * stays as a busy button while the roll waits, so a keyboard press keeps
 * its focus, and is live from the answer on.
 *
 * A damage roll's "Apply to" chips show under the line once its result
 * shows (QOL audit Q2, ApplyTo.tsx), in the sticky box, so they stay in
 * reach as the options scroll under them.
 */
export function LastResult(props: { onOpen(lineId: string): void }) {
  const last = useLastRoll();
  const panel = useDicePanel();
  const throws = useThrows();
  const thrown = useThrowView();
  // A hidden pane keeps this mounted. It then neither watches its roll nor holds its voice, so the toast says a roll nobody sees.
  const shown = usePanelShown();
  const tag = shown && last && "tag" in last ? last.tag : null;
  const holding = tag !== null && thrown.held === tag;
  const receipt = useReceipt(tag, holding);
  const waiting = receipt !== null && (receipt.state === "sending" || receipt.state === "checking");
  const { rolls, first, head, data, firstLine, level, said: spoken } = useCommittedRoll(receipt, last && "once" in last ? last.label : undefined);
  // Only the surface that may say a roll puts it in a live region or gives its refusal an alert: a roll sent from a stat block is said there (docs/design/design-v1-stat-block-rolls.md 8).
  const speaks = useReceiptVoice(tag, false);
  const said = speaks ? spoken : "";
  const again = againOf(last);
  const blocked = useRollBlocked();
  const dm = useRoomView((s) => s.you?.role === "dm");
  const asked = first ? askedRoll(first)?.formula : undefined;
  const repeat = useRollModeMenu({ source: JSON.stringify([tag, again, blocked]), name: "Again", title: asked ? `Again: ${asked}` : undefined, capability: { d20: !!again && modeRepeat(rolls, "normal", again.to) !== null, visibility: "repeat", repeat: true }, disabled: waiting, valid: () => blocked === null, dm,
    onTap: () => { if (again) panel.again(again.rolls, again.to, throws.origin()); },
    onRoll: (override) => { if (!again) return; const inputs = modeRepeat(rolls, override, again.to); if (inputs) panel.again(inputs, again.to, throws.origin()); },
  });
  if (!last) return null;
  let body;
  if ("error" in last) body = <span role="alert" style={{ color: theme.color.dangerText }}>{last.error}</span>;
  // The shared delayed indicator: a quick answer never flashes "Rolling...". Not a live region: the result's own says it once it lands.
  else if (!receipt || waiting) body = <Loading text={ROLLING} active={waiting} live={false} />;
  // The dice are in the air: the line stays as it was, "Rolling…" only where the wait was long enough to say it, so at once.
  else if (receipt.state === "committed" && holding) body = <Loading text={ROLLING} active={thrown.rolling} delay={0} live={false} />;
  else if (receipt.state === "refused") body = <span {...(speaks ? { role: "alert" } : {})} style={{ color: theme.color.dangerText }}>{receipt.text || receipt.message}</span>;
  else if (receipt.state === "unknown") body = <span style={{ color: theme.color.textMuted }}>This may have happened. Check the log.</span>;
  else if (!first || !head) body = <span style={{ color: theme.color.textMuted }}>Rolled. Its result is no longer in the log.</span>;
  else {
    const verdict = shownVerdict(first, data);
    const label = head.label !== undefined ? labelText(head.label) : "once" in last ? last.label : undefined;
    body = (
      <button
        type="button"
        onClick={() => firstLine && props.onOpen(firstLine)}
        aria-label={`Show this roll in Recent rolls`}
        aria-description={effectiveRollMode(first, data?.type === "dice" && data.to === "dm") || undefined}
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0, flex: 1, minHeight: LAST_LINE_PX, overflow: "hidden", whiteSpace: "nowrap" }}
      >
        <ResultTotal total={head.total} />
        <ResultRest sum={head.sums} label={label} level={level} dice={head.dice} more={head.more} verdict={verdict} />
      </button>
    );
  }
  return (
    <div
      data-dice-last=""
      style={{
        position: "sticky",
        top: `calc(-1 * ${PAD_TOP})`,
        zIndex: theme.z.stickyHeader,
        // Only the top takes the pane's padding back, so nothing scrolls past above the line. Sideways it keeps to the column, as every row does (docs/design/design-v1-dice-ui.md 3.1).
        // The padding taken back is given half above the row and half below it, so the row sits in the middle of the painted box, resting or stuck (docs/design/design-v1-dice-pass.md 7.4).
        margin: `calc(-1 * ${PAD_TOP}) 0 0`,
        padding: `calc(${PAD_TOP} / 2) 0`,
        background: theme.color.surface,
        borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
        // A grid item's floor is its content's width, and one line of a long label would widen the whole panel sideways. This lets it ellipsize instead.
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minHeight: LAST_LINE_PX, fontSize: theme.font.body14 }}>
        <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>{body}</div>
        {again ? (
          <Button size="sm" variant="quiet" icon="again" busy={waiting} {...repeat.buttonProps} style={{ flex: "none", ...repeat.pressStyle }}>
            Again
          </Button>
        ) : null}
      </div>
      {receipt?.state === "committed" && !holding && first && head ? (
        <ApplyTo lines={receipt.lines} style={{ paddingBottom: theme.space(1) }} />
      ) : null}
      {repeat.menu}
      <span role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {said}
      </span>
      <Tray />
    </div>
  );
}

/** The height of the header line's text and dice, a die's chip. */
const REST_PX = 24;

/**
 * A row one line tall whose items wrap, whole, onto a second line it never
 * shows. It keeps each item whole: one with no room goes, and every item
 * after it. The empty item it starts with (`LineStart`) lets even the first
 * real one go, since a line always keeps its first item. `reverse` lays it
 * out from the right, so the items listed first are kept longest.
 */
function dropsWhole(reverse = false): CSSProperties {
  return {
    flex: "1 1 0",
    minWidth: 0,
    height: REST_PX,
    overflow: "hidden",
    display: "flex",
    flexDirection: reverse ? "row-reverse" : "row",
    flexWrap: "wrap",
    alignItems: "center",
    // Laid out from the right, its items still sit at the left.
    justifyContent: reverse ? "flex-end" : "flex-start",
    columnGap: theme.space(2),
  };
}

/**
 * Whether a part of the dice's box is out of sight: its top at or past the
 * header line's foot (`lineBottom`, in page px). Not just below the line's
 * top, since the row centers its parts, so "and 2 more" in small words sits
 * a few pixels down on the first row (review FU44-OPUS-2). Read against the
 * line, not the dice's own box, since the "+2" can wrap out of sight and
 * take that whole box with it, whose parts then stand on its first row.
 */
export function wrappedOut(part: { getBoundingClientRect(): { top: number } }, lineBottom: number): boolean {
  return part.getBoundingClientRect().top >= lineBottom - 0.5;
}

/**
 * How many chips the "+2" says, given `hiddenWith(n)`: how many are out of
 * sight with it saying n (0 draws none). Showing it takes room, so it can
 * hide more, and it is tried again until the count holds. The count only
 * grows, so this ends within one try a chip, even where the "+2" changes
 * the line enough to bring a count back, which once looped the render it
 * set (ROLLER-185-LOOP).
 */
export function settleDropped(hiddenWith: (n: number) => number): number {
  let said = 0;
  for (let out = hiddenWith(0); out > said; out = hiddenWith(said)) said = out;
  return said;
}

/** `dropsWhole`'s empty first item. `dice` is for the dice's box, whose gap is the chips' 4 px. */
function LineStart(props: { reverse?: boolean; dice?: boolean }) {
  // Its negative margin takes back the gap after it, so the items after it start at the row's edge.
  const back = -theme.space(props.dice ? 1 : 2);
  return <span style={{ flex: "none", width: 0, height: REST_PX, ...(props.reverse ? { marginInlineStart: back } : { marginInlineEnd: back }) }} />;
}

/**
 * The header line after its total. Where the line is short, its parts give
 * way in turn, and none is ever cut through a glyph: "and 3 more", then the
 * dice, whole chips at a time, with "+2" for those it drops, then the label
 * to its "…". After those, each goes whole: "+2", the verdict, and last a
 * critical hit's sum. The total and Again stay. A `mode` ("with Advantage")
 * goes before all of them, whole, so it never costs a line. Each step is a box inside
 * the last, so a part gives up nothing while one before it in turn still
 * has room (docs/design/design-v1-dice-ui.md 4.1).
 *
 * The mode words go by measurement (LP27-A-BLOCK-2): flex wraps a part only
 * by its basis, and the label's box must keep a basis of 0 to shrink to its
 * "…" rather than wrap out of sight whole. So the words show only where,
 * shown, they cut no other part.
 */
export function ResultRest(props: { sum: string | null; label: string | undefined; level?: Proficiency | undefined; dice: readonly DiceRoll[]; more: number; verdict: string | null; mode?: string | undefined }) {
  // A damage of several types shows every part's dice, each part keyed apart since each restarts its chips' keys.
  const chips = useMemo(() => {
    const parts = props.dice.map((roll) => faceChips(roll));
    return parts.some((p) => p === null) ? null : parts.flatMap((p, i) => (p && p.length > 0 ? [<Fragment key={i}>{p}</Fragment>] : []));
  }, [props.dice]);
  const dice = useRef<HTMLSpanElement>(null);
  const plus = useRef<HTMLSpanElement>(null);
  const row = useRef<HTMLSpanElement>(null);
  const modeBox = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const line = row.current;
    if (!line) return;
    // Set on the nodes, not through state, so each trial and its answer land in one layout and no frame shows a part cutting the rest. The "+2" too: a count in state would run this again, and a count the "+2" moves back loops (ROLLER-185-LOOP).
    const fit = () => {
      const words = modeBox.current;
      const box = dice.current;
      const more = plus.current;
      if (words) words.style.display = "";
      if (box) box.style.display = "flex";
      if (more) more.style.display = "none";
      if (words && partCut(line, words)) words.style.display = "none";
      if (!box || !more) return;
      const faces = [...box.querySelectorAll<HTMLElement>("[data-face]")];
      const out = () => {
        const bottom = line.getBoundingClientRect().bottom;
        return (part: Element) => wrappedOut(part, bottom);
      };
      settleDropped((n) => {
        more.textContent = `+${n}`;
        more.style.display = n > 0 ? "inline-flex" : "none";
        return faces.filter(out()).length;
      });
      // With every part wrapped out of sight the box would still keep the room its shrink left it and its gap, which the label needs more (LP28-A-LINE-1).
      const parts = [...box.children].slice(1);
      if (parts.length > 0 && parts.every(out())) box.style.display = "none";
    };
    fit();
    // A web font that loads after the first fit changes the parts' widths, and no resize says so.
    void document.fonts?.ready.then(fit);
    if (typeof ResizeObserver === "undefined") return;
    // The row's own width is set from outside it, so showing or hiding a part never resizes it and calls this again.
    const observer = new ResizeObserver(fit);
    observer.observe(line);
    return () => observer.disconnect();
  }, [props.mode, props.label, props.level, props.verdict, props.sum, props.more, chips]);
  const muted = { fontSize: theme.font.small, color: theme.color.textMuted } as const;
  return (
    <span ref={row} style={dropsWhole()}>
      <LineStart />
      {props.sum ? <span style={{ flex: "none", ...muted, fontVariantNumeric: "tabular-nums" }}>{`(${props.sum})`}</span> : null}
      {/* With mode words after it, it grows only to its own width, so the words sit beside its last part rather than at the line's end. */}
      <span style={{ ...dropsWhole(true), ...(props.mode ? { maxWidth: "max-content" } : {}) }}>
        <LineStart reverse />
        {props.verdict ? (
          <span data-result-verdict="" style={{ flex: "none", ...muted }}>
            {props.verdict}
          </span>
        ) : null}
        {/* The chips the dice drop, as "+2": its words and whether it shows are set by the effect above. */}
        <span ref={plus} aria-hidden="true" style={{ ...FACE_CHIP, border: `${theme.line.border}px solid ${theme.color.border}`, color: theme.color.textMuted, display: "none" }} />
        {/* Grows only to its own width, so the parts after it sit beside it rather than at the line's end. */}
        <span style={{ flex: "1 1 0", minWidth: 0, maxWidth: "max-content", display: "flex", alignItems: "center", gap: theme.space(2), overflow: "hidden" }}>
          {/* A marked label is framed from inside, since every box around it cuts what reaches past its words (D-261030-527). */}
          {props.label ? (
            <span data-result-label="" {...markedBy(props.level, "frame")} style={{ flex: "0 10 auto", minWidth: 0, fontSize: theme.font.body14, overflow: "hidden", textOverflow: "ellipsis", ...proficiencyFrame(props.level) }}>
              {props.level ? <ProficiencyLabel level={props.level} bare>{props.label}</ProficiencyLabel> : props.label}
            </span>
          ) : null}
          {chips === null ? (
            // A stored formula that no longer parses shows as its text (rolledTerms).
            <span style={{ flex: "0 1000 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", ...muted }}>{props.dice.map((roll) => roll.formula).join(" + ")}</span>
          ) : chips.length > 0 || props.more > 0 ? (
            // A shrink far above the label's takes the dice's room first, down to nothing, before the label's "…".
            <span ref={dice} aria-hidden="true" style={{ position: "relative", flex: "0 1000 auto", minWidth: 0, height: REST_PX, overflow: "hidden", display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(1) }}>
              <LineStart dice />
              {chips}
              {props.more > 0 ? <span style={{ flex: "none", marginInlineStart: theme.space(1), ...muted }}>and {props.more} more</span> : null}
            </span>
          ) : null}
        </span>
      </span>
      {/* A stat block's mode words (BlockHeader.tsx) follow everything as one part. Where they would cut any other part they are hidden first, whole (the effect above). A description keeps them for a reader. */}
      {props.mode ? (
        <span ref={modeBox} aria-hidden="true" data-result-mode="" style={{ flex: "none", ...muted }}>
          {props.mode}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Whether a part of a one-row line, other than `skip`, is cut: wrapped onto
 * the row it never shows, or clipped inside its box, as a label ended in
 * "…" or dice that dropped chips.
 */
function partCut(line: HTMLElement, skip: HTMLElement): boolean {
  const bottom = line.getBoundingClientRect().bottom;
  for (const el of line.querySelectorAll<HTMLElement>("*")) {
    if (skip.contains(el)) continue;
    const r = el.getBoundingClientRect();
    // LineStart and other empty boxes hold no part.
    if (r.width === 0) continue;
    if (r.top >= bottom - 0.5) return true;
    if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== "visible") return true;
  }
  return false;
}

/** The formula field, Roll, the reading, the quick dice and the one-roll choices. */
export function Roller() {
  const roomId = useRoomView((s) => s.roomId);
  const selectedIds = useRoomView((s) => s.local.selectedIds);
  const dm = useRoomView((s) => s.you?.role === "dm");
  // Offline, or a preview as a player, which refuses every op: Roll waits and says why, as every option does.
  const blocked = useRollBlocked();
  const panel = useDicePanel();
  const throws = useThrows();
  const [text, setText] = useState("");
  // A formula only Roll sends keeps the sheet from a swipe's close, and the field clears once it goes (docs/design/design-v1-sheet-swipe.md 4.6).
  useUnsavedInput(text.trim() !== "");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(() => readHistory(roomId));
  // -1 while the field holds what is being typed, else the history entry shown.
  const [at, setAt] = useState(-1);
  const draft = useRef("");
  const receipt = useReceipt(sent);
  const busy = receipt !== null && (receipt.state === "sending" || receipt.state === "checking");
  const reading = useMemo(() => readingOf(text), [text]);
  const readingId = useId();
  const blockedId = useId();
  const field = useRef<HTMLInputElement>(null);
  const [shortPlaceholder, setShortPlaceholder] = useState(false);
  useLayoutEffect(() => {
    const el = field.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    // Only while the field is empty does the hint show, and a clear button's padding never narrows it.
    const measure = () => {
      if (el.value === "") setShortPlaceholder(!longHintFits(el));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    // A web font that loads after the first measure changes the words' width, and no resize says so.
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, []);
  // A formula the room search puts here unrolled (fill.ts), taken once, an ask made before the panel drew included.
  const fill = useScoped(diceFillSlot);
  const fillSeq = useStore(fill, (f) => f.seq);
  useLayoutEffect(() => {
    const asked = takeDiceFill(fill);
    if (asked === null) return;
    setText(asked);
    setAt(-1);
    setError(null);
  }, [fill, fillSeq]);

  const change = (next: string) => {
    setText(next);
    setError(null);
    setAt(-1);
  };

  const roll = (override?: RollModeOverride) => {
    if (busy || blocked !== null || text.trim() === "") return;
    const parsed = parseRollText(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const tag = panel.roll([{ formula: formatFormula(parsed.formula), ...(parsed.label !== undefined ? { label: parsed.label } : {}), sources: parsed.sources }], { origin: throws.origin(), override });
    if (tag === null) return;
    setSent(tag);
    const next = withHistory(history, text);
    setHistory(next);
    writeHistory(roomId, next);
    setText("");
    setAt(-1);
    draft.current = "";
  };

  const parsedMode = parseRollText(text);
  const presses = useRollPresses();
  // A typed "adv" or "dis" is a manual choice, which Roll normally drops as it does a pressed one.
  const typed = parsedMode.ok && parsedMode.sources.length > 0;
  const menu = useRollModeMenu({ source: JSON.stringify([text, selectedIds, panel.adv, panel.dis, panel.secret]), name: "Dice formula", title: text.trim() || undefined, capability: { d20: parsedMode.ok && acceptsRollMode(formatFormula(parsedMode.formula)), visibility: parsedMode.ok ? "selectable" : "creature", manual: { mode: presses.mode || typed, secret: presses.secret } }, disabled: busy || blocked !== null || text.trim() === "", dm, onTap: () => roll(), onRoll: roll });
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      roll();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (history.length === 0) return;
    e.preventDefault();
    if (at === -1) draft.current = text;
    const next = stepHistory(history, at, e.key === "ArrowUp" ? "up" : "down");
    setAt(next);
    setText(next === -1 ? draft.current : history[next]!);
    setError(null);
  };

  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ display: "flex", gap: theme.space(2), alignItems: "center" }}>
        <div style={{ position: "relative", flex: 1, minWidth: 0 }}>
          <Input
            ref={field}
            search="dice.formula"
            value={text}
            aria-label="Dice formula"
            aria-describedby={blocked !== null ? blockedId : reading || error ? readingId : undefined}
            aria-invalid={error ? true : undefined}
            placeholder={shortPlaceholder ? PLACEHOLDER.short : PLACEHOLDER.long}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            maxLength={200}
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKeyDown}
            style={{ width: "100%", paddingRight: text ? theme.touch : undefined }}
          />
          {text ? (
            <IconButton
              icon="close"
              label="Clear the formula"
              onClick={() => {
                change("");
                field.current?.focus();
              }}
              style={{ position: "absolute", right: 0, top: 0 }}
            />
          ) : null}
        </div>
        <Button variant="primary" size="sm" busy={busy} disabled={blocked !== null || text.trim() === ""} {...menu.buttonProps} style={menu.pressStyle}>
          {busy ? "Rolling…" : "Roll"}
        </Button>
      </div>
      {menu.menu}
      <div data-dice-note style={{ height: `${NOTE_LINE}em`, lineHeight: `${NOTE_LINE}em`, fontSize: theme.font.small, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {blocked !== null ? (
          <span id={blockedId} style={{ color: theme.color.textMuted }}>
            {blocked}
          </span>
        ) : error ? (
          <span id={readingId} role="alert" style={{ color: theme.color.dangerText }}>
            {error}
          </span>
        ) : reading?.ok ? (
          // A long formula or label cuts before the range, which is what the reading is for.
          <span id={readingId} style={{ display: "flex", minWidth: 0, color: theme.color.textMuted }}>
            <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{reading.text.slice(0, -reading.range.length)}</span>
            <span style={{ flex: "none" }}>{reading.range}</span>
          </span>
        ) : null}
      </div>
      <ScrollStrip aria-label="Quick dice" gap={theme.space(1)} edge={QUICK_EDGE} style={{ marginInline: -QUICK_EDGE }}>
        {QUICK_DICE.map((sides) => (
          <Button key={sides} size="sm" aria-label={`Add a d${sides}`} onClick={() => change(addDie(text, sides))} style={{ flex: "none", minWidth: theme.touch }}>
            d{sides}
          </Button>
        ))}
      </ScrollStrip>
      <RollModes adv={panel.adv} dis={panel.dis} secret={panel.secret} dm={dm} onPress={panel.press} />
      <p data-roll-mode-help="" style={{ margin: 0, fontSize: theme.font.small, color: theme.color.textMuted }}>Hold or right-click a roll button for one-roll options. Keyboard: Shift+F10.</p>
    </div>
  );
}

/** Where a toggle of the roll modes stands: the start or end of the joined Adv and Dis, or a pill of its own. */
type ModeShape = "start" | "end" | "pill";

const MODE_RADIUS: Record<ModeShape, string> = {
  start: `${theme.radius.pill}px 0 0 ${theme.radius.pill}px`,
  end: `0 ${theme.radius.pill}px ${theme.radius.pill}px 0`,
  pill: `${theme.radius.pill}px`,
};

/**
 * One half of the joined Adv and Dis: a chip's look (components/Chip.tsx)
 * with its outer corners round. The end half lies over the start half's
 * edge, so one 1 px line splits them. A pressed or focused half stands
 * above the other, so its accent outline and its focus ring show whole,
 * and the split line takes the pressed half's accent.
 */
function ModeHalf(props: { shape: Exclude<ModeShape, "pill">; pressed: boolean; label: string; search: string; focused: boolean; onFocus(on: boolean): void; onPress(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      data-search={props.search}
      aria-pressed={props.pressed}
      aria-label={props.label}
      onClick={props.onPress}
      onFocus={() => props.onFocus(true)}
      onBlur={() => props.onFocus(false)}
      style={{
        position: "relative",
        zIndex: props.focused ? 2 : props.pressed ? 1 : 0,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "none",
        minHeight: theme.touch,
        minWidth: theme.touch,
        padding: `0 ${theme.space(3)}px`,
        marginInlineStart: props.shape === "end" ? -theme.line.border : 0,
        borderRadius: MODE_RADIUS[props.shape],
        fontSize: theme.font.body14,
        fontWeight: theme.weight.strong,
        fontFamily: theme.font.body,
        whiteSpace: "nowrap",
        cursor: "pointer",
        ...choiceLook(props.pressed),
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * The one-roll choices (docs/design/design-v1-dice-pass.md 4): "Next roll" in the
 * section label's look, Advantage and Disadvantage joined as one choice of
 * two, as D&D Beyond's roll menu puts them, and Secret apart, since it
 * answers who sees the roll. The visible words sit inside the group's name,
 * "For the next roll", so the group is named once and a voice user who
 * says what they see still finds it.
 *
 * Where the row has no room for all three, Secret wraps under the pair and
 * fills its line, which a lone part may (docs/design/design-v1-polish.md 4). A
 * flex item grows only once it is known to be alone, and its growing never
 * moves where the line breaks, which its own width decides. Exported for
 * its render test.
 */
export function RollModes(props: { adv: boolean; dis: boolean; secret: boolean; dm: boolean; onPress(mode: "adv" | "dis" | "secret"): void }) {
  const pair = useRef<HTMLDivElement>(null);
  const secret = useRef<HTMLSpanElement>(null);
  const [wrapped, setWrapped] = useState(false);
  const [focused, setFocused] = useState<"adv" | "dis" | null>(null);
  useLayoutEffect(() => {
    const row = pair.current?.parentElement;
    if (!row || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const a = pair.current?.getBoundingClientRect();
      const b = secret.current?.getBoundingClientRect();
      if (a && b) setWrapped(b.top >= a.bottom);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, []);
  const focus = (mode: "adv" | "dis") => (on: boolean) => setFocused((f) => (on ? mode : f === mode ? null : f));
  return (
    <div role="group" aria-label="For the next roll" data-dice-modes="" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2) }}>
      <span aria-hidden="true" style={{ ...sectionLabelLook(), flex: "none" }}>
        Next roll
      </span>
      <div ref={pair} style={{ display: "flex", flex: "none" }}>
        <ModeHalf shape="start" pressed={props.adv} label="Advantage" search="dice.next.adv" focused={focused === "adv"} onFocus={focus("adv")} onPress={() => props.onPress("adv")}>
          Adv
        </ModeHalf>
        <ModeHalf shape="end" pressed={props.dis} label="Disadvantage" search="dice.next.dis" focused={focused === "dis"} onFocus={focus("dis")} onPress={() => props.onPress("dis")}>
          Dis
        </ModeHalf>
      </div>
      {/* A grid stretches the chip to the span's width, so the chip fills the line once the span grows. */}
      <span ref={secret} data-dice-secret="" style={{ display: "grid", flex: wrapped ? "1 1 auto" : "none" }}>
        <Chip pressed={props.secret} data-search="dice.next.secret" aria-label={props.dm ? "Hide from players" : "Only the DM sees it"} onClick={() => props.onPress("secret")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1) }}>
            <Icon name="hidden" size="sm" />
            Secret
          </span>
        </Chip>
      </span>
    </div>
  );
}
