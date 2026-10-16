import { theme } from "../lib/theme.ts";
import { acBadgeBox, SHIELD_PATH, type AcBadgeSize } from "./acBadge.ts";

export { acBadgeBox, SHIELD_PATH, type AcBadgeSize } from "./acBadge.ts";

/**
 * A creature's AC on the shield, sized to its number (acBadge.ts): `md` in
 * the token bar and the token panel, `sm` in dense rows. An image named
 * "Armor Class 15", so a screen reader hears it as one thing, and not a
 * Tab stop. The title is an extra for a mouse: the shield is the D&D sign
 * for AC, and the panel's Stats field names it in words. Nothing for an AC
 * of 0.
 */
export function AcBadge(props: { ac: number; size?: AcBadgeSize }) {
  const box = acBadgeBox(props.ac, props.size ?? "md");
  if (!box) return null;
  return (
    <span
      role="img"
      aria-label={`Armor Class ${props.ac}`}
      title="Armor Class"
      style={{ position: "relative", display: "inline-grid", placeItems: "center", flex: "none", width: box.width, height: box.height, verticalAlign: "middle" }}
    >
      <svg aria-hidden width={box.width} height={box.height} viewBox="0 0 24 24" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, overflow: "visible" }}>
        <path d={SHIELD_PATH} fill={theme.color.surfaceRaised} stroke={theme.color.text} strokeWidth={1} vectorEffect="non-scaling-stroke" />
      </svg>
      {/* A little above the middle, where the shield is widest. */}
      <span
        aria-hidden
        style={{
          position: "relative",
          marginTop: -Math.round(box.height * 0.12),
          fontSize: box.textPx,
          fontWeight: theme.weight.bold,
          lineHeight: 1,
          fontVariantNumeric: "tabular-nums",
          color: theme.color.text,
        }}
      >
        {props.ac}
      </span>
    </span>
  );
}
