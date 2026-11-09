import type Konva from "konva";
import { memo, useMemo } from "react";
import { Circle, Group, Path, Shape } from "react-konva";
import type { FloorLink, Scene } from "#shared/model.ts";
import { linkDir } from "#shared/rules/floorLinks.ts";
import { isHex, sceneGrid, type Grid } from "#shared/rules/grid.ts";
import { rectHexes } from "#shared/rules/traps.ts";
import { usePublishPills, type PillSpec } from "../../canvas/boardView.ts";
import { MarkPill } from "../../canvas/IsoParts.tsx";
import { drawsHere } from "../../canvas/isoPlace.ts";
import { pillStands } from "../../canvas/markStand.ts";
import { useIsoGround, useTreeShownView } from "../../canvas/relief/context.ts";
import { hexOutline } from "../../lib/scene.ts";
import { boardTheme } from "../../lib/theme.ts";
import type { LayerProps } from "../layers.ts";
import { trapNameShown } from "../traps/rules.ts";
import { FLOOR_LINK_ATTR } from "./ids.ts";
import { NOT_REACHED } from "./linkWords.ts";
import { linkLabel, notReachedLinks, quietLinks } from "./linkMarks.ts";

const NO_LINKS: Readonly<Record<string, FloorLink>> = {};
const NO_SCENES: Readonly<Record<string, Scene>> = {};
const NO_PILLS: readonly PillSpec[] = [];

/** The lock's disc on screen, in pixels, as a trap's badge is drawn. */
const LOCK_PX = 18;
/** Lucide's lock (client/components/Icon.tsx `locked`) as one path on its 24 px box: the body, then the shackle. */
const LOCK_PATH = "M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2zM7 11V7a5 5 0 0 1 10 0v4";

/**
 * Stairs and ladders on the floor shown (docs/design/design-v1-floors.md
 * phase 2, 10, 11, D-261109-024), on the board layer under the fog, as a
 * found trap lies: a thin outline in the board's accent, treads and a
 * chevron for the way they lead for stairs, rails and rungs for a ladder,
 * the outline dashed with a lock while locked, and a name pill over the
 * top edge. The pill reads "Up to Upper floor" where the viewer holds that
 * floor, else "Stairs up" or "Ladder down", and the DM's adds "Not reached
 * yet" where players have not reached it. The name gives way to the
 * turn's marker while the creature whose turn it is stands where its moves
 * on this floor began, as after it climbed (picture 07). No tap in play:
 * a tap on the board selects creatures. Isometric draws the end flat on
 * the ground, and its name stands up where every cell under it is
 * revealed, as a trap's name does, else lies flat under the fog
 * (docs/design/design-v1-isometric-view.md 5.2). Each mark carries its
 * end's id and its pill's words as attributes, which the e2e files read
 * off the canvas.
 */
export const LinkLayer = memo(function LinkLayer(props: LayerProps) {
  const links = useTreeShownView((s) => s.floorView?.floorLinks ?? NO_LINKS);
  const scenes = useTreeShownView((s) => s.floorView?.scenes ?? NO_SCENES);
  const dm = props.role === "dm";
  const notReached = useTreeShownView((s) => (dm && s.view ? notReachedLinks(s.view, props.scene.id).join(" ") : ""));
  const quiet = useTreeShownView((s) => quietLinks(s.floorView, props.scene.id, props.role).join(" "));
  const grid = useMemo(() => sceneGrid(props.scene), [props.scene.gridShape]);
  const list = useMemo(
    () =>
      Object.values(links)
        .filter((l) => l.sceneId === props.scene.id)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [links, props.scene.id],
  );
  const far = useMemo(() => new Set(notReached.split(" ")), [notReached]);
  const hushed = useMemo(() => new Set(quiet.split(" ")), [quiet]);
  return (
    <Group listening={false}>
      {list.map((l) => (
        <LinkMark key={l.id} link={l} scenes={scenes} grid={grid} scale={props.scale} notReached={far.has(l.id)} quiet={hushed.has(l.id)} />
      ))}
    </Group>
  );
});

