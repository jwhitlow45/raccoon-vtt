import type Konva from "konva";
import { memo, useMemo, type ReactNode } from "react";
import { Circle, Ellipse, Group, Line, Path, Rect, Shape } from "react-konva";
import { useStore } from "zustand";
import type { BuildChunk, CellRect, RoomSettings, Scene, Trap, TrapRig } from "#shared/model.ts";
import type { AreaTemplateInput } from "#shared/rules/aoe.ts";
import { usePublishPills, type PillSpec } from "../../canvas/boardView.ts";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { contextFrom } from "../areas/coverage.ts";
import { OutlineShape } from "../areas/draw.tsx";
import { areaOutline } from "../areas/placement.ts";
import { findDoor } from "../doors/doors.ts";
import type { LayerProps } from "../layers.ts";
import { Pill } from "../measure/Pill.tsx";
import { TRAP_ICON_BOX, TRAP_ICON_PATH } from "./icon.ts";
import { boxCenter, trapNameShown, zoneBox, type SeenTrap } from "./rules.ts";
import { trapSlot, type TrapDraft } from "./store.ts";
import { useTrapAlerts } from "./useTrapAlerts.ts";

const NO_TRAPS: Readonly<Record<string, Trap>> = {};
const NO_CHUNKS: Readonly<Record<string, BuildChunk>> = {};
const NO_TOKENS = {};

/** The badge's size on screen, in pixels: the wolf trap in a disc. */
const BADGE_PX = 20;
const ICON_PX = 13;
/** Hatching's spacing, in screen pixels. */
const HATCH_PX = 7;

/**
 * Traps on the board layer (docs/design-v1-traps.md 4.1 and 4.5), under the
 * fog as areas are, so a player's map never shows one through it.
 *
 * The DM sees every trap on the scene: squares hatched in the danger
 * color, a wire as a dashed line with a pin at each end, a door trap as a
 * badge on its door, each with the wolf trap and its name. Armed is
 * strong, sprung grey, disarmed a grey dashed outline, and an eye marks
 * one players found. While a trap's pane is open, what it hits draws
 * faintly. A player sees a found trap the same way in a neutral warning
 * color, "Disarmed" once the DM disarms it, and never whether it is armed.
 * With the Trap tool, the zone being drawn shows too. Nothing animates: it
 * redraws when a trap, the build or the zoom changes.
 */
export const TrapLayer = memo(function TrapLayer(props: LayerProps) {
  // Mounted with the board, which every room draws, as the falling reminder is (attach/TetherLayer.tsx).
  useTrapAlerts();
  const traps = useRoomView((s) => s.view?.traps ?? NO_TRAPS);
  const chunks = useRoomView((s) => s.view?.buildChunks ?? NO_CHUNKS);
  const settings = useRoomView((s) => s.view?.meta.settings);
  const tool = useRoomView((s) => s.local.tool);
  const store = useScoped(trapSlot).store;
  const draft = useStore(store, (s) => s.draft);
  const paneId = useStore(store, (s) => s.paneId);
  const dm = props.role === "dm";
  const list = useMemo(
    () =>
      Object.values(traps)
        .filter((t) => t.sceneId === props.scene.id)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    [traps, props.scene.id],
  );
  const open = dm && tool === "trap" && paneId ? traps[paneId] : undefined;
  return (
    <Group listening={false}>
      {list.map((t) => (
        <TrapMark key={t.id} trap={t} chunks={chunks} scale={props.scale} dm={dm} />
      ))}
      {open?.rig && settings ? <TrapHits trap={open} rig={open.rig} chunks={chunks} scene={props.scene} settings={settings} /> : null}
      {dm && draft ? <Draft draft={draft} scale={props.scale} /> : null}
    </Group>
  );
});

type Look = { color: string; fill: number; hatch: number; dash: number[] | undefined; width: number };

/** How a trap reads (4.1, 4.5): by its state for the DM, and for players only found and whether it is disarmed. */
function lookOf(trap: SeenTrap, dm: boolean): Look {
  if (dm) {
    if (trap.state === "armed") return { color: theme.color.danger, fill: 0.2, hatch: 0.7, dash: undefined, width: 2 };
    if (trap.state === "sprung") return { color: theme.color.neutral, fill: 0.12, hatch: 0.4, dash: undefined, width: 1.5 };
    return { color: theme.color.neutral, fill: 0, hatch: 0, dash: [6, 4], width: 1.5 };
  }
  if (trap.disarmed) return { color: theme.color.neutral, fill: 0, hatch: 0, dash: [6, 4], width: 1.5 };
  return { color: theme.color.warning, fill: 0.15, hatch: 0.6, dash: undefined, width: 1.5 };
}

