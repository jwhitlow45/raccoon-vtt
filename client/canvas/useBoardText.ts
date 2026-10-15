import { useMemo, useRef } from "react";
import type { Actor, Character } from "#shared/model.ts";
import { boardSizes } from "../lib/boardScale.ts";
import { focusLines, linesSize, placeLabels, showsNumberBadge, type Box, type LabelInput, type LabelLine, type LabelStyle, type Obstacle, type Side } from "../lib/boardText.ts";
import { footprint, type ViewToken } from "../lib/scene.ts";
import { DECOR_MIN_PX, healthState, hpDisplay, type HpDisplay } from "../lib/tokenView.ts";
import { pillPlace } from "../features/measure/Pill.tsx";
import type { PillSpec } from "./boardView.ts";
import { measureLabel } from "./measureText.ts";
import { bloodiedNotch, tokenMarks, type Notch, type TokenMarks } from "./tokenMarks.ts";

/** A block of label lines, placed in screen pixels from the token's top-left corner. */
export type PlacedLines = { lines: LabelLine[]; x: number; y: number; width: number; height: number };

/** Everything the board draws around one token besides its body. */
export type TokenText = {
  /** The token's footprint on screen. */
  widthPx: number;
  heightPx: number;
  hp: HpDisplay;
  /** Chips, badge and HP bar, or null on a token too small for them. */
  marks: TokenMarks | null;
  label: PlacedLines | null;
  /** The selected or hovered token's whole label on its plate, over everything. */
  plate: PlacedLines | null;
  /** A numbered picture token whose name gave way shows its number on it. */
  numberBadge: boolean;
  /** The creature is Bloodied and this viewer may know it: a notch on its ring, at every zoom (tokenMarks.ts). */
  notch: Notch | null;
};

const LEADING = 1.17;

export function labelStyle(namePx: number, hpPx: number, gapPx: number, tokenPx: number, cellPx: number): LabelStyle {
  return {
    namePx,
    hpPx,
    leading: LEADING,
    wrapWidth: Math.max(tokenPx + cellPx, 10 * namePx),
    maxWidth: 15 * namePx,
    padX: Math.ceil(namePx / 8),
    gapPx,
  };
}

/**
 * Every token's marks, label and plate for the zoom, laid out at once
 * (lib/boardText.ts). The selected token places first, then the
 * acting creature, then the party and the viewer's own tokens, then the
 * rest. Tokens too small for marks (a phone zoomed out to a whole scene)
 * still keep their bodies clear, and only the acting creature and the
 * viewer's own tokens there try for their names.
 *
 * `pills` are other layers' pills (an area's name, the move marker), and
 * `mapLabels` the DM's text on the map, which labels keep off too. The
 * side each label took is kept for the next layout, so a pinch does not
 * shuffle them.
 *
 * Plates are laid over the result afterwards. A hover on a desktop shows
 * its token's plate without placing anything again (decided 2026-10-14), so
 * labels under a crowd hold still while the mouse moves over it. Only a
 * selection places first.
 */
