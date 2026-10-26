import type Konva from "konva";
import { createContext, memo, useContext, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Arc, Circle, Ellipse, Group, Image as KImage, Line, Rect, Shape, Text } from "react-konva";
import type { Actor, Effect } from "#shared/model.ts";
import { shownLife } from "#shared/rules/hp.ts";
import { boardSizes } from "../lib/boardScale.ts";
import { isAppleDevice } from "../lib/device.ts";
import { lineHeight, type LabelLine } from "../lib/boardText.ts";
import { displayName, footprint, type ViewToken } from "../lib/scene.ts";
import { theme } from "../lib/theme.ts";
import { cropSourceRect, DECOR_MIN_PX, DISPOSITION_RING, effectChip, effectCount, initials, type Chip } from "../lib/tokenView.ts";
import { useAccent } from "../state/accent.ts";
import { addsToSelection } from "../state/selection.ts";
import { useAssets, useRoomView } from "../state/view.ts";
import { useChipIcon } from "./chipIcons.ts";
import { LABEL_FAMILY } from "./measureText.ts";
import { PLATE_STROKE, plateRect } from "./textBoxes.ts";
import { TokenShadow } from "./TokenShadow.tsx";
import { numberBadgeWidth, type Notch, type TokenMarks } from "./tokenMarks.ts";
import { SHIELD_BOUNDS, SHIELD_PATH } from "../components/acBadge.ts";
import type { PlacedLines, TokenText } from "./useBoardText.ts";
import { useTokenImage } from "./useImage.ts";
import { isAssetImage } from "#shared/imageRef.ts";
import { glyphColor, glyphSide, iconPath2D, imageFace, useIconGlyph } from "../features/images/icons.ts";
import { COVER_INSET, pressBoxes, type CellBox } from "../features/attach/groups.ts";
import { groundGroups, isometric, toView, type Turn } from "../lib/view.ts";
import { standeeParts } from "./relief/standee.ts";

/** How the canvas wants to hear about taps, menus, drags and the mouse over tokens. */
export type TokenInteraction = {
  /** The mouse over a token, or off it (null): a desktop shows that token's whole label. */
  hover(tokenId: string | null): void;
  /** `add` is Shift or Ctrl held (Cmd on a Mac, state/selection.ts addsToSelection): add the token to the selection or take it out. */
  select(tokenId: string, add: boolean): void;
  menu(tokenId: string): void;
  dragStart(node: Konva.Node, token: ViewToken): void;
  dragMove(node: Konva.Node, token: ViewToken): void;
  dragEnd(node: Konva.Node, token: ViewToken): void;
};

export const TokenInteractionContext = createContext<TokenInteraction | null>(null);

/**
 * A token on the isometric view's relief (docs/design-v1-isometric-view.md
 * 5.4): a standee, its art upright on its ring, or for a creature the stand
 * rule lays flat (5.2), only an invisible press area on its footprint, its
 * picture lying on the ground stage under the fog.
 */
export type IsoToken = {
  turn: Turn;
  /** Its drawn base and the drawn ground under its footprint, in cells (view.ts drawnBase). */
  base: number;
  ground: number;
  /** The base as it draws, in cells: `base`, or lower where the lift on screen is capped (standee.ts standeeShape). */
  drawn: number;
  /** The lift on screen was capped, so the stem shows a break (5.4). */
  capped: boolean;
  /** How far up its holder it rides, in view units: half the holder's art height. */
  rise: number;
  /** The share of its size its art draws at: COVER_INSET when it rides a holder it covers, else 1. */
  inset: number;
  /** The pit cells it stands in, whose openings clip it (5.5). */
  pits: readonly { x: number; y: number }[];
  /** On the DM's device, a standee the players cannot see draws dimmed (5.4). */
  dim: boolean;
  pressOnly: boolean;
};

const APPLE = isAppleDevice();

type DecorProps = {
  /** The token's marks, label and plate, laid out with every other token's (useBoardText.ts). */
  text: TokenText | undefined;
  /** Show a lock on a locked token whose lock this viewer would otherwise be able to drag past. */
  lockMark: boolean;
};