/**
 * A trap's name as the board draws it, minus the zoom, or null where it
 * shows none. Squares name the trap over their top edge, as an area does,
 * clear of the name a creature standing in it shows below itself. A wire
 * or a door names it under its badge. Published to the board's label pass
 * (canvas/boardView.ts) as drawn, so token labels keep off it.
 */
export function trapNamePill(trap: Trap, chunks: Readonly<Record<string, BuildChunk>>, scale: number, dm: boolean): PillSpec | null {
  if (!trapNameShown(scale)) return null;
  const zone = trap.zone;
  const words = !dm && (trap as SeenTrap).disarmed ? "Disarmed" : undefined;
  const pill = { name: trap.name, value: words, size: "map" as const, small: true, maxLines: 1 as const };
  if ("cells" in zone) {
    const top = zone.cells.reduce((a, r) => (r.y < a.y || (r.y === a.y && r.x < a.x) ? r : a));
    return { ...pill, x: top.x + top.w / 2, y: top.y, above: true };
  }
  const badge = "wire" in zone ? { x: (zone.wire.a[0] + zone.wire.b[0]) / 2, y: (zone.wire.a[1] + zone.wire.b[1]) / 2 } : findDoor(chunks, trap.sceneId, zone.door)?.mid;
  return badge ? { ...pill, x: badge.x, y: badge.y, offsetPx: BADGE_PX / 2 + 2, below: true } : null;
}

const NO_PILLS: readonly PillSpec[] = [];