export function useBoardText(input: {
  tokens: readonly ViewToken[];
  scale: number;
  characters: Record<string, Character | undefined> | undefined;
  role: "dm" | "player";
  ownsToken: (t: ViewToken) => boolean;
  activeTokenId: string | null;
  /** The selected token, placed first. */
  selectedId: string | null;
  /** The tokens whose plate shows: hovered on a desktop, or selected while no action bar shows its name. */
  plateIds: ReadonlySet<string>;
  pills: readonly PillSpec[];
  /** The DM's labels on the map as this viewer has them, in cells. */
  mapLabels: readonly Box[];
}): Map<string, TokenText> {
  // The last layout's sides, read and written inside the layout on purpose: they steer the next one, never trigger one.
  const previous = useRef<Map<string, Side>>(new Map());
  const { tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, plateIds, pills, mapLabels } = input;
  const layout = useMemo(() => {
    const sizes = boardSizes(scale);
    const out = new Map<string, TokenText>();
    const labelInputs: LabelInput[] = [];
    const obstacles: Obstacle[] = pills.map((spec) => {
      const p = pillPlace({ ...spec, scale }, null).box;
      return { box: { x0: p.x0 * scale, y0: p.y0 * scale, x1: p.x1 * scale, y1: p.y1 * scale }, kind: "pill" };
    });
    for (const b of mapLabels) obstacles.push({ box: { x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale }, kind: "map" });
    const meta = new Map<string, { widthPx: number; ox: number; oy: number; hpLine: string | null; image: boolean; number: number | undefined; style: LabelStyle }>();
    for (const t of tokens) {
      const fp = footprint(t);
      const widthPx = fp.w * scale;
      const heightPx = fp.h * scale;
      const ox = t.x * scale;
      const oy = t.y * scale;
      const box: Box = { x0: ox, y0: oy, x1: ox + widthPx, y1: oy + heightPx };
      obstacles.push({ box, owner: t.id, kind: "body" });
      const actor: Partial<Actor> | undefined = "inline" in t.actor ? t.actor.inline : characters?.[t.actor.ref]?.actor;
      const fullAccess = role === "dm" || ownsToken(t);
      const hp = hpDisplay({ actor, hpVisibility: t.hpVisibility, fullAccess });
      const state = healthState({ actor, hpVisibility: t.hpVisibility, fullAccess });
      const big = widthPx >= DECOR_MIN_PX;
      const marks = big
        ? tokenMarks({ widthPx, heightPx, effects: actor?.effects ?? [], elevation: t.elevation, hasBar: hp.kind === "bar", cellPx: scale, sizes, measure: measureLabel })
        : null;
      for (const m of marks?.boxes ?? []) obstacles.push({ box: { x0: m.x0 + ox, y0: m.y0 + oy, x1: m.x1 + ox, y1: m.y1 + oy }, owner: t.id, kind: "mark" });
      const own = t.kind === "pc" || ownsToken(t);
      const rank = t.id === selectedId ? 3 : t.id === activeTokenId ? 2 : own ? 1 : 0;
      const hpLine = hp.kind === "label" ? hp.label : hp.kind === "bar" ? (hp.text ?? null) : null;
      const style = labelStyle(sizes.namePx, sizes.hpPx, sizes.gapPx, widthPx, scale);
      meta.set(t.id, { widthPx, ox, oy, hpLine, image: !!t.image, number: t.number, style });
      out.set(t.id, { widthPx, heightPx, hp, marks, label: null, plate: null, numberBadge: false, notch: bloodiedNotch(state, widthPx, heightPx, sizes.ringPx) });
      // Under the marks' size only the acting creature and the viewer's own tokens try for a name.
      if (!big && rank < 2 && !ownsToken(t)) continue;
      labelInputs.push({
        id: t.id,
        box,
        belowY: oy + (marks ? marks.belowY : heightPx + sizes.gapPx),
        aboveY: oy + (marks ? marks.aboveY : -sizes.gapPx),
        sideTopY: marks ? oy + marks.sideTopY : undefined,
        name: t.name,
        number: t.number,
        hp: hpLine,
        alert: state === "Bloodied" || state === "Dying",
        rank,
        sides: rank >= 2,
        nameOnly: !big,
        style,
      });
    }
    const placed = placeLabels(labelInputs, obstacles, measureLabel, previous.current);
    const sides = new Map<string, Side>();
    for (const [id, p] of placed) {
      const m = meta.get(id)!;
      const text = out.get(id)!;
      if (p.lines.length > 0) {
        sides.set(id, p.side);
        text.label = { lines: p.lines, x: p.box.x0 - m.ox, y: p.box.y0 - m.oy, width: p.box.x1 - p.box.x0, height: p.box.y1 - p.box.y0 };
      }
      text.numberBadge = showsNumberBadge(m, p);
    }
    for (const [id, m] of meta) if (!placed.has(id)) out.get(id)!.numberBadge = showsNumberBadge(m, undefined);
    previous.current = sides;
    return { out, meta, sizes };
  }, [tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, pills, mapLabels]);

  return useMemo(() => {
    if (plateIds.size === 0) return layout.out;
    const { meta, sizes } = layout;
    const out = new Map(layout.out);
    for (const id of plateIds) {
      const m = meta.get(id);
      const text = out.get(id);
      const t = tokens.find((x) => x.id === id);
      if (!m || !text || !t) continue;
      const style: LabelStyle = { ...m.style, namePx: sizes.focusNamePx, hpPx: sizes.focusHpPx, maxWidth: 16 * sizes.focusNamePx, wrapWidth: 16 * sizes.focusNamePx, padX: 6 };
      const lines = focusLines({ name: t.name, number: t.number, hp: m.hpLine, style }, measureLabel);
      const size = linesSize(lines, style, measureLabel);
      const top = text.marks ? text.marks.belowY : text.heightPx + sizes.gapPx;
      out.set(id, { ...text, plate: { lines, x: m.widthPx / 2 - size.width / 2, y: top + 2, width: size.width, height: size.height } });
    }
    return out;
  }, [layout, plateIds, tokens]);
}
