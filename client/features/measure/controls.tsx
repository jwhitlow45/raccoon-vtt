import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Button } from "../../components/Button.tsx";
import { Input, Select } from "../../components/Field.tsx";
import type { IconName } from "../../components/Icon.tsx";
import { accessibleName } from "../../lib/a11y.ts";
import { theme } from "../../lib/theme.ts";

/**
 * The map tools' options bars, laid out one way (docs/design-v1-visual.md
 * 3.4): the hint line first, then wrapping rows of controls. Modes are
 * Segmented (components/Segmented.tsx), actions small buttons, clears
 * small danger buttons. Every control is a 44 px touch target with no
 * hover-only state (design section 14.4). The bar itself is Room.tsx's,
 * above the toolbar.
 *
 * Rows wrap onto more lines rather than scroll, because on a phone a
 * sideways scroll hid Share, Cancel and the spell search past the edge
 * with nothing to say they were there.
 */

/** The options bar's content: the hint line, then the rows of controls, filling the bar's width. */
export function OptionsColumn(props: { children: ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: theme.space(1), width: "100%", minWidth: 0 }}>{props.children}</div>;
}

/**
 * A wrapping row of controls. A control made of parts (a Segmented, a
 * stepper, a row of swatches) keeps its parts `space(1)` or closer, and
 * the row puts `space(2)` between controls, so the groups read apart.
 * Wrapped lines stay `space(1)` apart, since every pixel of the bar's
 * height is map that a phone does not show.
 */
export function OptionsRow(props: { children: ReactNode; label?: string }) {
  return (
    <div
      role="group"
      aria-label={props.label}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "center", rowGap: theme.space(1), columnGap: theme.space(2), minWidth: 0 }}
    >
      {props.children}
    </div>
  );
}

/**
 * The line above the controls. `muted` is a hint, what a tap or a drag
 * does now: 13 px muted, as every hint in the app, or in the warning tone
 * for what went wrong. Without a tone the line is a reading the tool gives
 * (the ruler's distance, what an area catches), at body size in text
 * color, since that is what the person came for. It wraps, and only a
 * very long "In area" list scrolls, past four lines.
 */
export function InfoLine(props: { children: ReactNode; tone?: "muted" | "warning" }) {
  const hint = props.tone !== undefined;
  return (
    <div
      aria-live="polite"
      style={{
        fontSize: hint ? theme.font.small : theme.font.body14,
        lineHeight: theme.leading.body,
        color: props.tone === "warning" ? theme.color.warning : hint ? theme.color.textMuted : theme.color.text,
        maxHeight: "5.4em",
        overflowY: "auto",
      }}
    >
      {props.children}
    </div>
  );
}

/** A thin line between the tool's own controls and those of the thing it has selected, such as a stamp. */
export function OptionsDivider() {
  return <span aria-hidden style={{ flex: "none", width: theme.line.border, alignSelf: "stretch", margin: `${theme.space(1)}px 0`, background: theme.color.border }} />;
}

/**
 * A small button in a bar (components/Button.tsx, size `sm`). `label` is
 * the tooltip, and the name too when the visible words say less than it
 * (lib/a11y.ts accessibleName), so "Undo" is still called "Undo" and an
 * arrow is called by what it does. `pressed` is an option that applies at
 * once, named by what pressed means ("DM only", "Shared"). A danger
 * button that is pressed is armed: it waits for its second tap.
 */
export function OptButton(props: {
  ref?: Ref<HTMLButtonElement>;
  onClick(): void;
  children?: ReactNode;
  label?: string;
  pressed?: boolean;
  disabled?: boolean;
  tone?: "primary" | "danger";
  icon?: IconName;
}) {
  const { pressed, tone } = props;
  return (
    <Button
      ref={props.ref}
      size="sm"
      variant={tone ?? "secondary"}
      pressed={pressed}
      armed={tone === "danger" && pressed === true}
      icon={props.icon}
      disabled={props.disabled}
      aria-label={props.children === undefined ? props.label : accessibleName(props.children, props.label)}
      title={props.label}
      onClick={props.onClick}
      style={{ flex: "none", whiteSpace: "nowrap" }}
    >
      {props.children}
    </Button>
  );
}

