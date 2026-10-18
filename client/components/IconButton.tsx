import type { ButtonHTMLAttributes, CSSProperties, ReactNode, Ref } from "react";
import { theme } from "../lib/theme.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { PRESSED } from "./looks.ts";
import { useTooltip } from "./Tooltip.tsx";

/**
 * A 44 x 44 button that shows only an icon: a header's close and back, a
 * row's more menu. Its name is `label`, in `aria-label` and as the
 * tooltip, since the icon says nothing to a screen reader. Transparent at
 * rest with the icon in muted text, the chosen look when `pressed`, and a
 * dim icon with no shape change when disabled.
 */
export function IconButton(
  props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "aria-label"> & {
    ref?: Ref<HTMLButtonElement>;
    icon: IconName;
    label: string;
    /** The tooltip, when it should say more than the name. */
    title?: string;
    pressed?: boolean;
    /** Drawn after the icon, such as a count. Rare: most icon buttons are the icon alone. */
    children?: ReactNode;
  },
) {
  const { icon, label, title, pressed, disabled, style, children, onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onFocus, onBlur, ...rest } = props;
  // The name on hover, keyboard focus and a long press, never covering the button (docs/design-v1-icons.md 3). Said by a reader only when it adds to the name.
  const tooltip = useTooltip(title ?? label, { describes: title !== undefined && title !== label });
  const look: CSSProperties = disabled
    ? { background: "transparent", border: `${theme.line.border}px solid transparent`, color: theme.color.textDisabled }
    : pressed
      ? PRESSED
      : { background: "transparent", border: `${theme.line.border}px solid transparent`, color: theme.color.textMuted };
  return (
    <>
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      {...rest}
      {...tooltip.anchor({ onPointerEnter, onPointerLeave, onPointerDown, onPointerUp, onFocus, onBlur, "aria-describedby": rest["aria-describedby"] })}
      style={{
        flex: "none",
        display: "inline-grid",
        gridAutoFlow: "column",
        placeItems: "center",
        gap: theme.space(1),
        minWidth: theme.touch,
        minHeight: theme.touch,
        padding: 0,
        borderRadius: theme.radius.md,
        fontFamily: theme.font.body,
        cursor: disabled ? "default" : "pointer",
        ...look,
        ...style,
      }}
    >
      <Icon name={icon} />
      {children}
    </button>
    {tooltip.tip}
    </>
  );
}