/**
 * One token (design sections 11.4 and 14.2). The body is drawn in world
 * cells, so it grows with the zoom. Its ring, chips, badge, HP bar and
 * label are sized for the zoom by lib/boardScale.ts and drawn in screen
 * pixels inside groups scaled by the inverse of the camera zoom.
 *
 * Those decorations normally come from TokenDecor in a pass above every
 * token and the fog (Stage.tsx). A token this device is dragging draws its
 * own instead (`decor`), so they travel with it.
 *
 * A carried token that covers its holder's whole footprint draws `inset`,
 * at COVER_INSET of its size about its middle, so the mount's edge and
 * ring show around the rider (docs/design-v1-attach.md 4.4). A tap on the
 * mount's edge then reaches the mount.
 *
 * A carried token smaller than its holder leaves the holder's middle to it
 * (`holes`, groups.ts holderMiddles, reviews LP12-AT-3 and FU20A-ASTRA-5),
 * and the middle of every holder below that carries it: only the rest of
 * its footprint, or of its inset face, takes a press, so a press in a
 * holder's middle reaches the holder under it, and a phone can drag a
 * Medium creature that carries a lamp, an owl and a chest, a gem in the
 * lamp too. Everywhere else a press hits the topmost token.
 */
export const TokenNode = memo(function TokenNode(props: DecorProps & {
  token: ViewToken;
  scale: number;
  selected: boolean;
  active: boolean;
  draggable: boolean;
  decor: boolean;
  inset?: boolean;
  holes?: readonly CellBox[] | null;
  /** On the isometric view's relief: a standee or a press area. Absent in Top-down and on the ground stage. */
  iso?: IsoToken | null;
}) {
  const { token, scale, selected, active, draggable, holes } = props;
  const iso = props.iso ?? null;
  const interaction = useContext(TokenInteractionContext);
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const actor: Partial<Actor> | undefined = "inline" in token.actor ? token.actor.inline : character?.actor;
  const fp = footprint(token);
  const name = displayName(token);
  /*
   * A drag moves the node by hand, and a drop puts it where the plan lands
   * it (Stage.tsx landDrop). react-konva then sets only the coordinates
   * whose props changed, so where the move lands elsewhere on one axis
   * alone, as the DM's own copy stops a walk at a pit on the row it
   * started on, the other kept the drop's value and the picture stood
   * apart from its badges. Each new place sets both.
   */
  const groupRef = useRef<Konva.Group>(null);
  useLayoutEffect(() => {
    const node = groupRef.current;
    if (!node || node.isDragging() || (node.x() === token.x && node.y() === token.y)) return;
    node.position({ x: token.x, y: token.y });
    node.getLayer()?.batchDraw();
  }, [token.x, token.y]);

  return (
    <Group
      ref={groupRef}
      id={token.id}
      name="token"
      x={token.x}
      y={token.y}
      draggable={draggable}
      opacity={iso?.dim ? theme.relief.hiddenOpacity : token.visibility === "dm" ? 0.5 : 1}
      clipFunc={iso && iso.pits.length > 0 ? (ctx) => clipToOpenings(ctx, iso, token) : undefined}
      onPointerClick={(e) => interaction?.select(token.id, addsToSelection(e.evt, APPLE))}
      onMouseEnter={() => interaction?.hover(token.id)}
      onMouseLeave={() => interaction?.hover(null)}
      onContextMenu={(e) => {
        e.evt.preventDefault();
        interaction?.menu(token.id);
      }}
      onDragStart={(e) => interaction?.dragStart(e.target, token)}
      onDragMove={(e) => interaction?.dragMove(e.target, token)}
      onDragEnd={(e) => interaction?.dragEnd(e.target, token)}
    >
      {iso ? (
        iso.pressOnly ? (
          <FootprintPress w={fp.w} h={fp.h} />
        ) : (
          <Standee
            token={token}
            actor={actor}
            w={fp.w}
            h={fp.h}
            scale={scale}
            name={name}
            active={active}
            selected={selected}
            iso={iso}
            decor={props.decor ? <DecorParts token={token} effects={actor?.effects ?? []} scale={scale} text={props.text} lockMark={props.lockMark} part="all" /> : null}
          />
        )
      ) : props.inset ? (
        <>
          <Group x={(fp.w * (1 - COVER_INSET)) / 2} y={(fp.h * (1 - COVER_INSET)) / 2} scaleX={COVER_INSET} scaleY={COVER_INSET} listening={!holes}>
            <TokenFace token={token} actor={actor} w={fp.w} h={fp.h} scale={scale * COVER_INSET} name={name} active={active} selected={selected} />
          </Group>
          {holes ? <PressArea w={fp.w} h={fp.h} inset holes={holes} /> : null}
        </>
      ) : holes ? (
        <>
          <Group listening={false}>
            <TokenFace token={token} actor={actor} w={fp.w} h={fp.h} scale={scale} name={name} active={active} selected={selected} />
          </Group>
          <PressArea w={fp.w} h={fp.h} inset={false} holes={holes} />
        </>
      ) : (
        <TokenFace token={token} actor={actor} w={fp.w} h={fp.h} scale={scale} name={name} active={active} selected={selected} />
      )}
      {props.decor && !(iso && !iso.pressOnly) ? <DecorParts token={token} effects={actor?.effects ?? []} scale={scale} text={props.text} lockMark={props.lockMark} part="all" /> : null}
    </Group>
  );
});

