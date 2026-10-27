import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import type { ScenePreset } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Spinner } from "../../components/Loading.tsx";
import { Note } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { PLAYERS_SEE, PLAYERS_SEE_NAME } from "./playersSeeRules.ts";

export type PlayersSeeValue = ScenePreset | "like";

type Option = { value: PlayersSeeValue; label: string; help: string };

/**
 * Players see (docs/design-v1-map-discovery.md 8.1 and 9): one option a
 * row, each a card of at least 44 px whose help wraps inside it, as Room
 * settings' choices are. The group is a radio group named Players see and
 * described by the chosen option's help, or by `none` while nothing is
 * chosen (Custom). Each radio is named by its option's name alone, with
 * its help as its description, so "Explore" finds it.
 *
 * `like` adds the new scene form's fourth option, named for the scene on
 * the DM's screen and described by what it copies. While `busy`, a change
 * on its way, a tap does nothing and `working` (the caller's, after the
 * shared delay) says what the server is doing.
 */
export function PlayersSeeChoice(props: {
  value: PlayersSeeValue | null;
  like?: { name: string; summary: string } | null;
  /** The words that describe the group while no option is chosen, kept mounted as a polite status. */
  none?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  working?: string | null;
  onChange(value: PlayersSeeValue): void;
}) {
  const name = useId();
  const nameId = useId();
  const noneId = useId();
  const optionId = useId();
  const options: Option[] = [...PLAYERS_SEE, ...(props.like ? [{ value: "like" as const, label: `Like ${props.like.name}`, help: props.like.summary }] : [])];
  const chosen = options.findIndex((o) => o.value === props.value);
  const describedBy = chosen >= 0 ? `${optionId}-help-${chosen}` : noneId;
  const { disabled } = props;
  return (
    // No gap of its own: the status under the options is mounted while empty, and only what it says takes room.
    <div style={{ display: "grid", minWidth: 0 }}>
      <span id={nameId} style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, color: disabled ? theme.color.textDisabled : theme.color.text }}>
        {PLAYERS_SEE_NAME}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={nameId}
        aria-describedby={describedBy}
        aria-busy={props.busy ? true : undefined}
        aria-disabled={disabled ? true : undefined}
        style={{ display: "grid", gap: theme.space(1), marginTop: theme.space(1), minWidth: 0 }}
      >
        {options.map((o, i) => {
          const on = i === chosen;
          const look: CSSProperties = disabled
            ? { border: `${theme.line.border}px solid ${theme.color.border}`, background: "transparent", color: theme.color.textDisabled }
            : on
              ? { border: `${theme.line.border}px solid ${theme.color.accent}`, background: theme.color.accentTint, color: theme.color.text }
              : { border: `${theme.line.border}px solid ${theme.color.border}`, background: "transparent", color: theme.color.text };
          return (
            <label
              key={o.value}
              style={{
                display: "flex",
                alignItems: "center",
                gap: theme.space(3),
                minHeight: theme.touch,
                minWidth: 0,
                padding: `${theme.space(1)}px ${theme.space(2)}px`,
                borderRadius: theme.radius.md,
                cursor: disabled ? "default" : "pointer",
                ...look,
              }}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={on}
                disabled={disabled}
                aria-labelledby={`${optionId}-name-${i}`}
                aria-describedby={`${optionId}-help-${i}`}
                // While a change is on its way the radios stay as the scene is: the controlled `checked` puts back a tap.
                onChange={() => {
                  if (!props.busy) props.onChange(o.value);
                }}
                style={{ width: 20, height: 20, margin: 0, flex: "none", accentColor: theme.color.accent }}
              />
              <span style={{ display: "grid", gap: theme.space(0.5), minWidth: 0 }}>
                <span id={`${optionId}-name-${i}`} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong, overflowWrap: "anywhere" }}>
                  {o.label}
                </span>
                <span
                  id={`${optionId}-help-${i}`}
                  style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: disabled ? theme.color.textDisabled : theme.color.textMuted, overflowWrap: "anywhere" }}
                >
                  {o.help}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {/* Mounted while empty, so a screen reader hears Custom or the work in hand as they come. Only what it says takes room. */}
      <div role="status" style={{ display: "grid", minWidth: 0, ...(props.working || (chosen < 0 && props.none) ? { marginTop: theme.space(1) } : null) }}>
        {props.working ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1), fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>
            <Spinner size={theme.icon.sm} />
            {props.working}
          </span>
        ) : null}
        <span id={noneId} style={chosen >= 0 || !props.none ? { display: "none" } : { fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.warning, overflowWrap: "anywhere" }}>
          {chosen >= 0 ? null : props.none}
        </span>
      </div>
    </div>
  );
}

/** A warning in a polite status kept mounted, so it is heard as it comes. Empty, it takes no room. */
export function WarningStatus(props: { text: string | null }) {
  return (
    <div role="status" style={props.text ? { marginTop: theme.space(1) } : undefined}>
      {props.text ? <Note>{props.text}</Note> : null}
    </div>
  );
}

/**
 * The question a change that forgets something asks first, under the
 * control that asked (8.1): its words in a polite status kept mounted,
 * then Cancel and Change. Focus stays on the control through the question,
 * as an untick's does, and Escape anywhere around it answers no (`useAsk`).
 */
export function AskFirst(props: { question: string | null; label: string; busy?: boolean; onCancel(): void; onConfirm(): void }) {
  const open = props.question !== null;
  // Closed, only the empty status is left, which takes no room in its control's box.
  return (
    <div
      role={open ? "group" : undefined}
      aria-label={open ? props.label : undefined}
      style={
        open
          ? {
              display: "grid",
              gap: theme.space(2),
              marginTop: theme.space(2),
              padding: theme.space(3),
              borderRadius: theme.radius.md,
              border: `${theme.line.border}px solid ${theme.color.border}`,
              background: theme.color.bg,
              minWidth: 0,
            }
          : undefined
      }
    >
      <p role="status" style={{ margin: 0, fontSize: theme.font.body14, lineHeight: theme.leading.body, overflowWrap: "anywhere" }}>
        {props.question}
      </p>
      {open ? (
        <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
          <Button size="sm" onClick={props.onCancel}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" busy={props.busy} onClick={props.onConfirm}>
            Change
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/**
 * A question's state for one place: what it asks, the change it holds, and
 * the element that had focus when it opened, which gets it back once
 * answered, as long as it is still on the page.
 */
export function useAsk<T>(): {
  asking: { text: string; change: T } | null;
  ask(text: string, change: T): void;
  answer(): T | null;
  cancel(): void;
  onKeyDown(e: KeyboardEvent<HTMLElement>): void;
} {
  const [asking, setAsking] = useState<{ text: string; change: T } | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const back = () => {
    const el = opener.current;
    opener.current = null;
    if (el?.isConnected) el.focus();
  };
  const cancel = () => {
    setAsking(null);
    back();
  };
  return {
    asking,
    ask: (text, change) => {
      if (!asking) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setAsking({ text, change });
    },
    answer: () => {
      const change = asking?.change ?? null;
      setAsking(null);
      back();
      return change;
    },
    cancel,
    onKeyDown: (e) => {
      if (!asking || e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      cancel();
    },
  };
}
