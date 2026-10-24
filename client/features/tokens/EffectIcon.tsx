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
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {level}
        </span>
      ) : null}
    </span>
  );
}

/** The art's file for an effect, or null for a custom status or a key with none. */
function artUrl(key: Effect["key"]): string | null {
  return key === "custom" ? null : chipIconUrl(key);
}

/** Whether `EffectArt` draws anything for this key, so a chip or a line falls back to its glyph or its words where it does not. */
export function effectHasArt(key: Effect["key"]): boolean {
  return artUrl(key) !== null;
}

/**
 * A small chip's face, the tracker's and the party bar's
 * (docs/design-v1-icons-2.md 4): the effect's art where the chip holds no
 * number, else its letters as before. The art and a number together are
 * 27 px wide, past the chip's 20 px box, so exhaustion keeps "E2", whose
 * letters hold its level, and a counted effect keeps its letters beside its
 * number where the chip shows one (`counts`, the tracker's).
 */
export function ChipFace(props: { effect: Pick<Effect, "key" | "label" | "glyph" | "color" | "level" | "spell">; size: number; counts?: boolean }) {
  const exhaustion = props.effect.key === "exhaustion";
  const count = props.counts && !exhaustion ? effectCount(props.effect) : null;
  const art = !exhaustion && count === null && effectHasArt(props.effect.key);
  return (
    <>
      {art ? <EffectArt effectKey={props.effect.key} size={props.size} /> : effectChip(props.effect).glyph}
      {count !== null ? <span style={{ marginLeft: theme.space(0.5), fontVariantNumeric: "tabular-nums" }}>{count}</span> : null}
    </>
  );
}

/**
 * A condition's or status's art alone, in the text's color, for a small
 * chip or a line of words that names the effect (docs/design-v1-icons-2.md
 * 4). Null where the effect has no art (`effectHasArt`): a custom status,
 * whose glyph is its own words, or a key the app does not know.
 */
export function EffectArt(props: { effectKey: Effect["key"]; size: number; color?: string }) {
  const url = artUrl(props.effectKey);
  if (url === null) return null;
  return (
    <span
      aria-hidden
      style={{
        flex: "none",
        display: "inline-block",
        width: props.size,
        height: props.size,
        background: props.color ?? "currentColor",
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
  );
}
