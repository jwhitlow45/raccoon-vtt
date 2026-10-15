import { useId, type MouseEvent, type ReactNode, type Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Spinner } from "./Loading.tsx";

/**
 * A setting that is on or off and takes effect at once
 * (docs/design-v1-visual.md 2.3 and 3.7): the whole row is one button with
 * `role="switch"`, so a tap anywhere on it flips the setting and Space or
 * Enter does from the keyboard. Its accessible name is the setting's name
 * and never changes with its state: the state is `aria-checked`, and the
 * help is the description. A button named by its state ("Fog is off")
 * read as an action, which is why the panels' settings all move here.
 *
 * `busy` is a change waiting for the server: the row takes no second tap
 * and shows a spinner beside the track, at full strength so it reads.
 */
export function Switch(props: {
  ref?: Ref<HTMLButtonElement>;
  label: string;
  help?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  busy?: boolean;
  onChange(checked: boolean): void;
}) {
  const nameId = useId();
  const helpId = useId();
  const { checked, disabled, busy } = props;
  const nameColor = disabled ? theme.color.textDisabled : theme.color.text;
  return (
    <button
      ref={props.ref}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={nameId}
      aria-describedby={props.help ? helpId : undefined}
      aria-busy={busy ? true : undefined}
      disabled={disabled}
      onClick={(e: MouseEvent<HTMLButtonElement>) => {
        if (busy) {
          e.preventDefault();
          return;
        }
        props.onChange(!checked);
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(3),
        width: "100%",
        minHeight: theme.touch,
        padding: `${theme.space(2)}px 0`,
        background: "transparent",
        border: "none",
        color: nameColor,
        textAlign: "left",
        fontFamily: theme.font.body,
        cursor: disabled || busy ? "default" : "pointer",
      }}
    >
      <span style={{ flex: 1, minWidth: 0, display: "grid", gap: theme.space(0.5) }}>
        <span id={nameId} style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight }}>
          {props.label}
        </span>
        {props.help ? (
          <span id={helpId} style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: disabled ? theme.color.textDisabled : theme.color.textMuted }}>
            {props.help}
          </span>
        ) : null}
      </span>
      {busy ? <Spinner size={theme.icon.sm} /> : null}
      <SwitchTrack on={checked} disabled={disabled} />
    </button>
  );
}

/**
 * The 46 x 28 track with its 20 px knob. On: the accent, with the knob in
 * `onAccent`, which accentFor keeps at 4.5:1 for any member color. Off: a
 * raised track with a `controlBorder` outline, which identifies the
 * control at 3:1. Disabled: a quiet outline and a dim knob, still at its
 * on or off end, so the state stays readable.
 */
export function SwitchTrack(props: { on: boolean; disabled?: boolean }) {
  const { on, disabled } = props;
  const track = disabled
    ? { background: theme.color.surfaceRaised, borderColor: theme.color.border }
    : on
      ? { background: theme.color.accent, borderColor: theme.color.accent }
      : { background: theme.color.surfaceRaised, borderColor: theme.color.controlBorder };
  const knob = disabled ? theme.color.textDisabled : on ? theme.color.onAccent : theme.color.textMuted;
  return (
    <span
      aria-hidden
      style={{
        flex: "none",
        position: "relative",
        width: 46,
        height: 28,
        borderRadius: theme.radius.pill,
        borderWidth: theme.line.border,
        borderStyle: "solid",
        ...track,
        transition: "background 120ms",
      }}
    >
      <span
        data-knob=""
        style={{
          position: "absolute",
          top: 3,
          left: on ? 21 : 3,
          width: 20,
          height: 20,
          borderRadius: theme.radius.round,
          background: knob,
          transition: "left 120ms",
        }}
      />
    </span>
  );
}
