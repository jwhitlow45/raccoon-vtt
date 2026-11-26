import type Konva from "konva";
import { memo, useMemo } from "react";
import { Circle, Group, Path, Shape } from "react-konva";
import type { BuildChunk, FloorLink, Scene, Trap } from "#shared/model.ts";
import { linkDir } from "#shared/rules/floorLinks.ts";
import { sceneGrid } from "#shared/rules/grid.ts";
import { useStore } from "zustand";
import { boardPillsSlot, usePublishPills, useRestView, type PillSpec } from "../../canvas/boardView.ts";
import { useScoped } from "../../state/scope.ts";
import { MarkPill } from "../../canvas/IsoParts.tsx";
import { drawsHere } from "../../canvas/isoPlace.ts";
import { pillStands } from "../../canvas/markStand.ts";
import { useIsoGround, useTreeShownView } from "../../canvas/relief/context.ts";
import { boardTheme } from "../../lib/theme.ts";
import type { LayerProps } from "../layers.ts";
import { linkFrames, trapNameMarkers, trapSquares } from "../traps/TrapLayer.tsx";
import { trapNameShown } from "../traps/rules.ts";
import { FLOOR_LINK_ATTR } from "./ids.ts";
import { dropChip, linkMarksLine } from "./linkWords.ts";
import { tokenSpots, linkLabel, nameAnchor, notReachedLinks, outlineOf, placeEnds, quietLinks, spotsOf, type Outline } from "./linkMarks.ts";
import { holeDrops } from "./openingView.ts";

const NO_LINKS: Readonly<Record<string, FloorLink>> = {};
const NO_SCENES: Readonly<Record<string, Scene>> = {};
const NO_PILLS: readonly PillSpec[] = [];
const NO_TRAPS: Readonly<Record<string, Trap>> = {};
const NO_CHUNKS: Readonly<Record<string, BuildChunk>> = {};

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
 * on this floor began, as after it climbed (picture 07). The DM's pill adds
 * "Hidden" on stairs players get nothing of (phase 4, 8.1).
 *
 * An opening (phase 4, 3 and 7.4) draws no treads: its upper end, the hole,
 * a dashed accent rim round the floor below (OpeningWindow.tsx), its name
 * under the rim and its height chip, "10 ft down", over it where the device
 * holds the floor below and its end, and its lower end a dashed outline.
 * No tap in play:
 * a tap on the board selects creatures. Isometric draws the end flat on
 * the ground, and its name stands up where every cell under it is
 * revealed, as a trap's name does, else lies flat under the fog
 * (docs/design/design-v1-isometric-view.md 5.2). A hole's pills are the
 * exception: one that cannot stand is hidden, since lying flat it runs
 * under the dark cut off and covers a small hole. Each mark carries its
 * end's id and its pill's words as attributes, which the e2e files read
 * off the canvas.
 */