const TrapMark = memo(function TrapMark(props: { trap: Trap; chunks: Readonly<Record<string, BuildChunk>>; scale: number; dm: boolean }) {
  const { trap, scale, dm } = props;
  const seen = trap as SeenTrap;
  const look = lookOf(seen, dm);
  const zone = trap.zone;
  const s = 1 / scale;
  const name = trapNamePill(trap, props.chunks, scale, dm);
  const nameKey = name ? JSON.stringify(name) : "";
  // Keyed on what the name says and where, so a pinch that keeps it shown publishes nothing new.
  usePublishPills(`trap:${trap.id}`, useMemo(() => (name ? [name] : NO_PILLS), [nameKey]));
  let badge: { x: number; y: number } | null = null;
  let body: ReactNode = null;
  if ("cells" in zone) {
    const box = zoneBox(trap, props.chunks)!;
    badge = { x: box.x0 + (BADGE_PX / 2 + 2) * s, y: box.y0 + (BADGE_PX / 2 + 2) * s };
    body = <Squares rects={zone.cells} look={look} />;
  } else if ("wire" in zone) {
    const { a, b } = zone.wire;
    badge = { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
    body = (
      <>
        <Line points={[a[0], a[1], b[0], b[1]]} stroke={theme.color.textHalo} opacity={0.5} strokeWidth={look.width + 3} strokeScaleEnabled={false} lineCap="round" />
        <Line points={[a[0], a[1], b[0], b[1]]} stroke={look.color} strokeWidth={look.width + 1} strokeScaleEnabled={false} dash={[8, 5]} lineCap="round" />
        <Circle x={a[0]} y={a[1]} radius={4 * s} fill={look.color} stroke={theme.color.textHalo} strokeWidth={1} strokeScaleEnabled={false} />
        <Circle x={b[0]} y={b[1]} radius={4 * s} fill={look.color} stroke={theme.color.textHalo} strokeWidth={1} strokeScaleEnabled={false} />
      </>
    );
  } else {
    const door = findDoor(props.chunks, trap.sceneId, zone.door);
    if (door) badge = door.mid;
  }
  if (!badge) return null;
  return (
    <Group opacity={dm && trap.state === "sprung" ? 0.8 : 1}>
      {body}
      <Badge x={badge.x} y={badge.y} scale={scale} look={look} found={dm && trap.found} />
      {name ? <Pill {...name} scale={scale} color={look.color} /> : null}
    </Group>
  );
});

/** A zone's squares: one shape for every rectangle, hatched at a fixed spacing on screen, and outlined. */
function Squares(props: { rects: readonly CellRect[]; look: Look; faint?: boolean }) {
  const { rects, look } = props;
  return (
    <>
      {look.fill > 0 || look.hatch > 0 ? (
        <Shape
          listening={false}
          perfectDrawEnabled={false}
          sceneFunc={(ctx: Konva.Context, shape: Konva.Shape) => {
            const px = 1 / (shape.getAbsoluteScale().x || 1);
            const alpha = shape.getAbsoluteOpacity();
            for (const r of rects) {
              ctx.save();
              ctx.beginPath();
              ctx.rect(r.x, r.y, r.w, r.h);
              ctx.clip();
              if (look.fill > 0) {
                ctx.globalAlpha = look.fill * alpha;
                ctx.fillStyle = look.color;
                ctx.fillRect(r.x, r.y, r.w, r.h);
              }
              if (look.hatch > 0) {
                // Diagonal lines a fixed distance apart on screen, so the hatching reads at any zoom.
                ctx.globalAlpha = look.hatch * alpha;
                ctx.strokeStyle = look.color;
                ctx.lineWidth = 1.5 * px;
                const step = HATCH_PX * px;
                ctx.beginPath();
                for (let d = -r.h; d < r.w; d += step) {
                  ctx.moveTo(r.x + d, r.y + r.h);
                  ctx.lineTo(r.x + d + r.h, r.y);
                }
                ctx.stroke();
              }
              ctx.restore();
            }
          }}
        />
      ) : null}
      {rects.map((r, i) => (
        <Rect key={i} x={r.x} y={r.y} width={r.w} height={r.h} stroke={look.color} strokeWidth={look.width} strokeScaleEnabled={false} dash={look.dash} listening={false} perfectDrawEnabled={false} opacity={props.faint ? 0.6 : 1} />
      ))}
    </>
  );
}

/** The wolf trap in a disc, of one size on screen, with an eye beside it once players found the trap. */
function Badge(props: { x: number; y: number; scale: number; look: Look; found: boolean }) {
  const s = 1 / props.scale;
  const r = (BADGE_PX / 2) * s;
  const k = (ICON_PX * s) / TRAP_ICON_BOX;
  const eye = { x: props.x + r * 1.15, y: props.y - r * 0.85 };
  return (
    <>
      <Circle x={props.x} y={props.y} radius={r} fill={theme.color.overlay} stroke={props.look.color} strokeWidth={1.5} strokeScaleEnabled={false} dash={props.look.dash} />
      <Path data={TRAP_ICON_PATH} x={props.x - (ICON_PX / 2) * s} y={props.y - (ICON_PX / 2) * s} scaleX={k} scaleY={k} fill={props.look.color} />
      {props.found ? (
        <>
          <Circle x={eye.x} y={eye.y} radius={r * 0.6} fill={theme.color.overlay} />
          <Ellipse x={eye.x} y={eye.y} radiusX={r * 0.45} radiusY={r * 0.28} stroke={theme.color.text} strokeWidth={1.2} strokeScaleEnabled={false} />
          <Circle x={eye.x} y={eye.y} radius={r * 0.14} fill={theme.color.text} />
        </>
      ) : null}
    </>
  );
}

/** What the open trap hits, drawn faintly (4.1): its drawn squares, or its area. Its own squares and the creature that set it off need nothing more. */
function TrapHits(props: { trap: Trap; rig: TrapRig; chunks: Readonly<Record<string, BuildChunk>>; scene: Scene; settings: RoomSettings }) {
  const { rig } = props;
  const outline = useMemo(() => {
    if (typeof rig.hits !== "object" || !("area" in rig.hits)) return null;
    const ctx = contextFrom({ tokens: NO_TOKENS, buildChunks: props.chunks, settings: props.settings }, props.scene);
    return areaOutline({ ...rig.hits.area, sceneId: props.scene.id } as unknown as AreaTemplateInput, ctx);
  }, [rig.hits, props.chunks, props.settings, props.scene]);
  if (typeof rig.hits !== "object") return null;
  if ("cells" in rig.hits) return <Squares rects={rig.hits.cells} look={{ color: theme.color.danger, fill: 0.1, hatch: 0, dash: [4, 4], width: 1 }} faint />;
  if (!outline) return null;
  const box = zoneBox(props.trap, props.chunks);
  const from = box ? boxCenter(box) : null;
  const o = rig.hits.area.origin;
  return (
    <>
      <OutlineShape outline={outline} color={theme.color.danger} widthPx={1.5} dash={[6, 4]} opacity={0.8} fill={theme.color.dangerTint} />
      {from ? <Line points={[from.x, from.y, o.x, o.y]} stroke={theme.color.danger} strokeWidth={1} strokeScaleEnabled={false} dash={[2, 4]} opacity={0.6} listening={false} /> : null}
    </>
  );
}

/** The zone being drawn with the Trap tool. */
function Draft(props: { draft: TrapDraft; scale: number }) {
  const { draft } = props;
  const s = 1 / props.scale;
  if ("rect" in draft) {
    const r = draft.rect;
    return <Rect x={r.x} y={r.y} width={r.w} height={r.h} fill={theme.color.danger} opacity={0.25} stroke={theme.color.danger} strokeWidth={2} strokeScaleEnabled={false} dash={[6, 4]} listening={false} />;
  }
  const { a, b } = draft.wire;
  return (
    <>
      <Line points={[a[0], a[1], b[0], b[1]]} stroke={theme.color.danger} strokeWidth={3} strokeScaleEnabled={false} dash={[8, 5]} lineCap="round" listening={false} />
      <Circle x={a[0]} y={a[1]} radius={5 * s} fill={theme.color.danger} listening={false} />
      <Circle x={b[0]} y={b[1]} radius={5 * s} fill={theme.color.danger} listening={false} />
    </>
  );
}
