import { useId, type CSSProperties, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { theme } from "../lib/theme.ts";

/**
 * The look of every text, number and select field (docs/design-v1-visual.md
 * 2.3): 16 px text, because iOS zooms the whole page when an input with
 * smaller text gets focus (design section 14.4), 44 px tall, a `bg` fill
 * and a `controlBorder` outline, which shows the field's edge at 3:1 on
 * any surface where the old `border` showed it at 1.5:1. An error draws a
 * `danger` outline. A disabled field keeps its place with a quiet outline
 * and a dim value, never a fade.
 */
export function fieldStyle(state: { error?: boolean; disabled?: boolean } = {}): CSSProperties {
  return {
    minHeight: theme.touch,
    minWidth: 0,
    padding: `0 ${theme.space(3)}px`,
    borderRadius: theme.radius.md,
    border: `${theme.line.border}px solid ${state.error ? theme.color.danger : state.disabled ? theme.color.border : theme.color.controlBorder}`,
    background: theme.color.bg,
    color: state.disabled ? theme.color.textDisabled : theme.color.text,
    fontSize: theme.font.input,
    fontFamily: theme.font.body,
  };
}

/** A number field's width in a FieldRow, right aligned so digits line up down a panel. */
export const NUMBER_FIELD_WIDTH = 88;

/** A plain input in the field look, for a place that labels it another way (`aria-label`, a FieldRow). */
export function Input(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement>; error?: boolean }) {
  const { error, style, ...rest } = props;
  const number = props.type === "number";
  return (
    <input
      aria-invalid={error ? true : undefined}
      {...rest}
      style={{ ...fieldStyle({ error, disabled: props.disabled }), ...(number ? { width: NUMBER_FIELD_WIDTH, textAlign: "right" } : null), ...style }}
    />
  );
}

/** A native select in the field look. Native, since it is the best picker on a phone, and `color-scheme` draws its menu dark. */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement>; error?: boolean }) {
  const { error, style, ...rest } = props;
  return <select aria-invalid={error ? true : undefined} {...rest} style={{ ...fieldStyle({ error, disabled: props.disabled }), ...style }} />;
}

/** A text area in the field look, growing from three lines. */
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement>; error?: boolean }) {
  const { error, style, ...rest } = props;
  return (
    <textarea
      aria-invalid={error ? true : undefined}
      rows={3}
      {...rest}
      style={{ ...fieldStyle({ error, disabled: props.disabled }), padding: `${theme.space(2)}px ${theme.space(3)}px`, lineHeight: theme.leading.body, resize: "vertical", ...style }}
    />
  );
}

/**
 * A labeled text input for pages and dialogs: the label above at 14 px
 * weight 600, the field under it, and a hint or an error under that. The
 * error is an alert in `dangerText`, which reads 5.9:1 on a surface where
 * `danger` read 4.2:1.
 */
export function Field(
  props: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | null; trailing?: ReactNode; ref?: Ref<HTMLInputElement> },
) {
  const { label, hint, error, trailing, style, ...rest } = props;
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div style={{ display: "grid", gap: theme.space(1) }}>
      <label htmlFor={id} style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>
        {label}
      </label>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <input
          id={id}
          aria-describedby={hint || error ? hintId : undefined}
          aria-invalid={error ? true : undefined}
          {...rest}
          style={{ flex: 1, ...fieldStyle({ error: !!error, disabled: props.disabled }), ...style }}
        />
        {trailing}
      </div>
      {error || hint ? (
        <div
          id={hintId}
          role={error ? "alert" : undefined}
          style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: error ? theme.color.dangerText : theme.color.textMuted }}
        >
          {error || hint}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A field in a panel: the label at the left in text color, the control at
 * the right, wrapping under the label on a narrow sheet. Numbers are 88 px
 * wide and right aligned (Input does it for `type="number"`), text takes
 * the rest of the row. `htmlFor` names the control's id, so a tap on the
 * label focuses it.
 */
export function FieldRow(props: { label: string; htmlFor?: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minHeight: theme.touch }}>
      <label htmlFor={props.htmlFor} style={{ flex: "1 1 110px", minWidth: 0, fontSize: theme.font.body14, color: theme.color.text }}>
        {props.label}
        {props.hint ? <span style={{ display: "block", marginTop: theme.space(0.5), fontSize: theme.font.small, color: theme.color.textMuted }}>{props.hint}</span> : null}
      </label>
      <div style={{ flex: "1 1 160px", minWidth: 0, display: "flex", gap: theme.space(2), alignItems: "center", justifyContent: "flex-end" }}>{props.children}</div>
    </div>
  );
}

export function Card(props: { title?: string; children: ReactNode }) {
  return (
    <section
      style={{
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        padding: theme.space(4),
        display: "grid",
        gap: theme.space(3),
      }}
    >
      {props.title ? <h2 style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>{props.title}</h2> : null}
      {props.children}
    </section>
  );
}

export function ErrorText(props: { children: ReactNode }) {
  if (!props.children) return null;
  return (
    <p role="alert" style={{ margin: 0, color: theme.color.dangerText, fontSize: theme.font.body14 }}>
      {props.children}
    </p>
  );
}

/** A full-height page with a centered column, clear of the notch and home bar. */
export function Page(props: { children: ReactNode }) {
  return (
    <main
      style={{
        minHeight: "100dvh",
        background: theme.color.bg,
        color: theme.color.text,
        fontFamily: theme.font.body,
        padding: `calc(${theme.safe.top} + ${theme.space(6)}px) calc(${theme.safe.right} + ${theme.space(4)}px) calc(${theme.safe.bottom} + ${theme.space(6)}px) calc(${theme.safe.left} + ${theme.space(4)}px)`,
      }}
    >
      <div style={{ maxWidth: 480, margin: "0 auto", display: "grid", gap: theme.space(4) }}>{props.children}</div>
    </main>
  );
}
