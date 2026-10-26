import { useMemo, useRef } from "react";
import type { Actor, Character } from "#shared/model.ts";
import { hpLess } from "#shared/rules/hp.ts";
import { boardSizes } from "../lib/boardScale.ts";
import { focusLines, focusStyle, labelStyle, linesSize, placeLabels, showsNumberBadge, type Box, type LabelInput, type LabelLine, type Obstacle, type PlacedLabel } from "../lib/boardText.ts";
import { footprint, type ViewToken } from "../lib/scene.ts";
import { DECOR_MIN_PX, healthState, hpDisplay, type HpDisplay } from "../lib/tokenView.ts";
import { pillReach } from "../features/measure/Pill.tsx";
import type { PillSpec } from "./boardView.ts";
import { measureLabel } from "./measureText.ts";
import { bloodiedNotch, numberBadgeWidth, shieldAc, tokenMarks, type Notch, type TokenMarks } from "./tokenMarks.ts";

/** A block of label lines, placed in screen pixels from the token's top-left corner. */
export type PlacedLines = { lines: LabelLine[]; x: number; y: number; width: number; height: number };

/** Everything the board draws around one token besides its body. */
export type TokenText = {
  /** The token's footprint on screen. */
  widthPx: number;
  heightPx: number;
  /** How far below the box's top the token's foot lies, where chrome under it hangs: in Isometric the bottom of its ring (5.4). Its height when absent. */
  footPx?: number;
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

/**
 * Other layers' pills as the label pass keeps off them, in screen pixels:
 * the room each takes at this zoom, wherever the view slides it
 * (Pill.tsx pillReach), so a label never lands on a name slid in from the
 * screen's edge, and a pan never lays the labels out again.
 */
export function pillObstacles(pills: readonly PillSpec[], scale: number): Obstacle[] {
  return pills.map((spec) => {
    const p = pillReach({ ...spec, scale });
    return { box: { x0: p.x0 * scale, y0: p.y0 * scale, x1: p.x1 * scale, y1: p.y1 * scale }, kind: "pill" };
  });
}

/**
 * Every token's marks, label and plate for the zoom, laid out at once
 * (lib/boardText.ts). The selected token places first, then the
 * acting creature, then the party and the viewer's own tokens, then the
 * rest. Tokens too small for marks (a phone zoomed out to a whole scene)
 * still keep their bodies clear, and only the acting creature and the
 * viewer's own tokens there try for their names.
 *
 * `pills` are other layers' pills (an area's or a trap's name, the move marker), and
 * `mapLabels` the DM's text on the map, which labels keep off too. Each
 * layout is kept for the next, whose labels hold their shapes and sides
 * while they fit, so a pinch does not shuffle them.
 *
 * Plates are laid over the result afterwards. A hover on a desktop shows
 * its token's plate without placing anything again (decided 2026-10-14), so
 * labels under a crowd hold still while the mouse moves over it. Only a
 * selection places first.
 */
export type BoardTextInput = {
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
  /** Whether a token's padlock shows (Stage.tsx), which shares the bottom left corner with the AC shield. */
  lockShown: (t: ViewToken) => boolean;
  /** Moves on when the interface font arrives (boardFont.ts), so labels measured in the fallback are placed again. */
  fontEpoch: number;
  /**
   * Where a token's decor lays out, in view units, and the ring under it,
   * as the isometric board draws it (docs/design-v1-isometric-view.md 5.4,
   * relief/IsoBoard.tsx): the box's top left, the art's frame, and the ring
   * that hangs below the frame's bottom. Top-down's box is the token's own,
   * at its cell.
   */
  place?: (t: ViewToken) => { x: number; y: number; ring?: Box };
};

export function useBoardText(input: BoardTextInput): Map<string, TokenText> {
  // The last layout and the font it was measured in, read and written inside the layout on purpose: its shapes steer the next one, never trigger one.
  const previous = useRef<{ fontEpoch: number; placed: Map<string, PlacedLabel> }>({ fontEpoch: input.fontEpoch, placed: new Map() });
  const { tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, plateIds, pills, mapLabels, lockShown, fontEpoch, place } = input;
  const layout = useMemo(() => {
    // A new font is a new measure, so labels are laid out afresh, not held to shapes measured in the old one.
    const kept = previous.current.fontEpoch === fontEpoch ? previous.current.placed : undefined;
    const laid = layoutBoardText({ tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, pills, mapLabels, lockShown, fontEpoch, place }, kept);
    previous.current = { fontEpoch, placed: laid.placed };
    return laid;
  }, [tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, pills, mapLabels, lockShown, fontEpoch, place]);

  return useMemo(() => {
    if (plateIds.size === 0) return layout.out;
    const { meta, sizes } = layout;
    const style = focusStyle(sizes);
    const out = new Map(layout.out);
    for (const id of plateIds) {
      const m = meta.get(id);
      const text = out.get(id);
      const t = tokens.find((x) => x.id === id);
      if (!m || !text || !t) continue;
      const lines = focusLines({ name: t.name, number: t.number, hp: m.hpLine, style }, measureLabel);
      const size = linesSize(lines, style, measureLabel);
      const top = Math.max(text.marks ? text.marks.belowY : text.heightPx + sizes.gapPx, m.ringBottom !== null ? m.ringBottom + sizes.gapPx : -Infinity);
      out.set(id, { ...text, plate: { lines, x: m.widthPx / 2 - size.width / 2, y: top + 2, width: size.width, height: size.height } });
    }
    return out;
  }, [layout, plateIds, tokens]);
}

/**
 * The layout `useBoardText` keeps, as a plain function: every token's
 * marks and label at once, `kept` the last layout's labels, whose shapes
 * and sides hold while they fit.
 */
export function layoutBoardText(input: Omit<BoardTextInput, "plateIds">, kept: Map<string, PlacedLabel> | undefined) {
  const { tokens, scale, characters, role, ownsToken, activeTokenId, selectedId, pills, mapLabels, lockShown, place } = input;
  const sizes = boardSizes(scale);
  const out = new Map<string, TokenText>();
  const labelInputs: LabelInput[] = [];
  const obstacles = pillObstacles(pills, scale);
  for (const b of mapLabels) obstacles.push({ box: { x0: b.x0 * scale, y0: b.y0 * scale, x1: b.x1 * scale, y1: b.y1 * scale }, kind: "map" });
  const meta = new Map<string, { widthPx: number; ox: number; oy: number; hpLine: string | null; image: boolean; number: number | undefined; ringBottom: number | null }>();
  for (const t of tokens) {
    const fp = footprint(t);
    const widthPx = fp.w * scale;
    const heightPx = fp.h * scale;
    const at = place?.(t);
    const ox = (at ? at.x : t.x) * scale;
    const oy = (at ? at.y : t.y) * scale;
    const box: Box = { x0: ox, y0: oy, x1: ox + widthPx, y1: oy + heightPx };
    obstacles.push({ box, owner: t.id, kind: "body" });
    // A standee's ring lies under its frame, where no other label may land and its own goes below it.
    const ring = at?.ring ? { x0: at.ring.x0 * scale, y0: at.ring.y0 * scale, x1: at.ring.x1 * scale, y1: at.ring.y1 * scale } : null;
    if (ring) obstacles.push({ box: ring, owner: t.id, kind: "body" });
    const actor: Partial<Actor> | undefined = "inline" in t.actor ? t.actor.inline : characters?.[t.actor.ref]?.actor;
    const fullAccess = role === "dm" || ownsToken(t);
    // A creature with no HP to show, such as an effect companion, gets no HP bar, label or Bloodied notch (docs/design-v1-combat-flow.md 3.6.6).
    const less = hpLess(actor, t);
    const hp: HpDisplay = less ? { kind: "none" } : hpDisplay({ actor, hpVisibility: t.hpVisibility, fullAccess });
    const state = less ? null : healthState({ actor, hpVisibility: t.hpVisibility, fullAccess });
    const big = widthPx >= DECOR_MIN_PX;
    const marks = big
      ? tokenMarks({
          widthPx,
          heightPx,
          effects: actor?.effects ?? [],
          elevation: t.elevation,
          hasBar: hp.kind === "bar",
          cellPx: scale,
          sizes,
          measure: measureLabel,
          ac: shieldAc(t, actor),
          lock: lockShown(t),
          numberReserve: t.image && t.number !== undefined ? numberBadgeWidth(t.number, sizes.numberPx) : 0,
        })
      : null;
    for (const m of marks?.boxes ?? []) obstacles.push({ box: { x0: m.x0 + ox, y0: m.y0 + oy, x1: m.x1 + ox, y1: m.y1 + oy }, owner: t.id, kind: "mark" });
    const own = t.kind === "pc" || ownsToken(t);
    const rank = t.id === selectedId ? 3 : t.id === activeTokenId ? 2 : own ? 1 : 0;
    const hpLine = hp.kind === "label" ? hp.label : hp.kind === "bar" ? (hp.text ?? null) : null;
    meta.set(t.id, { widthPx, ox, oy, hpLine, image: !!t.image, number: t.number, ringBottom: ring ? ring.y1 - oy : null });
    out.set(t.id, { widthPx, heightPx, ...(ring ? { footPx: ring.y1 - oy } : {}), hp, marks, label: null, plate: null, numberBadge: false, notch: bloodiedNotch(state, widthPx, heightPx, sizes.ringPx) });
    // Under the marks' size only the acting creature and the viewer's own tokens try for a name.
    if (!big && rank < 2 && !ownsToken(t)) continue;
    labelInputs.push({
      id: t.id,
      box,
      belowY: Math.max(oy + (marks ? marks.belowY : heightPx + sizes.gapPx), ring ? ring.y1 + sizes.gapPx : -Infinity),
      aboveY: oy + (marks ? marks.aboveY : -sizes.gapPx),
      sideTopY: marks ? oy + marks.sideTopY : undefined,
      name: t.name,
      number: t.number,
      hp: hpLine,
      alert: state === "Bloodied" || state === "Dying",
      rank,
      sides: rank >= 2,
      nameOnly: !big,
      style: labelStyle(sizes, widthPx, scale),
    });
  }
  const placed = placeLabels(labelInputs, obstacles, measureLabel, kept);
  for (const [id, p] of placed) {
    const m = meta.get(id)!;
    const text = out.get(id)!;
    if (p.lines.length > 0) {
      text.label = { lines: p.lines, x: p.box.x0 - m.ox, y: p.box.y0 - m.oy, width: p.box.x1 - p.box.x0, height: p.box.y1 - p.box.y0 };
    }
    text.numberBadge = showsNumberBadge(m, p);
  }
  for (const [id, m] of meta) if (!placed.has(id)) out.get(id)!.numberBadge = showsNumberBadge(m, undefined);
  return { out, meta, sizes, placed };
}
