import type { Effect } from "#shared/model.ts";
import { chipIconUrl } from "../../canvas/chipIcons.ts";
import { effectChip, effectCount } from "../../lib/tokenView.ts";
import { theme } from "../../lib/theme.ts";

/**
 * A condition or status icon in HTML, matching the canvas chip: the
 * game-icons.net art (CREDITS.md) in white on the effect's color. The SVGs
 * fill with `currentColor`, which an image cannot inherit, so the file is
 * used as a CSS mask over a white box instead. Custom statuses show their
 * own glyph. An exhaustion level or a counter sits in the corner. A
 * condition hidden from players, which only the DM's view holds, is dimmed
 * with a dashed edge.
 */
export function EffectIcon(props: { effect: Pick<Effect, "key" | "label" | "glyph" | "color" | "level" | "spell" | "hiddenFromPlayers">; size?: number }) {
  const size = props.size ?? 28;
  const chip = effectChip(props.effect);
  const url = props.effect.key === "custom" ? null : chipIconUrl(props.effect.key);
  const level = effectCount(props.effect);
  const badge = Math.round(Math.min(16, size * 0.55));
  const hidden = props.effect.hiddenFromPlayers === true;
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        flex: "none",
        display: "inline-grid",
        placeItems: "center",
        width: size,
        height: size,
        boxSizing: "border-box",
        borderRadius: Math.round(size / 5),
        // A dark rim inside the edge, so a dark effect color still parts from a dark surface. The fill shows through it.
        border: `${theme.line.border}px solid ${theme.color.scrimLight}`,
        background: chip.color,
        color: theme.color.white,
        fontSize: chip.glyph.length > 2 ? size * 0.32 : size * 0.42,
        fontWeight: theme.weight.bold,
        lineHeight: 1,
        ...(hidden ? { opacity: 0.6, outline: `${theme.line.border}px dashed ${theme.color.text}`, outlineOffset: 1 } : {}),
      }}
    >
      {url ? (
        <span
          style={{
            width: size * 0.78,
            height: size * 0.78,
            background: theme.color.white,
            WebkitMaskImage: `url(${url})`,
            maskImage: `url(${url})`,
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskPosition: "center",
            maskPosition: "center",
          }}
        />
      ) : (
        chip.glyph
      )}
      {level !== null ? (
        <span
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            minWidth: badge,
            height: badge,
            padding: `0 ${theme.space(0.5)}px`,
            borderRadius: badge / 2,
            background: theme.color.textHalo,
            color: theme.color.white,
            fontSize: badge * 0.7,
            display: "grid",
            placeItems: "center",
          }}
        >
          {level}
        </span>
      ) : null}
    </span>
  );
}
