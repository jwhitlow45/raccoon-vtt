import { Fragment, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { addDie, formatFormula, parseRollText } from "#shared/dice/formula.ts";
import { labelText } from "#shared/logText.ts";
import type { DiceRoll, LogEntry } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Chip } from "../../components/Chip.tsx";
import { Input } from "../../components/Field.tsx";
import { Icon } from "../../components/Icon.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Spinner, useDelayed } from "../../components/Loading.tsx";
import { ScrollStrip } from "../../components/ScrollStrip.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { answerVerdict, headerRoll, readHistory, readingOf, rollsOf, rollVerdict, stepHistory, withHistory, writeHistory, type HeaderRoll } from "./logic.ts";
import { critical } from "./options.ts";
import { FACE_CHIP, faceChips } from "./RecentRolls.tsx";
import { Tray } from "./throw/Tray.tsx";
import { useThrows, useThrowView } from "./throw/useThrows.ts";
import { againOf, useDicePanel, useLastRoll } from "./useDicePanel.ts";
import { useRollBlocked } from "./useRollOption.ts";
import { useReceipt } from "./useReceipt.ts";

/**
 * The top of the Dice panel (docs/design-v1-dice.md 8.2): the newest panel
 * roll, sticky at the scroller's top, then the formula field with Roll, its
 * reading, the quick dice and the one-roll choices.
 */

/** The scrolling pane's top padding, which its body publishes (components/Sheet.tsx paneBodyPadding). 0 outside a pane. */
const PAD_TOP = "var(--pane-pad-top, 0px)";
/** The sticky line's height (Appendix C). */
export const LAST_LINE_PX = 40;

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

