import { createContext, useContext, useId, type CSSProperties, type InputHTMLAttributes, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
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

/**
 * The id of the hint under the FieldRow a control sits in. A row's control
 * far more often names itself (`aria-label`, as a Stepper does) than takes
 * the row's label through `htmlFor`, so the hint cannot ride on the label:
 * each field control reads this and lists it in its `aria-describedby`.
 */
const RowHint = createContext<string | undefined>(undefined);

/** A field control's `aria-describedby`: its own descriptions, then the hint of the FieldRow it sits in. */
export function useRowHint(own?: string): string | undefined {
  const hint = useContext(RowHint);
  return [own, hint].filter(Boolean).join(" ") || undefined;
}

/**
 * Ends a FieldRow's hint at a dialog's edge. Context passes through a
 * portal, so without it a picker a row opens, such as the image picker
 * under an Image row, would have its fields described by that row's hint.
 */
export function RowHintScope(props: { children: ReactNode }) {
  return <RowHint.Provider value={undefined}>{props.children}</RowHint.Provider>;
}

/** A plain input in the field look, for a place that labels it another way (`aria-label`, a FieldRow). */
export function Input(props: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement>; error?: boolean }) {
  const { error, style, ...rest } = props;
  const number = props.type === "number";
  const describedBy = useRowHint(props["aria-describedby"]);
  return (
    <input
      aria-invalid={error ? true : undefined}
      {...rest}
      aria-describedby={describedBy}
      style={{ ...fieldStyle({ error, disabled: props.disabled }), ...(number ? { width: NUMBER_FIELD_WIDTH, textAlign: "right", fontVariantNumeric: "tabular-nums" } : null), ...style }}
    />
  );
}

/** A native select in the field look. Native, since it is the best picker on a phone, and `color-scheme` draws its menu dark. */
export function Select(props: SelectHTMLAttributes<HTMLSelectElement> & { ref?: Ref<HTMLSelectElement>; error?: boolean }) {
  const { error, style, ...rest } = props;
  const describedBy = useRowHint(props["aria-describedby"]);
  return <select aria-invalid={error ? true : undefined} {...rest} aria-describedby={describedBy} style={{ ...fieldStyle({ error, disabled: props.disabled }), ...style }} />;
}

/** A text area in the field look, growing from three lines. */
export function TextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement>; error?: boolean }) {
  const { error, style, ...rest } = props;
  const describedBy = useRowHint(props["aria-describedby"]);
  return (
    <textarea
      aria-invalid={error ? true : undefined}
      rows={3}
      {...rest}
      aria-describedby={describedBy}
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
    // The column may be narrower than the input's own width (about 20 characters), so a field in a narrow pane shrinks rather than running past its edge.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
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
 *
 * The hint runs under the whole row, not in the label's column, where a
 * long one beside a number field stood five lines tall. It describes the
 * row's controls through `RowHint`, so the label stays the control's name
 * alone. Only the field controls read it (Input, Select, TextArea and the
 * token panel's text and number fields, Stepper's included). A row of
 * buttons keeps its hint as text under them, unread as a description.
 *
 * `fill` is for a control that stretches to fill the row (`flex: 1` or
 * `width: 100%`): a text field or a select. Its cell always asks for
 * 160 px, so every stretching control in a column starts at one left edge
 * whatever its own width. Without it the controls ask for their own width.
 *
 * `fixed` is for a control of one width that neither stretches nor wraps,
 * such as a Stepper, which is wider than the 160 px a row's controls ask
 * for. The label asks for no more than its words, and the control for its
 * whole width, so a short label stays beside it wherever both fit and the
 * row wraps wherever they do not (S2-POS-1).
 */
export function FieldRow(props: { label: string; htmlFor?: string; hint?: ReactNode; fill?: boolean; fixed?: boolean; children: ReactNode }) {
  const hintId = useId();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: theme.space(2), minHeight: theme.touch }}>
      {/*
       * A row wraps only where its label and its controls really do not fit
       * (docs/design-v1-polish.md R2). Fixed-width controls ask for their
       * own width, up to 160 px: the inner box caps what they ask, and its
       * least width of the whole cell, which wins over the cap, still lets
       * them fill the cell once the line is laid out. A stretching control's
       * own width is its widest option or its default size, which differs
       * from row to row, so a `fill` row asks for 160 px whatever it holds,
       * and its label and cell split the rest as before. The label asks for
       * 110 px, or 40% of a row narrower than 275. Next to 160 px of controls
       * 110 fits only from 278 up, where 40% is more than 110, so `fill`
       * rows lay out and wrap as they did, and a narrow control takes the
       * room: "DC" and its field share a 214 px line, as "On a pass" and its
       * 119 px choice do.
       */}
      <label
        htmlFor={props.htmlFor}
        style={{ flex: `1 1 min(${LABEL_BASIS}px, 40%)`, ...(props.fixed ? { maxWidth: "max-content" } : null), minWidth: 0, fontSize: theme.font.body14, color: theme.color.text }}
      >
        {props.label}
      </label>
      {/*
       * A fixed control's cell asks for the whole control, past the cap, and
       * the label stops growing at its words: the auto margin then keeps the
       * control at the row's end, on the label's line or on its own.
       */}
      <div style={{ ...(props.fixed ? { flex: "none", marginInlineStart: "auto" } : { flex: props.fill ? `1 1 ${CONTROLS_BASIS}px` : "1 1 auto" }), minWidth: 0, display: "flex", justifyContent: "flex-end" }}>
        <div style={{ ...(props.fixed ? null : { minWidth: "100%", maxWidth: CONTROLS_BASIS }), display: "flex", gap: theme.space(2), alignItems: "center", justifyContent: "flex-end" }}>
          <RowHint.Provider value={props.hint ? hintId : undefined}>{props.children}</RowHint.Provider>
        </div>
      </div>
      {props.hint ? (
        // 4 px under the controls, as Field's hint sits under its input, where the row's wrap gap is 8.
        <div id={hintId} style={{ flexBasis: "100%", marginTop: -theme.space(1), fontSize: theme.font.small, lineHeight: theme.leading.body, color: theme.color.textMuted }}>
          {props.hint}
        </div>
      ) : null}
    </div>
  );
}

/** What a FieldRow's label and its controls (at most, or always with `fill`) ask for on one line before the row wraps. */
const LABEL_BASIS = 110;
const CONTROLS_BASIS = 160;

/**
 * A page's card under its heading. `titleRef` makes the heading one that
 * takes focus from script (`tabIndex={-1}`), never a Tab stop, for a page
 * that moves focus to the card it just showed, such as the join's second
 * step.
 */
export function Card(props: { title?: string; titleRef?: Ref<HTMLHeadingElement>; children: ReactNode }) {
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
      {props.title ? (
        <h2 ref={props.titleRef} tabIndex={props.titleRef ? -1 : undefined} style={{ margin: 0, fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>
          {props.title}
        </h2>
      ) : null}
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