/** An end's squares as the board draws them: a box in cells, and on hexes the outline of its hexes. */
type Outline = { x: number; y: number; w: number; h: number; loop: number[] | null };

function outlineOf(g: Grid, rect: FloorLink["rect"]): Outline {
  if (!isHex(g)) return { ...rect, loop: null };
  const loop = hexOutline(g, rectHexes([rect]));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i + 1 < loop.length; i += 2) {
    x0 = Math.min(x0, loop[i]!);
    x1 = Math.max(x1, loop[i]!);
    y0 = Math.min(y0, loop[i + 1]!);
    y1 = Math.max(y1, loop[i + 1]!);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, loop };
}

/** Where the name hangs: over the middle of the top edge, or on hexes the top point or side nearest the middle, so it never points at the notch between two hexes. */
function nameAnchor(o: Outline): { x: number; y: number } {
  const mid = o.x + o.w / 2;
  if (!o.loop) return { x: mid, y: o.y };
  let best = { x: mid, y: o.y };
  let gap = Infinity;
  for (let i = 0; i + 1 < o.loop.length; i += 2) {
    const x = o.loop[i]!;
    const y = o.loop[i + 1]!;
    if (Math.abs(y - o.y) > 1e-9) continue;
    if (Math.abs(x - mid) < gap) {
      gap = Math.abs(x - mid);
      best = { x, y };
    }
  }
  return best;
}

/** A closed loop of points, x then y, as the path to clip or stroke. */
function trace(ctx: Konva.Context, loop: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(loop[0]!, loop[1]!);
  for (let i = 2; i + 1 < loop.length; i += 2) ctx.lineTo(loop[i]!, loop[i + 1]!);
  ctx.closePath();
}

const LinkMark = memo(function LinkMark(props: { link: FloorLink; scenes: Readonly<Record<string, Scene>>; grid: Grid; scale: number; notReached: boolean; quiet: boolean }) {
  const { link, scale } = props;
  const o = useMemo(() => outlineOf(props.grid, link.rect), [props.grid, link.rect]);
  const dir = linkDir({ scenes: props.scenes }, link);
  const label = linkLabel({ scenes: props.scenes }, link);
  const at = nameAnchor(o);
  const pill: PillSpec | null =
    label === null || props.quiet || !trapNameShown(scale)
      ? null
      : { name: label, ...(props.notReached ? { value: NOT_REACHED } : {}), x: at.x, y: at.y, above: true, size: "map", small: true, maxLines: 1 };
  const iso = useIsoGround();
  // The end lies on the ground: Top-down's board, or the isometric ground stage.
  const flat = iso === null || iso.place === "ground";
  const pillKey = pill ? JSON.stringify(pill) : "";
  // Keyed on what the name says and where, so a pinch that keeps it shown publishes nothing new.
  usePublishPills(`floorLink:${link.id}`, useMemo(() => (pill ? [pill] : NO_PILLS), [pillKey]));
  const color = boardTheme.color.accentSoft;
  const locked = link.locked === true;
  const words = pill ? (pill.value ? `${pill.name} · ${pill.value}` : pill.name!) : "";
  return (
    <Group {...{ [FLOOR_LINK_ATTR]: link.id, "data-floor-link-name": words }}>
      {flat ? <LinkShape o={o} kind={link.kind} dir={dir} locked={locked} color={color} scale={scale} /> : null}
      {pill && drawsHere(iso, iso ? pillStands(iso.fog, { ...pill, scale }) : true) ? <MarkPill {...pill} scale={scale} color={color} /> : null}
    </Group>
  );
});

