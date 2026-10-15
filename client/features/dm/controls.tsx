import { useId, useState, type CSSProperties, type ReactNode } from "react";
import { Button } from "../../components/Button.tsx";
import { buttonLook } from "../../components/looks.ts";
import { Help } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";

/**
 * Small form pieces the DM tools, settings and members panels share. Every
 * control is at least 44 px tall and works by tap alone (design 14.4).
 * Sections, help lines and notices come from the shared kit
 * (components/Panel.tsx, Notice.tsx).
 */

export type RadioOption<V extends string> = { value: V; label: string; help?: string };

/**
 * One choice of a few, each option a full-width card with its own
 * explanation: the radio cards of Room settings (docs/design-v1-visual.md
 * 2.3). The chosen card takes the accent's outline and tint. A disabled
 * group keeps its shape with a quiet outline and dim text, never a fade.
 */
export function RadioGroup<V extends string>(props: {
  legend: string;
  help?: ReactNode;
  value: V;
  options: RadioOption<V>[];
  disabled?: boolean;
  onChange(value: V): void;
}) {
  const name = useId();
  const { disabled } = props;
  return (
    <fieldset style={{ margin: 0, padding: 0, border: "none", minWidth: 0, display: "grid", gap: theme.space(1) }} disabled={disabled}>
      <legend style={{ padding: 0, fontSize: theme.font.input, fontWeight: theme.weight.strong, color: disabled ? theme.color.textDisabled : theme.color.text }}>
        {props.legend}
      </legend>
      {props.help ? <Help>{props.help}</Help> : null}
      {props.options.map((o) => {
        const chosen = props.value === o.value;
        const look: CSSProperties = disabled
          ? { border: `${theme.line.border}px solid ${theme.color.border}`, background: "transparent", color: theme.color.textDisabled }
          : chosen
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
              checked={chosen}
              onChange={() => props.onChange(o.value)}
              style={{ width: 20, height: 20, margin: 0, flex: "none", accentColor: theme.color.accent }}
            />
            <span style={{ display: "grid", gap: theme.space(0.5) }}>
              <span style={{ fontSize: theme.font.body14, fontWeight: theme.weight.strong }}>{o.label}</span>
              {o.help ? (
                <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, color: disabled ? theme.color.textDisabled : theme.color.textMuted }}>{o.help}</span>
              ) : null}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}

/**
 * An action that needs a second, deliberate tap: the first shows what will
 * happen and a confirm button beside Cancel. Nothing depends on a timeout or
 * a long-press. A `danger` action reads red at rest, and its open box and
 * confirm button are outlined in red (components/Button.tsx). The buttons
 * are the small size of a panel unless `size` says otherwise.
 */
export function ConfirmAction(props: {
  label: string;
  confirmLabel?: string;
  warning: ReactNode;
  busy?: boolean;
  disabled?: boolean;
  danger?: boolean;
  size?: "md" | "sm";
  onConfirm(): void | Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const size = props.size ?? "sm";
  if (!open) {
    return (
      <Button
        variant={props.danger ? "danger" : "secondary"}
        size={size}
        disabled={props.disabled || props.busy}
        onClick={() => setOpen(true)}
        style={{ justifySelf: "start" }}
      >
        {props.label}
      </Button>
    );
  }
  return (
    <div
      role="group"
      aria-label={props.label}
      style={{
        display: "grid",
        gap: theme.space(2),
        padding: theme.space(3),
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${props.danger ? theme.color.danger : theme.color.border}`,
        background: theme.color.bg,
      }}
    >
      <div style={{ fontSize: theme.font.body14, lineHeight: theme.leading.body }}>{props.warning}</div>
      <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
        <Button size={size} onClick={() => setOpen(false)} disabled={props.busy}>
          Cancel
        </Button>
        <Button
          variant={props.danger ? "danger" : "primary"}
          size={size}
          armed={props.danger}
          busy={props.busy}
          onClick={async () => {
            await props.onConfirm();
            setOpen(false);
          }}
        >
          {props.busy ? "Working…" : (props.confirmLabel ?? props.label)}
        </Button>
      </div>
    </div>
  );
}

/**
 * A file picker that looks and sizes like a secondary Button. The
 * browser's own file input is a small, unstyled target on phones, so it
 * stays in the page for keyboard and screen reader use, visually hidden
 * inside its label, which is the tap target. Inside the label, it lets
 * the focus ring show on the label (`.rvtt-choice` in globals.css), where
 * a keyboard user can see it.
 */
export function FileButton(props: { label: string; accept: string; disabled?: boolean; size?: "md" | "sm"; onFile(file: File): void }) {
  const sm = props.size === "sm";
  return (
    <label
      className="rvtt-choice"
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        justifySelf: "start",
        minHeight: theme.touch,
        minWidth: theme.touch,
        padding: `0 ${theme.space(sm ? 3 : 4)}px`,
        borderRadius: theme.radius.md,
        fontSize: sm ? theme.font.body14 : theme.font.input,
        fontWeight: theme.weight.strong,
        fontFamily: theme.font.body,
        cursor: props.disabled ? "default" : "pointer",
        ...buttonLook("secondary", { disabled: props.disabled }),
      }}
    >
      {props.label}
      <input
        type="file"
        accept={props.accept}
        disabled={props.disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          // Cleared, so picking the same file again still fires a change.
          e.target.value = "";
          if (file) props.onFile(file);
        }}
        style={{ position: "absolute", inset: 0, width: 1, height: 1, opacity: 0, overflow: "hidden", clipPath: "inset(50%)" }}
      />
    </label>
  );
}

/**
 * A secret shown once, such as a new DM link: selectable, with copy and
 * share. Copying acts on the side of whatever the page is for, so both are
 * secondary, and the copy icon says what the first one does. `size` is
 * `sm` in a panel.
 */
export function SecretLink(props: { value: string; label: string; size?: "md" | "sm" }) {
  const [copied, setCopied] = useState(false);
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <code
        aria-label={props.label}
        style={{
          display: "block",
          padding: theme.space(3),
          borderRadius: theme.radius.md,
          background: theme.color.bg,
          border: `${theme.line.border}px solid ${theme.color.border}`,
          fontFamily: theme.font.mono,
          fontSize: theme.font.body14,
          wordBreak: "break-all",
          userSelect: "all",
        }}
      >
        {props.value}
      </code>
      <div style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap" }}>
        <Button
          size={props.size}
          icon="copy"
          onClick={() => {
            navigator.clipboard.writeText(props.value).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "Copied" : "Copy link"}
        </Button>
        {canShare ? (
          <Button size={props.size} onClick={() => void navigator.share({ title: props.label, url: props.value }).catch(() => {})}>
            Share
          </Button>
        ) : null}
      </div>
    </div>
  );
}