/** The header line's verdict: an answer's pass or fail as its player reads it, else a dice line's against its DC or AC. */
function shownVerdict(roll: DiceRoll, data: LogEntry["data"]): string | null {
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

/** The live region's words for a result, said once at the answer: "Rolled 23, Critical Hit: Longsword." */
export function spokenResult(head: HeaderRoll, verdict: string | null): string {
  return `Rolled ${head.total}${head.sums ? ` (${head.sums})` : ""}${verdict ? `, ${verdict}` : ""}${head.label ? `: ${labelText(head.label)}` : ""}.`;
}

/**
 * The newest panel roll, from the first roll on: "Rolling..." while it
 * waits, then its total, label, dice and Again, or the refusal's words. It
 * sticks to the scroller's top, as Initiative's round header does, so an
 * option rolled at the sheet's foot shows its result at the top too. A tap
 * on it opens the whole roll in Recent rolls.
 *
 * A roll the panel throws holds its result until the dice land
 * (docs/design-v1-roll-animation.md 3.4): the live region says it at once,
 * and the line shows it 1 s later, or at once on any tap or key. Again
 * stays as a busy button while the roll waits, so a keyboard press keeps
 * its focus, and is live from the answer on.
 */
export function LastResult(props: { onOpen(lineId: string): void }) {
  const last = useLastRoll();
  const panel = useDicePanel();
  const throws = useThrows();
  const thrown = useThrowView();
  const tag = last && "tag" in last ? last.tag : null;
  const holding = tag !== null && thrown.held === tag;
  const receipt = useReceipt(tag);
  const waiting = receipt !== null && (receipt.state === "sending" || receipt.state === "checking");
  const slow = useDelayed(waiting);
  const committed = receipt?.state === "committed" ? receipt : null;
  const rolls = useMemo(() => (committed ? rollsOf(committed.lines) : []), [committed]);
  const first = rolls[0];
  const head = useMemo(() => headerRoll(rolls), [rolls]);
  const firstLine = committed?.lines[0]?.id ?? null;
  const data = committed?.lines[0]?.data;
  // A polite live region says each result once, from the render that first holds it, so it is said as it lands on the server even while the dice still fly.
  const said = first && head ? spokenResult(head, spokenVerdict(first, data)) : "";
  if (!last) return null;
  const rollingNote = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2), color: theme.color.textMuted }}>
      <Spinner size={16} /> Rolling…
    </span>
  );
  let body;
  if ("error" in last) body = <span role="alert" style={{ color: theme.color.dangerText }}>{last.error}</span>;
  // The shared delayed indicator: a quick answer never flashes "Rolling...".
  else if (!receipt || waiting) body = slow ? rollingNote : null;
  // The dice are in the air: the line stays as it was, "Rolling…" only where the wait was long enough to say it.
  else if (receipt.state === "committed" && holding) body = thrown.rolling ? rollingNote : null;
  else if (receipt.state === "refused") body = <span role="alert" style={{ color: theme.color.dangerText }}>{receipt.text || receipt.message}</span>;
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
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0, flex: 1, minHeight: LAST_LINE_PX, overflow: "hidden", whiteSpace: "nowrap" }}
      >
        <span style={{ flex: "none", fontSize: theme.font.heading, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>{head.total.toLocaleString("en-US")}</span>
        <ResultRest sum={head.sums} label={label} dice={head.dice} more={head.more} verdict={verdict} />
      </button>
    );
  }
  const again = againOf(last);
  return (
    <div
      data-dice-last=""
      style={{
        position: "sticky",
        top: `calc(-1 * ${PAD_TOP})`,
        zIndex: theme.z.stickyHeader,
        // Only the top takes the pane's padding back, so nothing scrolls past above the line. Sideways it keeps to the column, as every row does (docs/design-v1-dice-ui.md 3.1).
        margin: `calc(-1 * ${PAD_TOP}) 0 0`,
        padding: `${PAD_TOP} 0 0`,
        background: theme.color.surface,
        borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
        // A grid item's floor is its content's width, and one line of a long label would widen the whole panel sideways. This lets it ellipsize instead.
        minWidth: 0,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minHeight: LAST_LINE_PX, fontSize: theme.font.body14 }}>
        <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>{body}</div>
        {again ? (
          <Button size="sm" variant="quiet" icon="again" busy={waiting} style={{ flex: "none", minHeight: LAST_LINE_PX }} onClick={() => panel.again(again.rolls, again.to, throws.origin())}>
            Again
          </Button>
        ) : null}
      </div>
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
 * critical hit's sum. The total and Again stay. Each step is a box inside
 * the last, so a part gives up nothing while one before it in turn still
 * has room (docs/design-v1-dice-ui.md 4.1).
 */
function ResultRest(props: { sum: string | null; label: string | undefined; dice: readonly DiceRoll[]; more: number; verdict: string | null }) {
  // A damage of several types shows every part's dice, each part keyed apart since each restarts its chips' keys.
  const chips = useMemo(() => {
    const parts = props.dice.map((roll) => faceChips(roll));
    return parts.some((p) => p === null) ? null : parts.flatMap((p, i) => (p && p.length > 0 ? [<Fragment key={i}>{p}</Fragment>] : []));
  }, [props.dice]);
  const dice = useRef<HTMLSpanElement>(null);
  const [dropped, setDropped] = useState(0);
  useLayoutEffect(() => {
    const el = dice.current;
    if (!el) {
      setDropped(0);
      return;
    }
    const count = () => setDropped([...el.querySelectorAll<HTMLElement>("[data-face]")].filter((chip) => chip.offsetTop > 0).length);
    count();
    const observer = new ResizeObserver(count);
    observer.observe(el);
    return () => observer.disconnect();
  }, [chips]);
  const muted = { fontSize: theme.font.small, color: theme.color.textMuted } as const;
  return (
    <span style={dropsWhole()}>
      <LineStart />
      {props.sum ? <span style={{ flex: "none", ...muted, fontVariantNumeric: "tabular-nums" }}>{`(${props.sum})`}</span> : null}
      <span style={dropsWhole(true)}>
        <LineStart reverse />
        {props.verdict ? <span style={{ flex: "none", ...muted }}>{props.verdict}</span> : null}
        {dropped > 0 ? (
          <span aria-hidden="true" style={{ ...FACE_CHIP, border: `${theme.line.border}px solid ${theme.color.border}`, color: theme.color.textMuted }}>
            +{dropped}
          </span>
        ) : null}
        {/* Grows only to its own width, so the parts after it sit beside it rather than at the line's end. */}
        <span style={{ flex: "1 1 0", minWidth: 0, maxWidth: "max-content", display: "flex", alignItems: "center", gap: theme.space(2), overflow: "hidden" }}>
          {props.label ? <span style={{ flex: "0 10 auto", minWidth: 0, fontSize: theme.font.body14, overflow: "hidden", textOverflow: "ellipsis" }}>{props.label}</span> : null}
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
    </span>
  );
}

/** The formula field, Roll, the reading, the quick dice and the one-roll choices. */
export function Roller() {
  const roomId = useRoomView((s) => s.roomId);
  const dm = useRoomView((s) => s.you?.role === "dm");
  // Offline, or a preview as a player, which refuses every op: Roll waits and says why, as every option does.
  const blocked = useRollBlocked();
  const panel = useDicePanel();
  const throws = useThrows();
  const [text, setText] = useState("");
  // A formula only Roll sends keeps the sheet from a swipe's close, and the field clears once it goes (docs/design-v1-sheet-swipe.md 4.6).
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

  const change = (next: string) => {
    setText(next);
    setError(null);
    setAt(-1);
  };

  const roll = () => {
    if (busy || blocked !== null || text.trim() === "") return;
    const parsed = parseRollText(text);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    const tag = panel.roll([{ formula: formatFormula(parsed.formula), ...(parsed.label !== undefined ? { label: parsed.label } : {}), sources: parsed.sources }], { origin: throws.origin() });
    if (tag === null) return;
    setSent(tag);
    const next = withHistory(history, text);
    setHistory(next);
    writeHistory(roomId, next);
    setText("");
    setAt(-1);
    draft.current = "";
  };

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
            value={text}
            aria-label="Dice formula"
            aria-describedby={blocked !== null ? blockedId : reading || error ? readingId : undefined}
            aria-invalid={error ? true : undefined}
            placeholder="1d20+5 or 2d6+3 fire"
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
        <Button variant="primary" size="sm" busy={busy} disabled={blocked !== null || text.trim() === ""} onClick={roll}>
          {busy ? "Rolling…" : "Roll"}
        </Button>
      </div>
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
      <ScrollStrip aria-label="Quick dice" gap={theme.space(1)}>
        {QUICK_DICE.map((sides) => (
          <Button key={sides} size="sm" aria-label={`Add a d${sides}`} onClick={() => change(addDie(text, sides))} style={{ flex: "none", minWidth: theme.touch }}>
            d{sides}
          </Button>
        ))}
      </ScrollStrip>
      <div role="group" aria-label="For the next roll" style={{ display: "flex", gap: theme.space(1), flexWrap: "wrap" }}>
        <Chip pressed={panel.adv} aria-label="Advantage" onClick={() => panel.press("adv")}>
          Adv
        </Chip>
        <Chip pressed={panel.dis} aria-label="Disadvantage" onClick={() => panel.press("dis")}>
          Dis
        </Chip>
        <Chip pressed={panel.secret} aria-label={dm ? "Hide from players" : "Only the DM sees it"} onClick={() => panel.press("secret")}>
          <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1) }}>
            <Icon name="hidden" size="sm" />
            Secret
          </span>
        </Chip>
      </div>
    </div>
  );
}