export const LinkLayer = memo(function LinkLayer(props: LayerProps) {
  const links = useTreeShownView((s) => s.floorView?.floorLinks ?? NO_LINKS);
  const scenes = useTreeShownView((s) => s.floorView?.scenes ?? NO_SCENES);
  const dm = props.role === "dm";
  const notReached = useTreeShownView((s) => (dm && s.view ? notReachedLinks(s.view, props.scene.id).join(" ") : ""));
  const quiet = useTreeShownView((s) => quietLinks(s.floorView, props.scene.id, props.role).join(" "));
  // Each hole's drop, read from the whole copy, which holds the floor below (openingView.ts).
  const drops = useTreeShownView((s) => (s.view ? holeDrops(s.view, props.scene.id) : ""));
  // The tokens a hole's pills keep off, so a pill wider than its hole does not hide a creature standing beside it.
  const spots = useTreeShownView((s) => tokenSpots(s.floorView, props.scene.id));
  const tokens = useMemo(() => spotsOf(spots), [spots]);
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
  const feet = useMemo(() => dropsById(drops), [drops]);
  const { scale } = props;
  // The pills a name and a chip keep off: the turn's marker, and the traps' names where trapNamePill puts them. Not the published names: in Isometric those were nudged off token text, which keeps off this layer's pills, so reading them would close a loop (trapNameMarkers).
  const turn = useStore(useScoped(boardPillsSlot), (s) => s.pills.turnStart ?? NO_PILLS);
  const traps = useTreeShownView((s) => s.floorView?.traps ?? NO_TRAPS);
  const chunks = useTreeShownView((s) => s.floorView?.buildChunks ?? NO_CHUNKS);
  // The traps' names keep off the ends' frames as the trap layers place them, and the ends' pills keep off the traps' squares, neither off the other's pills.
  const frames = useMemo(() => linkFrames(grid, props.scene.id, links), [grid, props.scene.id, links]);
  // Judged by where the screen's edge slides each pill at the camera's rest, read alike by both isometric stages, so a pan lays out nothing until it stops.
  const view = useRestView();
  const iso = useIsoGround();
  // The names as Top-down places them, in cells: the rest view is in view units in Isometric, where the markers' drawn boxes take it instead (placeEnds).
  const cellView = iso ? null : view;
  const trapNames = useMemo(() => trapNameMarkers(grid, props.scene.id, traps, chunks, scale, dm, frames, cellView), [grid, props.scene.id, traps, chunks, scale, dm, frames, cellView]);
  const squares = useMemo(() => trapSquares(grid, props.scene.id, traps), [grid, props.scene.id, traps]);
  const trapKey = JSON.stringify(trapNames);
  const markers = useMemo(() => (trapNames.length === 0 ? turn : [...turn, ...trapNames]), [turn, trapKey]);
  const shown = trapNameShown(scale);
  // Every end's pills are placed together, in order of id, so a hole's pills can keep off the other ends and the pills before them (placeEnds).
  const ends = useMemo(
    () =>
      list.map((link) => {
        const o = outlineOf(grid, link.rect);
        const dir = linkDir({ scenes }, link);
        const label = linkLabel({ scenes }, link);
        // A hole's name hangs under it, so its height chip can sit on the rim over it.
        const hole = link.kind === "opening" && dir === "down";
        const at = nameAnchor(o, hole ? "bottom" : "top");
        const marks = linkMarksLine({ hidden: link.hidden === true, notReached: far.has(link.id) });
        const named = label !== null && !hushed.has(link.id) && shown;
        const first: PillSpec | null = named
          ? { name: label, ...(marks !== null ? { value: marks } : {}), x: at.x, y: at.y, ...(hole ? { below: true } : { above: true }), size: "map", small: true, maxLines: 1, stack: true }
          : null;
        const top = nameAnchor(o, "top");
        const drop = feet.get(link.id) ?? null;
        const dropPill: PillSpec | null = hole && drop !== null && named ? { value: dropChip(drop), x: top.x, y: top.y, above: true, size: "map", small: true } : null;
        return { id: link.id, o, hole, dir, first, dropPill };
      }),
    [list, scenes, grid, far, hushed, feet, shown],
  );
  const placed = useMemo(() => placeEnds(ends, markers, scale, iso, (p) => iso !== null && pillStands(iso.fog, { ...p, scale }), tokens, { view, traps: squares }), [ends, markers, scale, iso, tokens, view, squares]);
  return (
    <Group listening={false}>
      {list.map((l, i) => {
        const end = ends[i]!;
        const got = placed.get(l.id);
        return <LinkMark key={l.id} link={l} o={end.o} dir={end.dir} hole={end.hole} pill={got?.pill ?? null} chip={got?.chip ?? null} scale={scale} />;
      })}
    </Group>
  );
});

/** The holes' drops by id, from openingView.ts holeDrops's "o1=10 o3=15". */
function dropsById(drops: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const pair of drops.split(" ")) {
    const [id, ft] = pair.split("=");
    if (id && ft) out.set(id, Number(ft));
  }
  return out;
}

