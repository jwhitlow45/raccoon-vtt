import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Button } from "../../components/Button.tsx";
import { fieldStyle } from "../../components/Field.tsx";
import { useHeld } from "../../components/Held.tsx";
import { accessibleName } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";

/**
 * Small controls shared by the Scenes panel, the light pane and the phases
 * section. Every target is at least 44 px and every input 16 px text
 * (design 14.4). They draw from the shared Button and field look
 * (components/), so they look like the rest of the app.
 */

export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  /** The room search's anchor id (features/search/entry.ts), set as `data-search` on the select. */
  search?: string;
}) {
  const disabled = useHeld();
  return (
    <select
      aria-label={props.label}
      data-search={props.search}
      value={props.value}
      disabled={disabled}
      onChange={(e) => props.onChange(e.target.value as T)}
      style={{ ...fieldStyle({ disabled }), flex: "none", padding: `0 ${theme.space(2)}px` }}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

const inputStyle = (disabled: boolean): CSSProperties => ({ ...fieldStyle({ disabled }), padding: `0 ${theme.space(2)}px` });

/** A whole number typed in, kept as text while editing so a field can be cleared and retyped. */
export function NumberInput(props: { label: string; value: number; min: number; max: number; onChange(value: number): void; width?: number }) {
  const [text, setText] = useState(String(props.value));
  const disabled = useHeld();
  useEffect(() => setText(String(props.value)), [props.value]);
  const commit = (raw: string) => {
    const n = Math.round(Number(raw));
    if (raw.trim() === "" || !Number.isFinite(n)) {
      setText(String(props.value));
      return;
    }
    const clamped = Math.min(props.max, Math.max(props.min, n));
    setText(String(clamped));
    if (clamped !== props.value) props.onChange(clamped);
  };
  return (
    <input
      aria-label={props.label}
      inputMode="numeric"
      value={text}
      disabled={disabled}
      onChange={(e) => setText(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
      }}
      style={{ ...inputStyle(disabled), width: props.width ?? 64, textAlign: "center" }}
    />
  );
}

/**
 * A value that sends an op while it is being dragged would flood the room,
 * so color pickers and sliders show their value at once and send it a moment
 * after the last change.
 */
export function useDebounced<T>(value: T, send: (v: T) => void, ms = 250): [T, (v: T) => void] {
  const [local, setLocal] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const pending = useRef<{ v: T } | null>(null);
  useEffect(() => {
    if (!pending.current) setLocal(value);
  }, [value]);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (pending.current) sendRef.current(pending.current.v);
    },
    [],
  );
  const set = (v: T) => {
    setLocal(v);
    pending.current = { v };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      const p = pending.current;
      pending.current = null;
      if (p) sendRef.current(p.v);
    }, ms);
  };
  return [local, set];
}

export function ColorInput(props: { label: string; value: string; onChange(value: string): void }) {
  const [local, set] = useDebounced(props.value, props.onChange);
  const disabled = useHeld();
  return (
    <input
      type="color"
      aria-label={props.label}
      disabled={disabled}
      value={/^#[0-9a-fA-F]{6}$/.test(local) ? local : theme.color.white}
      onChange={(e) => set(e.target.value)}
      style={{
        width: theme.touch,
        height: theme.touch,
        padding: theme.space(0.5),
        border: `${theme.line.border}px solid ${disabled ? theme.color.border : theme.color.controlBorder}`,
        borderRadius: theme.radius.md,
        background: theme.color.bg,
        flex: "none",
      }}
    />
  );
}

export function Slider(props: { label: string; value: number; min: number; max: number; step: number; onChange(value: number): void; format?(v: number): string }) {
  const [local, set] = useDebounced(props.value, props.onChange);
  const id = useId();
  const disabled = useHeld();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), minHeight: theme.touch, flex: 1, minWidth: 0 }}>
      <label htmlFor={id} style={{ fontSize: theme.font.body14, color: disabled ? theme.color.textDisabled : theme.color.text, flex: "none", minWidth: 72 }}>
        {props.label}
      </label>
      <input
        id={id}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={local}
        disabled={disabled}
        onChange={(e) => set(Number(e.target.value))}
        style={{ flex: 1, minWidth: 0, height: theme.touch, accentColor: disabled ? theme.color.textDisabled : theme.color.accent }}
      />
      <span style={{ fontSize: theme.font.small, color: disabled ? theme.color.textDisabled : theme.color.textMuted, flex: "none", minWidth: 36, textAlign: "right" }}>
        {props.format ? props.format(local) : String(local)}
      </span>
    </div>
  );
}

/**
 * A button that asks for a second tap before it acts, for actions that wipe
 * something out (fog everything, clear the build). No dialog, so it works the
 * same with a thumb and a mouse. `wrap` lets armed words longer than the
 * line wrap inside the button, which grows taller, as the token panel's
 * ConfirmButton does (features/tokens/ui.tsx), rather than run past the
 * panel's edge or be cut, since they say what the second tap takes.
 */
export function ConfirmButton(props: { label: string; confirm: string; title?: string; onConfirm(): void; disabled?: boolean; shrink?: boolean; wrap?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  const label = armed ? props.confirm : props.label;
  return (
    <Button
      size="sm"
      variant="danger"
      armed={armed}
      title={props.title}
      aria-label={accessibleName(label, props.title)}
      disabled={props.disabled}
      onClick={() => {
        if (armed) {
          setArmed(false);
          props.onConfirm();
        } else {
          setArmed(true);
        }
      }}
      style={
        props.shrink
          ? { flex: "0 1 auto", minWidth: 0, maxWidth: "100%" }
          : props.wrap
            ? { flex: "none", minWidth: 0, maxWidth: "100%", whiteSpace: "normal", overflowWrap: "anywhere", textAlign: "center" }
            : { flex: "none", whiteSpace: "nowrap" }
      }
    >
      {props.shrink ? <span style={{ display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span> : label}
    </Button>
  );
}
