import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { addDie, formatFormula, parseRollText } from "#shared/dice/formula.ts";
import { critSums, critSumText, labelText } from "#shared/logText.ts";
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
import { readHistory, readingOf, rollsOf, stepHistory, withHistory, writeHistory } from "./logic.ts";
import { FACE_CHIP, faceChips, rollVerdict } from "./RecentRolls.tsx";
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

// The d20 leads, as the die rolled most: at 130% on a phone the strip scrolls after d10, and at 100% after d12.
const QUICK_DICE = [20, 4, 6, 8, 10, 12, 100] as const;

/**
 * The newest panel roll, from the first roll on: "Rolling..." while it
 * waits, then its total, label, dice and Again, or the refusal's words. It
 * sticks to the scroller's top, as Initiative's round header does, so an
 * option rolled at the sheet's foot shows its result at the top too. A tap
 * on it opens the whole roll in Recent rolls.
 */
export function LastResult(props: { onOpen(lineId: string): void }) {
  const last = useLastRoll();
  const panel = useDicePanel();
  const tag = last && "tag" in last ? last.tag : null;
  const receipt = useReceipt(tag);
  const waiting = receipt !== null && (receipt.state === "sending" || receipt.state === "checking");
  const slow = useDelayed(waiting);
  const [said, setSaid] = useState("");
  const committed = receipt?.state === "committed" ? receipt : null;
  const rolls = useMemo(() => (committed ? rollsOf(committed.lines) : []), [committed]);
  const first = rolls[0];
  const firstLine = committed?.lines[0]?.id ?? null;
  // A polite live region says each result once: "Rolled 13: Longsword."
  useEffect(() => {
    if (first) setSaid(`Rolled ${first.total}${critSums([first])}${first.label ? `: ${labelText(first.label)}` : ""}.`);
  }, [first]);
  if (!last) return null;
  let body;
  if ("error" in last) body = <span role="alert" style={{ color: theme.color.dangerText }}>{last.error}</span>;
  // The shared delayed indicator: a quick answer never flashes "Rolling...".
  else if (!receipt || waiting)
    body = slow ? (
      <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(2), color: theme.color.textMuted }}>
        <Spinner size={16} /> Rolling…
      </span>
    ) : null;
  else if (receipt.state === "refused") body = <span role="alert" style={{ color: theme.color.dangerText }}>{receipt.text || receipt.message}</span>;
  else if (receipt.state === "unknown") body = <span style={{ color: theme.color.textMuted }}>This may have happened. Check the log.</span>;
  else if (!first) body = <span style={{ color: theme.color.textMuted }}>Rolled. Its result is no longer in the log.</span>;
  else {
    const verdict = rollVerdict(first, (committed?.lines[0]?.data?.type === "dice" ? committed.lines[0].data : {}) as { dc?: number; ac?: number });
    const sum = critSumText(first);
    const label = first.label !== undefined ? labelText(first.label) : "once" in last ? last.label : undefined;
    body = (
      <button
        type="button"
        onClick={() => firstLine && props.onOpen(firstLine)}
        aria-label={`Show this roll in Recent rolls`}
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0, flex: 1, minHeight: LAST_LINE_PX, overflow: "hidden", whiteSpace: "nowrap" }}
      >
        <span style={{ flex: "none", fontSize: theme.font.heading, fontWeight: theme.weight.bold, fontVariantNumeric: "tabular-nums" }}>{first.total.toLocaleString("en-US")}</span>
        <ResultRest sum={sum} label={label} faces={first} more={rolls.length - 1} verdict={verdict} />
      </button>
    );
  }
  const again = waiting ? null : againOf(last);
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
          <Button size="sm" variant="quiet" icon="again" style={{ flex: "none", minHeight: LAST_LINE_PX }} onClick={() => panel.again(again.rolls, again.to)}>
            Again
          </Button>
        ) : null}
      </div>
      <span role="status" aria-live="polite" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        {said}
      </span>
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
function ResultRest(props: { sum: string | null; label: string | undefined; faces: Parameters<typeof faceChips>[0]; more: number; verdict: string | null }) {
  const chips = useMemo(() => faceChips(props.faces), [props.faces]);
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
            <span style={{ flex: "0 1000 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", ...muted }}>{props.faces.formula}</span>
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
    const tag = panel.roll([{ formula: formatFormula(parsed.formula), ...(parsed.label !== undefined ? { label: parsed.label } : {}), sources: parsed.sources }]);
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
            aria-describedby={[reading || error ? readingId : "", blocked === null ? "" : blockedId].filter(Boolean).join(" ") || undefined}
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
      {blocked !== null ? (
        <span id={blockedId} style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
          {blocked}
        </span>
      ) : null}
      {error ? (
        <span id={readingId} role="alert" style={{ fontSize: theme.font.small, color: theme.color.dangerText }}>
          {error}
        </span>
      ) : reading?.ok ? (
        <span id={readingId} style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>
          {reading.text}
        </span>
      ) : null}
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