/** How long a destructive button stays armed for its second tap. */
const ARMED_MS = 4000;

/**
 * A danger button that asks for a second tap before it acts, for what
 * wipes something out (fog everything, clear the build, delete a light).
 * No dialog, so it works the same with a thumb and a mouse. Its words
 * change to the question once armed, and so does its name, so a screen
 * reader hears what the next tap does.
 */
export function ConfirmButton(props: { label: string; confirm: string; title?: string; onConfirm(): void; disabled?: boolean }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = setTimeout(() => setArmed(false), ARMED_MS);
    return () => clearTimeout(timer);
  }, [armed]);
  const words = armed ? props.confirm : props.label;
  return (
    <Button
      size="sm"
      variant="danger"
      armed={armed}
      disabled={props.disabled}
      aria-label={accessibleName(words, props.title)}
      title={props.title}
      onClick={() => {
        if (!armed) {
          setArmed(true);
          return;
        }
        setArmed(false);
        props.onConfirm();
      }}
      style={{ flex: "none", whiteSpace: "nowrap" }}
    >
      {words}
    </Button>
  );
}

/** A number in steps, with buttons rather than a text field, so a phone needs no keyboard. */
export function Stepper(props: { label: string; value: number; step: number; min: number; max: number; unit?: string; onChange(v: number): void }) {
  const { value, step, min, max } = props;
  const set = (v: number) => props.onChange(Math.min(max, Math.max(min, v)));
  return (
    <div role="group" aria-label={props.label} style={{ display: "flex", flex: "none", alignItems: "center", gap: theme.space(1) }}>
      <OptButton icon="minus" label={`Less ${props.label.toLowerCase()}`} disabled={value <= min} onClick={() => set(value - step)} />
      <StepValue>
        {value}
        {props.unit ? ` ${props.unit}` : ""}
      </StepValue>
      <OptButton icon="plus" label={`More ${props.label.toLowerCase()}`} disabled={value >= max} onClick={() => set(value + step)} />
    </div>
  );
}

/** The value between a stepper's buttons, in figures of one width, so it does not jitter as it changes. */
export function StepValue(props: { children: ReactNode; minWidth?: number; live?: boolean }) {
  return (
    <span
      aria-live={props.live ? "polite" : undefined}
      style={{
        minWidth: props.minWidth ?? 56,
        textAlign: "center",
        fontSize: theme.font.body14,
        fontWeight: theme.weight.bold,
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </span>
  );
}

/** A 16 px text input in the field look (iOS zooms the page on anything smaller). */
export function OptInput(props: {
  label: string;
  value: string;
  placeholder?: string;
  maxLength?: number;
  onChange(v: string): void;
  onEnter?(): void;
  autoFocus?: boolean;
  width?: number;
}) {
  return (
    <Input
      type="text"
      aria-label={props.label}
      value={props.value}
      placeholder={props.placeholder}
      maxLength={props.maxLength}
      autoFocus={props.autoFocus}
      onChange={(e) => props.onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onEnter?.();
      }}
      style={{ flex: "none", width: props.width ?? 180 }}
    />
  );
}

/**
 * A native select in the field look, for a choice of more than a
 * Segmented holds (the builder's ten modes, the draw tool's eight). It is
 * the best picker on a phone, and `color-scheme` draws its menu dark.
 *
 * Its side padding is a step under a form field's: the select's own arrow
 * pads its right side already, and the builder's widest mode name with
 * Undo, Redo and the stamp button just fill a 390 px phone's first row,
 * so the selected stamp's buttons keep to one more row (StampOptions.tsx).
 */
export function OptSelect<T extends string>(props: { label: string; value: T; options: readonly { value: T; label: string }[]; onChange(value: T): void }) {
  return (
    <Select
      aria-label={props.label}
      value={props.value}
      onChange={(e) => props.onChange(e.target.value as T)}
      style={{ flex: "none", maxWidth: "100%", padding: `0 ${theme.space(2)}px` }}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}
