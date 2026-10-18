import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { addDie, formatFormula, parseRollText } from "#shared/dice/formula.ts";
import { Button } from "../../components/Button.tsx";
import { Chip } from "../../components/Chip.tsx";
import { Input } from "../../components/Field.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Spinner, useDelayed } from "../../components/Loading.tsx";
import { ScrollStrip } from "../../components/ScrollStrip.tsx";
import { useUnsavedInput } from "../../lib/sheetSwipe.ts";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { readHistory, readingOf, rollsOf, stepHistory, withHistory, writeHistory } from "./logic.ts";
import { DiceFaces, rollVerdict } from "./RecentRolls.tsx";
import { useDicePanel, useLastRoll } from "./useDicePanel.ts";
import { useRollBlocked } from "./useRollOption.ts";
import { useReceipt } from "./useReceipt.ts";

/**
 * The top of the Dice panel (docs/design-v1-dice.md 8.2): the newest panel
 * roll, sticky at the scroller's top, then the formula field with Roll, its
 * reading, the quick dice and the one-roll choices.
 */

/** The scrolling pane's padding, which its body publishes (components/Sheet.tsx paneBodyPadding). 0 outside a pane. */
const PAD_TOP = "var(--pane-pad-top, 0px)";
const PAD_X = "var(--pane-pad-x, 0px)";
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
    if (first) setSaid(`Rolled ${first.total}${first.label ? `: ${first.label}` : ""}.`);
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
    body = (
      <button
        type="button"
        onClick={() => firstLine && props.onOpen(firstLine)}
        aria-label={`Show this roll in Recent rolls`}
        style={{ all: "unset", cursor: "pointer", display: "flex", alignItems: "center", gap: theme.space(2), minWidth: 0, flex: 1, minHeight: LAST_LINE_PX, overflow: "hidden", whiteSpace: "nowrap" }}
      >
        <span style={{ fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>{first.total.toLocaleString("en-US")}</span>
        {first.label ? <span style={{ fontSize: theme.font.body14, overflow: "hidden", textOverflow: "ellipsis" }}>{first.label}</span> : null}
        <span style={{ overflow: "hidden" }}>
          <DiceFaces result={first} oneLine />
        </span>
        {verdict ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{verdict}</span> : null}
        {rolls.length > 1 ? <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>and {rolls.length - 1} more</span> : null}
      </button>
    );
  }
  const again = "tag" in last && !waiting ? last : null;
  return (
    <div
      data-dice-last=""
      style={{
        position: "sticky",
        top: `calc(-1 * ${PAD_TOP})`,
        zIndex: theme.z.stickyHeader,
        margin: `calc(-1 * ${PAD_TOP}) calc(-1 * ${PAD_X}) 0`,
        padding: `${PAD_TOP} ${PAD_X} 0`,
        background: theme.color.surface,
        borderBottom: `${theme.line.border}px solid ${theme.color.border}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minHeight: LAST_LINE_PX, fontSize: theme.font.body14 }}>
        <div style={{ display: "flex", alignItems: "center", flex: 1, minWidth: 0 }}>{body}</div>
        {again ? (
          <Button size="sm" variant="quiet" icon="redo" style={{ minHeight: LAST_LINE_PX }} onClick={() => panel.again(again.rolls, again.to)}>
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
          Secret
        </Chip>
      </div>
    </div>
  );
}