/** A flat creature's press area on the isometric relief: its footprint, on the hit canvas alone, over its picture on the ground stage below (5.2). */
function FootprintPress(props: { w: number; h: number }) {
  return (
    <Shape
      sceneFunc={() => {}}
      hitFunc={(ctx, shape) => {
        ctx.beginPath();
        ctx.rect(0, 0, props.w, props.h);
        ctx.fillStrokeShape(shape);
      }}
    />
  );
}

/**
 * Clips a standee in a pit to the openings of its pit cells swept up past
 * the canvas's top, so the near rim hides what is below it (5.5). Drawn in
 * view units: the clip undoes the ground's turn and squash, then restores
 * the transform, so the path stays and Konva's own transform is untouched.
 */
function clipToOpenings(ctx: Konva.Context, iso: IsoToken, at: { x: number; y: number }): void {
  const view = isometric(iso.turn);
  const g = groundGroups(iso.turn);
  ctx.save();
  ctx.translate(-at.x, -at.y);
  ctx.rotate((g.upright.rotation * Math.PI) / 180);
  ctx.scale(1, g.upright.scaleY);
  ctx.beginPath();
  for (const cell of iso.pits) {
    const corners = [toView(view, cell), toView(view, { x: cell.x + 1, y: cell.y }), toView(view, { x: cell.x + 1, y: cell.y + 1 }), toView(view, { x: cell.x, y: cell.y + 1 })];
    const left = corners.reduce((a, b) => (b.x < a.x ? b : a));
    const right = corners.reduce((a, b) => (b.x > a.x ? b : a));
    const bottom = corners.reduce((a, b) => (b.y > a.y ? b : a));
    const sky = Math.min(left.y, right.y) - 1e5;
    ctx.moveTo(left.x, left.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(right.x, sky);
    ctx.lineTo(left.x, sky);
    ctx.closePath();
  }
  ctx.restore();
}

/**
 * A standee (5.4): the token's art upright, never turned by its rotation,
 * its bottom middle on the footprint's center at its base, on its ring, the
 * footprint's ellipse at the base filled 25% black. A base above the drawn
 * ground casts a shadow there, joined to the ring by a stem. A turned token
 * shows a short tick on its ring toward its facing. The node itself stays
 * at the token's world x and y inside the ground group, so a drag reads
 * world cells as it does in Top-down. A standee this device drags carries
 * its own decor (`decor`), upright on the box the overlay lays it out on
 * (standee.ts frame), so it travels with the standee in the drag layer.
 */
function Standee(props: { token: ViewToken; actor: Partial<Actor> | undefined; w: number; h: number; scale: number; name: string; active: boolean; selected: boolean; iso: IsoToken; decor?: ReactNode }) {
  const { token, w, h, scale, iso } = props;
  // Drawn from the capped base the layout read, so the art is where it culls, decorates and casts silhouettes.
  const parts = standeeParts(iso.turn, iso.drawn, iso.ground, { w, h }, iso);
  const upright = groundGroups(iso.turn).upright;
  const ringPx = boardSizes(scale).ringPx;
  const ring = DISPOSITION_RING[token.disposition] ?? theme.color.neutral;
  const turnedBy = Number.isFinite(token.rotation) ? token.rotation : 0;
  const facing = (turnedBy * Math.PI) / 180;
  return (
    <>
      {parts.shadow ? <Ellipse x={w / 2 + parts.shadow.x} y={h / 2 + parts.shadow.y} radiusX={w / 2} radiusY={h / 2} fill={theme.relief.shadow} listening={false} /> : null}
      <Group x={parts.base.x} y={parts.base.y}>
        <Ellipse x={w / 2} y={h / 2} radiusX={w / 2} radiusY={h / 2} fill={theme.relief.ring} stroke={ring} strokeWidth={ringPx} strokeScaleEnabled={false} />
        {turnedBy !== 0 ? (
          <Line
            points={[w / 2 + (Math.sin(facing) * w) / 2, h / 2 - (Math.cos(facing) * h) / 2, w / 2 + Math.sin(facing) * (w / 2 + 0.18), h / 2 - Math.cos(facing) * (h / 2 + 0.18)]}
            stroke={ring}
            strokeWidth={Math.max(2, ringPx)}
            strokeScaleEnabled={false}
            lineCap="round"
            listening={false}
          />
        ) : null}
        {props.active ? <Outline w={w} h={h} scale={scale} gapPx={7} color={theme.color.accentSoft} widthPx={3} /> : null}
        {props.selected ? <SelectedOutline w={w} h={h} scale={scale} /> : null}
        <Group x={w / 2} y={h / 2} rotation={upright.rotation} scaleY={upright.scaleY}>
          {parts.stem > 0 ? <Line points={[0, 0, 0, parts.stem]} stroke={theme.relief.stem} strokeWidth={1} strokeScaleEnabled={false} dash={iso.capped ? [6 / scale, 4 / scale] : undefined} listening={false} /> : null}
          <Group x={parts.art.x} y={parts.art.y} scaleX={parts.art.scale} scaleY={parts.art.scale}>
            <TokenBody token={token} actor={props.actor} w={w} h={h} scale={scale * parts.art.scale} name={props.name} upright />
          </Group>
          {props.decor ? (
            <Group x={-w / 2} y={-h - iso.rise} listening={false}>
              {props.decor}
            </Group>
          ) : null}
        </Group>
      </Group>
    </>
  );
}

/** Where a carried token takes a press: the part of it that draws less its holders' middles (`holes`, groups.ts pressBoxes), drawn on the hit canvas alone. */
function PressArea(props: { w: number; h: number; inset: boolean; holes: readonly CellBox[] }) {
  const boxes = useMemo(() => pressBoxes(props.w, props.h, props.inset, props.holes), [props.w, props.h, props.inset, props.holes]);
  return (
    <Shape
      sceneFunc={() => {}}
      hitFunc={(ctx, shape) => {
        ctx.beginPath();
        for (const b of boxes) ctx.rect(b.x, b.y, b.w, b.h);
        ctx.fillStrokeShape(shape);
      }}
    />
  );
}

/** The token's own picture: its shadow, its body and the rings that mark it active or selected. */
function TokenFace(props: { token: ViewToken; actor: Partial<Actor> | undefined; w: number; h: number; scale: number; name: string; active: boolean; selected: boolean }) {
  const { token, actor, w, h, scale, name } = props;
  return (
    <>
      <TokenShadow token={token} w={w} h={h} />
      <TokenBody token={token} actor={actor} w={w} h={h} scale={scale} name={name} />
      {props.active ? <Outline w={w} h={h} scale={scale} gapPx={7} color={theme.color.accentSoft} widthPx={3} /> : null}
      {props.selected ? <SelectedOutline w={w} h={h} scale={scale} /> : null}
    </>
  );
}

/**
 * A token's marks, label or plate, in a pass of their own above every
 * token body and the fog (Stage.tsx). Drawn inside each token, a label
 * hung under a token in the row above would hide under the token below it,
 * and a label beside the fog edge would be cut by the fog. Every token a
 * player's view holds is at least partly in sight (design 13.4), so its
 * name over the fog shows nothing new. Marks, labels and plates are
 * separate passes, so a plate draws over every label and mark.
 */
export const TokenDecor = memo(function TokenDecor(props: DecorProps & {
  token: ViewToken;
  scale: number;
  part: "marks" | "label" | "plate";
  /** Where its box's top left sits, when not at the token's own corner: the isometric view lays decor out on the standee's art box (5.4). */
  atX?: number;
  atY?: number;
}) {
  const { token } = props;
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const effects = ("inline" in token.actor ? token.actor.inline.effects : character?.actor.effects) ?? NO_EFFECTS;
  return (
    <Group x={props.atX ?? token.x} y={props.atY ?? token.y} opacity={token.visibility === "dm" ? 0.5 : 1} listening={false}>
      <DecorParts {...props} effects={effects} />
    </Group>
  );
});

const NO_EFFECTS: readonly Effect[] = [];

function DecorParts(props: DecorProps & {
  token: ViewToken;
  effects: readonly Effect[];
  scale: number;
  part: "marks" | "label" | "plate" | "all";
}) {
  const { token, scale, part, text } = props;
  if (!text) return null;
  const marks = part === "marks" || part === "all";
  const label = part === "label" || part === "all";
  const plate = part === "plate" || part === "all";
  const sizes = boardSizes(scale);
  return (
    <Group scaleX={1 / scale} scaleY={1 / scale}>
      {marks && text.marks ? <TopDecor effects={props.effects} marks={text.marks} /> : null}
      {marks && text.notch ? <BloodiedNotch notch={text.notch} /> : null}
      {marks && text.numberBadge && token.number !== undefined ? <NumberBadge widthPx={text.widthPx} heightPx={text.heightPx} number={token.number} px={sizes.numberPx} /> : null}
      {marks && text.marks?.lock && props.lockMark && token.locked ? <LockMark place={text.marks.lock} /> : null}
      {marks && text.marks?.ac ? <AcMark ac={text.marks.ac} /> : null}
      {marks && text.marks?.bar && text.hp.kind === "bar" ? <HpBar box={text.marks.bar} fraction={text.hp.fraction} /> : null}
      {label && text.label && !text.plate ? <Lines block={text.label} /> : null}
      {plate && text.plate ? <Lines block={text.plate} plate /> : null}
    </Group>
  );
}

/** A padlock at the bottom left, in its corner or above the AC shield (tokenMarks.ts), so a locked token says why a drag does nothing. Named for the e2e. */
function LockMark(props: { place: { x: number; y: number; size: number } }) {
  const { x, y, size } = props.place;
  const k = size / 18;
  return (
    <Group name="lock-mark" x={x + 9 * k} y={y + 9 * k} scaleX={k} scaleY={k}>
      <Rect x={-9} y={-9} width={18} height={18} cornerRadius={9} fill={theme.color.surfaceRaised} stroke={theme.color.accentSoft} strokeWidth={1} />
      <Arc x={0} y={-1} innerRadius={2} outerRadius={3.6} angle={180} rotation={180} fill={theme.color.accentSoft} />
      <Rect x={-4.5} y={-1} width={9} height={6.5} cornerRadius={1.5} fill={theme.color.accentSoft} />
    </Group>
  );
}

let shieldPath: Path2D | null = null;

/**
 * The creature's AC on the party bar's shield (docs/design-v1-token-panel.md
 * 3.9), in the token's bottom left corner as the number badge sits in the
 * bottom right, filled and outlined as that badge is. Named for the e2e.
 */
function AcMark(props: { ac: NonNullable<TokenMarks["ac"]> }) {
  const { ac } = props;
  // The outline stretched to fill the badge's box, as the page's AcBadge draws it.
  const sx = ac.width / SHIELD_BOUNDS.width;
  const sy = ac.height / SHIELD_BOUNDS.height;
  return (
    <Group name="ac-badge" x={ac.x} y={ac.y}>
      {/* A plain Shape over the outline's Path2D, as IconGlyph draws, so the board needs no Konva Path and its SVG parser (konvaSetup.ts). */}
      <Shape
        width={ac.width}
        height={ac.height}
        sceneFunc={(ctx) => {
          shieldPath ??= new Path2D(SHIELD_PATH);
          ctx.save();
          ctx.scale(sx, sy);
          ctx.translate(-SHIELD_BOUNDS.x, -SHIELD_BOUNDS.y);
          ctx.setAttr("fillStyle", theme.color.surfaceRaised);
          ctx.fill(shieldPath);
          ctx.setAttr("strokeStyle", theme.color.text);
          ctx.setAttr("lineWidth", 2 / (sx + sy));
          ctx.stroke(shieldPath);
          ctx.restore();
        }}
      />
      {/* In the top 85%, where the shield is widest, so the number never reaches its point. */}
      <Text text={ac.text} width={ac.width} height={ac.height * 0.85} align="center" verticalAlign="middle" fontSize={ac.textPx} fontFamily={LABEL_FAMILY} fontStyle="700" fill={theme.color.text} />
    </Group>
  );
}

/**
 * A Bloodied creature's mark (tokenMarks.ts): an amber notch cut into the
 * right of its ring, outlined in black, so it is a shape as well as a color
 * and reads without color vision. It sits at the ring's side because the
 * top and bottom edges belong to chips, the chips of the token below
 * included, and the corners to the badges.
 */
function BloodiedNotch(props: { notch: Notch }) {
  return <Line points={props.notch.points} closed fill={theme.color.warning} stroke={theme.color.textHalo} strokeWidth={props.notch.strokeWidth} lineJoin="round" />;
}

/** A numbered picture token's number, in its bottom right corner, when its name has given way. */
function NumberBadge(props: { widthPx: number; heightPx: number; number: number; px: number }) {
  const text = String(props.number);
  const d = Math.ceil(props.px + 6);
  const width = numberBadgeWidth(props.number, props.px);
  const x = props.widthPx - width;
  const y = props.heightPx - d;
  return (
    <Group x={x} y={y}>
      <Rect width={width} height={d} cornerRadius={d / 2} fill={theme.color.surfaceRaised} stroke={theme.color.text} strokeWidth={1} />
      <Text text={text} width={width} height={d} align="center" verticalAlign="middle" fontSize={props.px} fontFamily={LABEL_FAMILY} fontStyle="700" fill={theme.color.text} />
    </Group>
  );
}

function HpBar(props: { box: { x0: number; y0: number; x1: number; y1: number }; fraction: number }) {
  const width = props.box.x1 - props.box.x0;
  const height = props.box.y1 - props.box.y0;
  return (
    <Group x={props.box.x0} y={props.box.y0}>
      <Rect width={width} height={height} cornerRadius={height / 2} fill="rgba(0, 0, 0, 0.7)" />
      <Rect width={width * props.fraction} height={height} cornerRadius={height / 2} fill={barColor(props.fraction)} />
    </Group>
  );
}

/**
 * Another member's drag of a token (design section 7.6): a translucent copy
 * at the preview point, ringed in the dragger's color. The token itself
 * stays where the server last put it until the drop commits.
 */
export const TokenGhost = memo(function TokenGhost(props: {
  token: ViewToken;
  x: number;
  y: number;
  scale: number;
  color: string;
  /** In the isometric view's ground group: a standing ghost, or a flat one clipped to the revealed sub-cells of its box (`clip`, in cells). */
  iso?: IsoToken | null;
  clip?: readonly { x: number; y: number; w: number; h: number }[] | null;
}) {
  const { token, x, y, scale, color } = props;
  const character = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const actor: Partial<Actor> | undefined = "inline" in token.actor ? token.actor.inline : character?.actor;
  const fp = footprint(token);
  const clip = props.clip;
  if (props.iso) {
    return (
      <Group x={x} y={y} opacity={theme.relief.ghostOpacity} listening={false}>
        <Standee token={token} actor={actor} w={fp.w} h={fp.h} scale={scale} name={displayName(token)} active={false} selected={false} iso={props.iso} />
      </Group>
    );
  }
  return (
    <Group
      x={x}
      y={y}
      opacity={0.6}
      listening={false}
      clipFunc={
        clip
          ? (ctx) => {
              ctx.beginPath();
              for (const r of clip) ctx.rect(r.x - x, r.y - y, r.w, r.h);
            }
          : undefined
      }
    >
      <TokenShadow token={token} w={fp.w} h={fp.h} at={{ x, y }} />
      <TokenBody token={token} actor={actor} w={fp.w} h={fp.h} scale={scale} name={displayName(token)} />
      <Outline w={fp.w} h={fp.h} scale={scale} gapPx={3} color={color} widthPx={3} />
    </Group>
  );
});

function TokenBody(props: {
  token: ViewToken;
  actor: Partial<Actor> | undefined;
  w: number;
  h: number;
  scale: number;
  name: string;
  /** A standee's art, which its rotation never turns (ISO-D4): a turned figure reads as a fallen one. */
  upright?: boolean;
}) {
  const { token, actor, w, h, scale, name } = props;
  const assets = useAssets();
  const upload = token.image && isAssetImage(token.image) ? token.image : undefined;
  // A shipped icon is a disk of its color with the glyph on it, initials until its file arrives (docs/design-v1-dm-tools.md 3.12).
  const icon = token.image && !isAssetImage(token.image) ? token.image : undefined;
  const glyph = useIconGlyph(icon?.icon ?? null);
  const url = upload ? assets.url(upload.assetId, "full") : null;
  const image = useTokenImage(url);
  const square = token.kind === "object";
  const drawn = imageFace(token.image, image !== null, glyph) !== "initials";
  const crop = useMemo(() => (image ? cropSourceRect(image, upload?.crop, w / h) : undefined), [image, upload?.crop, w, h]);
  // No HP rule kills an object, so the map draws no dead or dying mark on one, and an HP-less creature shows no life it
  // stores underneath (docs/design-v1-combat-flow.md 3.6.6).
  const life = token.kind === "object" ? undefined : shownLife(actor, token);
  const ring = DISPOSITION_RING[token.disposition] ?? theme.color.neutral;
  const ringPx = boardSizes(scale).ringPx;
  return (
    <Group x={w / 2} y={h / 2} rotation={props.upright || !Number.isFinite(token.rotation) ? 0 : token.rotation}>
      <Group
        clipFunc={(ctx) => {
          if (square) ctx.rect(-w / 2, -h / 2, w, h);
          else ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
        }}
      >
        {image ? (
          <KImage image={image} x={-w / 2} y={-h / 2} width={w} height={h} crop={crop} />
        ) : (
          <Rect x={-w / 2} y={-h / 2} width={w} height={h} fill={icon ? icon.color : theme.color.surfaceRaised} />
        )}
        {icon && glyph.status === "ready" ? (
          <IconGlyph iconKey={icon.icon} d={glyph.d} side={glyphSide(w, h, square ? "square" : "circle")} color={glyphColor(icon.color)} />
        ) : null}
        {life === "dead" || life === "dying" || life === "stable" ? (
          <Rect
            x={-w / 2}
            y={-h / 2}
            width={w}
            height={h}
            fill={life === "dead" ? "rgba(0, 0, 0, 0.55)" : "rgba(120, 0, 0, 0.35)"}
          />
        ) : null}
      </Group>
      {!drawn && w * scale >= DECOR_MIN_PX ? (
        <Group scaleX={1 / scale} scaleY={1 / scale} listening={false}>
          <Text
            text={initials(name)}
            x={(-w * scale) / 2}
            y={(-h * scale) / 2}
            width={w * scale}
            height={h * scale}
            align="center"
            verticalAlign="middle"
            fontSize={Math.max(9, Math.min(w, h) * scale * 0.38)}
            fontFamily={LABEL_FAMILY}
            fontStyle="600"
            fill={icon ? glyphColor(icon.color) : theme.color.text}
          />
        </Group>
      ) : null}
      {life === "dead" ? (
        <Line
          points={[-w * 0.3, -h * 0.3, w * 0.3, h * 0.3, 0, 0, w * 0.3, -h * 0.3, -w * 0.3, h * 0.3]}
          stroke={theme.color.danger}
          strokeWidth={Math.max(3, ringPx)}
          strokeScaleEnabled={false}
          listening={false}
        />
      ) : null}
      {square ? (
        <Rect x={-w / 2} y={-h / 2} width={w} height={h} stroke={ring} strokeWidth={ringPx} strokeScaleEnabled={false} />
      ) : (
        <Ellipse radiusX={w / 2} radiusY={h / 2} stroke={ring} strokeWidth={ringPx} strokeScaleEnabled={false} />
      )}
    </Group>
  );
}

/**
 * An icon's glyph, centered on the token and scaled from the file's 512 px
 * box. It fills the icon's one path as a vector, so it stays sharp at any
 * zoom, where a raster would blur on a large token. The path is parsed once
 * per icon and shared by every token wearing it (iconPath2D), so it is drawn
 * by a plain Shape rather than a Konva Path, which would parse it again for
 * each token.
 */
function IconGlyph(props: { iconKey: string; d: string; side: number; color: string }) {
  const { side, color } = props;
  const path = iconPath2D(props.iconKey, props.d);
  const k = side / 512;
  return (
    <Shape
      x={-side / 2}
      y={-side / 2}
      scaleX={k}
      scaleY={k}
      listening={false}
      sceneFunc={(ctx) => {
        ctx.setAttr("fillStyle", color);
        ctx.fill(path);
      }}
    />
  );
}

/** Its own component, so only a selected token reads the accent. */
function SelectedOutline(props: { w: number; h: number; scale: number }) {
  const { accent } = useAccent();
  return <Outline {...props} gapPx={3} color={accent} widthPx={2} dash />;
}

/**
 * A ring a few pixels outside the footprint: the selection, the turn
 * marker, a remote drag. It grows with the zoom like the token's own ring,
 * but never gets thinner than its old fixed width, since it exists to be
 * seen.
 */
function Outline(props: { w: number; h: number; scale: number; gapPx: number; color: string; widthPx: number; dash?: boolean }) {
  const { w, h, scale, color, dash } = props;
  const k = boardSizes(scale).ringPx / 3;
  const widthPx = Math.max(props.widthPx, props.widthPx * k);
  const gap = (props.gapPx * Math.max(0.5, k)) / scale;
  return (
    <Ellipse
      x={w / 2}
      y={h / 2}
      radiusX={w / 2 + gap}
      radiusY={h / 2 + gap}
      stroke={color}
      strokeWidth={widthPx}
      strokeScaleEnabled={false}
      dash={dash ? [(6 * Math.max(1, k)) / scale, (4 * Math.max(1, k)) / scale] : undefined}
      listening={false}
    />
  );
}

function TopDecor(props: { effects: readonly Effect[]; marks: TokenMarks }) {
  const { effects, marks } = props;
  return (
    <Group listening={false}>
      {marks.xs.map((x, i) => {
        const effect = effects[i];
        if (i === marks.shown || !effect) {
          return <ChipView key="overflow" x={x} marks={marks} chip={{ glyph: `+${marks.overflow}`, color: "#3a3a44", label: "" }} iconKey={null} />;
        }
        const chip = effectChip(effect);
        // An exhaustion glyph ("E2") already says its level, so only an icon needs the corner number for it.
        return (
          <ChipView
            key={effect.id}
            x={x}
            marks={marks}
            chip={chip}
            iconKey={effect.key === "custom" ? null : effect.key}
            level={effectCount(effect)}
            levelInGlyph={effect.key === "exhaustion"}
            hidden={effect.hiddenFromPlayers === true}
          />
        );
      })}
      {marks.badge ? <Badge badge={marks.badge} /> : null}
    </Group>
  );
}

/** Icons are white on the chip's color, so color is never the only cue (features section 17). */
const CHIP_ICON_COLOR = "#ffffff";

/**
 * One chip: the condition's icon when it has loaded, the letter glyph until
 * then (and for custom effects), and its number in the corner: an exhaustion
 * level or a counter. A condition hidden from players, which only the DM's
 * view holds, is dimmed with a dashed edge, as a hidden token is dimmed.
 * Letters and numbers never draw under the board's text floor
 * (lib/boardScale.ts): a row holding them is sized to fit (tokenMarks.ts).
 */
function ChipView(props: { x: number; marks: TokenMarks; chip: Chip; iconKey: string | null; level?: number | null; levelInGlyph?: boolean; hidden?: boolean }) {
  const { x, chip, iconKey, level, marks } = props;
  const side = marks.chip;
  const icon = useChipIcon(iconKey ?? "", CHIP_ICON_COLOR);
  const showIcon = iconKey !== null && icon !== null;
  const showLevel = level !== null && level !== undefined && (showIcon || !props.levelInGlyph);
  const levelText = String(level ?? "");
  const levelHeight = Math.ceil(marks.counterPx + 2);
  const levelWidth = Math.max(levelHeight, Math.ceil(levelText.length * marks.counterPx * 0.62 + 4));
  const inset = Math.max(1.5, side / 9);
  return (
    <Group x={x} y={-side / 2} opacity={props.hidden ? 0.6 : 1}>
      <Rect
        width={side}
        height={side}
        cornerRadius={Math.max(3, side / 4.5)}
        fill={chip.color}
        stroke={props.hidden ? theme.color.text : theme.color.textHalo}
        strokeWidth={1}
        dash={props.hidden ? [3, 2] : undefined}
      />
      {showIcon ? (
        <KImage image={icon} x={inset} y={inset} width={side - 2 * inset} height={side - 2 * inset} />
      ) : (
        <Text text={chip.glyph} width={side} height={side} align="center" verticalAlign="middle" fontSize={marks.glyphPx} fontFamily={LABEL_FAMILY} fontStyle="700" fill="#ffffff" wrap="none" />
      )}
      {showLevel ? (
        <Group x={side - levelWidth + 2} y={side - levelHeight + 3}>
          <Rect width={levelWidth} height={levelHeight} cornerRadius={levelHeight / 2} fill={theme.color.textHalo} />
          <Text text={levelText} width={levelWidth} height={levelHeight} align="center" verticalAlign="middle" fontSize={marks.counterPx} fontFamily={LABEL_FAMILY} fontStyle="700" fill="#ffffff" />
        </Group>
      ) : null}
    </Group>
  );
}

function Badge(props: { badge: NonNullable<TokenMarks["badge"]> }) {
  const { badge } = props;
  return (
    <Group x={badge.x} y={badge.y}>
      <Rect width={badge.width} height={badge.height} cornerRadius={badge.height / 2} fill={theme.color.surfaceRaised} stroke={theme.color.accentSoft} strokeWidth={1} />
      <Text text={badge.text} width={badge.width} height={badge.height} align="center" verticalAlign="middle" fontSize={badge.textPx} fontFamily={LABEL_FAMILY} fontStyle="700" fill={theme.color.accentSoft} />
    </Group>
  );
}

const LEADING = 1.17;

/**
 * The HP line is quieter than the name, and its state words are colored:
 * amber for Bloodied, red for Dying and Dead. Each is still a word, so
 * color is never the only cue.
 */
function lineColor(line: LabelLine): string {
  if (line.kind === "name") return theme.color.text;
  if (line.text === "Bloodied") return theme.color.warning;
  if (line.text === "Dying" || line.text === "Dead") return theme.color.dangerText;
  return theme.color.textMuted;
}

/**
 * A label's lines, centered in their block, with a black halo that reads on
 * any map art. A plate (the selected or hovered token's whole label) sits
 * on a dark rounded box instead, over everything.
 */
function Lines(props: { block: PlacedLines; plate?: boolean }) {
  const { block } = props;
  let top = block.y;
  return (
    <Group>
      {props.plate ? (
        <Rect {...plateRect(block)} cornerRadius={6} fill="rgba(16, 16, 20, 0.92)" stroke={theme.color.border} strokeWidth={PLATE_STROKE} />
      ) : null}
      {block.lines.map((line, i) => {
        const y = top;
        top += lineHeight(line.px, LEADING);
        return (
          <Text
            key={i}
            text={line.text}
            x={block.x}
            y={y}
            width={block.width}
            align="center"
            wrap="none"
            fontSize={line.px}
            fontFamily={LABEL_FAMILY}
            fontStyle="600"
            fill={lineColor(line)}
            stroke={props.plate ? undefined : theme.color.textHalo}
            strokeWidth={props.plate ? 0 : line.px / 4}
            fillAfterStrokeEnabled
          />
        );
      })}
    </Group>
  );
}

function barColor(fraction: number): string {
  if (fraction > 0.5) return theme.color.success;
  if (fraction > 0.25) return theme.color.warning;
  return theme.color.danger;
}