/** An opening's dashed outline: the hole's rim in the accent, wider, and the lower end's thin. */
function OpeningRim(props: { o: Outline; hole: boolean; color: string }) {
  const { o, hole, color } = props;
  return (
    <Shape
      listening={false}
      perfectDrawEnabled={false}
      sceneFunc={(ctx: Konva.Context, shape: Konva.Shape) => {
        const px = 1 / (shape.getAbsoluteScale().x || 1);
        if (o.loop) trace(ctx, o.loop);
        else {
          ctx.beginPath();
          ctx.rect(o.x, o.y, o.w, o.h);
        }
        ctx.lineJoin = "round";
        ctx.setLineDash(hole ? [8 * px, 5 * px] : [5 * px, 4 * px]);
        ctx.lineWidth = (hole ? 5 : 3.5) * px;
        ctx.strokeStyle = boardTheme.color.textHalo;
        ctx.stroke();
        ctx.lineWidth = (hole ? 3 : 1.5) * px;
        ctx.strokeStyle = color;
        ctx.stroke();
        ctx.setLineDash([]);
      }}
    />
  );
}

/** A closed loop of points, x then y, as the path to clip or stroke. */
function trace(ctx: Konva.Context, loop: readonly number[]): void {
  ctx.beginPath();
  ctx.moveTo(loop[0]!, loop[1]!);
  for (let i = 2; i + 1 < loop.length; i += 2) ctx.lineTo(loop[i]!, loop[i + 1]!);
  ctx.closePath();
}

const LinkMark = memo(function LinkMark(props: { link: FloorLink; o: Outline; dir: "up" | "down" | null; hole: boolean; pill: PillSpec | null; chip: PillSpec | null; scale: number }) {
  const { link, scale, o, dir, hole, pill, chip } = props;
  const iso = useIsoGround();
  const standing = (p: PillSpec) => iso !== null && pillStands(iso.fog, { ...p, scale });
  // The end lies on the ground: Top-down's board, or the isometric ground stage.
  const flat = iso === null || iso.place === "ground";
  const pills = [pill, chip].filter((p): p is PillSpec => p !== null);
  const pillKey = JSON.stringify(pills);
  // Keyed on what the name and the chip say and where, so a pinch that keeps them shown publishes nothing new.
  usePublishPills(`floorLink:${link.id}`, useMemo(() => (pills.length > 0 ? pills : NO_PILLS), [pillKey]));
  const color = boardTheme.color.accentSoft;
  const locked = link.locked === true;
  const words = pill ? (pill.value ? `${pill.name} · ${pill.value}` : pill.name!) : "";
  // A hole's pill that cannot stand is not drawn at all: lying flat it runs under the dark of unexplored ground, cut off mid-word, and on a phone covers the hole.
  const stands = (p: PillSpec) => drawsHere(iso, iso ? pillStands(iso.fog, { ...p, scale }) : true) && (!hole || standing(p) || iso === null);
  return (
    <Group {...{ [FLOOR_LINK_ATTR]: link.id, "data-floor-link-name": words, ...(chip ? { "data-floor-link-chip": chip.value } : {}) }}>
      {flat ? <LinkShape o={o} kind={link.kind} dir={dir} locked={locked} color={color} scale={scale} /> : null}
      {pill && stands(pill) ? <MarkPill {...pill} scale={scale} color={color} /> : null}
      {chip && stands(chip) ? <MarkPill {...chip} scale={scale} color={color} /> : null}
    </Group>
  );
});

/**
 * An end's marks on the ground: its treads or rungs, the chevron of its way, its outline, and its lock on the bottom
 * right corner, clear of the name over the top edge. An opening's are its outline alone, dashed: the hole's in the
 * accent and wider, round the floor below that OpeningWindow.tsx draws inside it, and the lower end's thin.
 */
function LinkShape(props: { o: Outline; kind: FloorLink["kind"]; dir: "up" | "down" | null; locked: boolean; color: string; scale: number }) {
  const { o, kind, dir, locked, color } = props;
  if (kind === "opening") return <OpeningRim o={o} hole={dir === "down"} color={color} />;
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