/** An end's marks on the ground: its treads or rungs, the chevron of its way, its outline, and its lock on the bottom right corner, clear of the name over the top edge. */
function LinkShape(props: { o: Outline; kind: FloorLink["kind"]; dir: "up" | "down" | null; locked: boolean; color: string; scale: number }) {
  const { o, kind, dir, locked, color } = props;
  const s = 1 / props.scale;
  const r = (LOCK_PX / 2) * s;
  const k = (LOCK_PX * 0.6 * s) / 24;
  return (
    <>
      <Shape
        listening={false}
        perfectDrawEnabled={false}
        sceneFunc={(ctx: Konva.Context, shape: Konva.Shape) => {
          const px = 1 / (shape.getAbsoluteScale().x || 1);
          const { x, y, w, h } = o;
          ctx.save();
          if (o.loop) {
            trace(ctx, o.loop);
            ctx.clip();
          }
          ctx.lineCap = "round";
          ctx.lineJoin = "round";
          // A dark ground under the marks, so they read on any map.
          ctx.globalAlpha = 0.3;
          ctx.fillStyle = boardTheme.color.textHalo;
          ctx.fillRect(x, y, w, h);
          ctx.globalAlpha = 1;
          const stroke = (width: number, style: string) => {
            ctx.lineWidth = width * px;
            ctx.strokeStyle = style;
            ctx.stroke();
          };
          const pad = Math.min(w, h) * 0.12;
          ctx.beginPath();
          if (kind === "stairs") {
            // Treads across the long side, about three a square.
            const across = w >= h;
            const n = Math.max(4, Math.round((across ? w : h) * 3));
            for (let i = 1; i < n; i++) {
              if (across) {
                ctx.moveTo(x + (w * i) / n, y + pad);
                ctx.lineTo(x + (w * i) / n, y + h - pad);
              } else {
                ctx.moveTo(x + pad, y + (h * i) / n);
                ctx.lineTo(x + w - pad, y + (h * i) / n);
              }
            }
          } else {
            // Two rails down the middle, and rungs between them.
            const r1 = x + w / 2 - Math.min(w, 1) * 0.22;
            const r2 = x + w / 2 + Math.min(w, 1) * 0.22;
            ctx.moveTo(r1, y + pad);
            ctx.lineTo(r1, y + h - pad);
            ctx.moveTo(r2, y + pad);
            ctx.lineTo(r2, y + h - pad);
            const n = Math.max(3, Math.round(h * 4));
            for (let i = 1; i < n; i++) {
              ctx.moveTo(r1, y + (h * i) / n);
              ctx.lineTo(r2, y + (h * i) / n);
            }
          }
          stroke(4, boardTheme.color.textHalo);
          stroke(1.5, boardTheme.color.text);
          // The way they lead, in the middle: a chevron up or down.
          if (dir !== null) {
            const cx = x + w / 2;
            const cy = y + h / 2;
            const c = Math.min(w, h) * 0.22;
            const tip = dir === "up" ? -1 : 1;
            ctx.beginPath();
            ctx.moveTo(cx - c, cy - tip * c * 0.5);
            ctx.lineTo(cx, cy + tip * c * 0.5);
            ctx.lineTo(cx + c, cy - tip * c * 0.5);
            stroke(6, boardTheme.color.textHalo);
            stroke(3, color);
          }
          ctx.restore();
          // The outline last, unclipped, so its whole width shows.
          if (o.loop) trace(ctx, o.loop);
          else {
            ctx.beginPath();
            ctx.rect(x, y, w, h);
          }
          ctx.setLineDash(locked ? [5 * px, 4 * px] : []);
          stroke(3.5, boardTheme.color.textHalo);
          stroke(1.5, color);
          ctx.setLineDash([]);
        }}
      />
      {locked ? (
        <>
          <Circle x={o.x + o.w} y={o.y + o.h} radius={r} fill={boardTheme.color.overlay} stroke={color} strokeWidth={1.5} strokeScaleEnabled={false} listening={false} />
          <Path data={LOCK_PATH} x={o.x + o.w - 12 * k} y={o.y + o.h - 12 * k} scaleX={k} scaleY={k} stroke={color} strokeWidth={2} strokeScaleEnabled={false} lineCap="round" lineJoin="round" listening={false} />
        </>
      ) : null}
    </>
  );
}
