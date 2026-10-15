import type { AreaFootprint, AreaShape, AreaTemplate, AreaTrigger, BuildChunk } from "#shared/model.ts";
import type { EphEvent, TemplateInput, TemplatePatch } from "#shared/protocol.ts";
import {
  AREA_MAX_FT,
  AREA_MIN_FT,
  canPitch,
  castFromToken,
  DEFAULT_CYLINDER_HEIGHT_FT,
  DEFAULT_LINE_WIDTH_FT,
  defaultIncludeOrigin,
  edgeOrigin,
  emanationFootprint,
  MAX_PITCH,
  pitchOf,
  resolveArea,
  type AreaContext,
  type AreaTemplateInput,
  type AreaToken,
} from "#shared/rules/aoe.ts";
import { footprintRect, tokenHeightFt } from "#shared/rules/footprint.ts";
import { clamp, yawVector, type Point, type Rect } from "#shared/rules/geom.ts";
import { rangeGround } from "#shared/rules/heights.ts";

/**
 * Placing and aiming areas of effect (design section 9.3), as pure functions
 * over plain data so they are tested under plain Node.
 *
 * The area tool edits an `AreaDraft`: what the person chose (shape, size,
 * the token it comes from, a point on the map, the aim). `draftTemplate`
 * turns it into the template the rules engine reads, which is the same
 * template `template.create` stores, so the preview being aimed and the
 * placed area always catch the same creatures.
 *
 * Template origins carry z as whole feet (the op schema says so), so every
 * origin taken from a token is rounded here, once, and the preview uses the
 * rounded value too.
 */

export type Point3 = { x: number; y: number; z: number };
export type SnapMode = "15" | "45" | "free";
export type AreaTokens = Readonly<Record<string, AreaToken | undefined>>;

export type AreaDraft = {
  id: string;
  shape: AreaShape;
  /** Feet: radius, length, side or distance. */
  size: number;
  /** Feet. Lines only. */
  width: number;
  /** Feet. Cylinders only. */
  height: number;
  /** Cylinders only: whether the point is the center of the bottom or the top circle. */
  anchor: "bottom" | "top";
  yaw: number;
  /** Cones and lines only: degrees above level, negative to aim down (AreaTemplate.pitch). */
  pitch: number;
  /**
   * Cubes only: where the origin sits across the face, as faceOffset.u.
   * 0.5 puts it on the right-hand edge, so the cube reaches to the left.
   */
  faceU: number;
  /** Where a freely placed area starts, in cells with z in feet. Null until the first tap. */
  point: Point3 | null;
  /** The token a cone, line or cube is cast from, or the token an emanation surrounds. */
  fromId?: string;
  /** The caster, recorded on the template. Cones, lines and cubes use `fromId` instead. */
  casterId?: string;
  /** An emanation around a token moves with it. */
  attached: boolean;
  /**
   * A free emanation's footprint, kept from the stationary emanation it was
   * copied from, so the copy surrounds the same square as the original
   * rather than a point.
   */
  footprint?: AreaFootprint;
  includeOrigin: boolean;
  /**
   * The emanation surrounds a target rather than the caster, and catches
   * it too (Ice Knife). Tapping a token picks the target and leaves the
   * caster alone.
   */
  targetsOther: boolean;
  /** What `targetsOther` names when its spell names it, such as "pack", for the tool's hints. */
  targetName?: string;
  color: string;
  spell?: string;
  /** How the spell's area differs from a plain template, shown while placing. */
  note?: string;
  /** The spell's range in feet, shown against the distance from the caster. */
  rangeFt?: number;
  visibility: "all" | "dm";
  /** When the log reminds the table the area hits a creature again (AreaTemplate.triggers). */
  triggers: AreaTrigger[];
  /** Whether it hits a creature only once a turn, whichever trigger comes first (AreaTemplate.oncePerTurn). */
  oncePerTurn: boolean;
};

/** Every trigger, in the order the options list them and a template stores them. */
export const AREA_TRIGGERS: readonly AreaTrigger[] = ["enter", "turnStart", "turnEnd"];

/** The triggers listed once each, in their usual order. */
export function normalizeTriggers(list: readonly AreaTrigger[] | undefined): AreaTrigger[] {
  return AREA_TRIGGERS.filter((t) => list?.includes(t));
}

/** "Reminds when a creature enters or ends its turn there.", or null for an area with no reminders. */
export function triggerSummary(list: readonly AreaTrigger[] | undefined): string | null {
  const words = normalizeTriggers(list).map((t) => (t === "enter" ? "enters" : t === "turnStart" ? "starts its turn" : "ends its turn"));
  if (words.length === 0) return null;
  const joined = words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
  return `Reminds when a creature ${joined}${words.length === 1 && words[0] === "enters" ? " it" : " there"}.`;
}

/** Shapes that start from a token's edge or footprint. Spheres and cylinders start at a point. */
export function usesFrom(shape: AreaShape): boolean {
  return shape !== "sphere" && shape !== "cylinder";
}

export function isDirectional(shape: AreaShape): boolean {
  return shape === "cone" || shape === "line" || shape === "cube";
}

/**
 * The grips drawn on the area being aimed or picked: the dot at its origin,
 * where a press moves it, and for a cone, line or cube the handle that
 * turns it. A placed area the viewer may not change gets neither: a
 * player who picks another's cone must see nothing that offers to turn
 * it. Its outline, shading and the creatures it catches still show, and
 * it can still be copied.
 */
export function areaGrips(shape: AreaShape, editable: boolean): { origin: boolean; handle: boolean } {
  return { origin: editable, handle: editable && isDirectional(shape) };
}

export function clampFeet(ft: number): number {
  return clamp(Number.isFinite(ft) ? Math.round(ft) : AREA_MIN_FT, AREA_MIN_FT, AREA_MAX_FT);
}

export function newDraft(id: string, shape: AreaShape, color: string): AreaDraft {
  return {
    id,
    shape,
    size: shape === "cone" || shape === "cube" ? 15 : shape === "line" ? 30 : shape === "emanation" ? 10 : 20,
    width: DEFAULT_LINE_WIDTH_FT,
    height: DEFAULT_CYLINDER_HEIGHT_FT,
    anchor: "bottom",
    yaw: 0,
    pitch: 0,
    faceU: 0,
    point: null,
    attached: shape === "emanation",
    includeOrigin: defaultIncludeOrigin(shape),
    targetsOther: false,
    color,
    visibility: "all",
    triggers: [],
    oncePerTurn: false,
  };
}

/** A shape change keeps the placement and the aim, and resets what only made sense for the old shape. */
export function withShape(d: AreaDraft, shape: AreaShape): AreaDraft {
  if (d.shape === shape) return d;
  const fresh = newDraft(d.id, shape, d.color);
  return {
    ...fresh,
    point: d.point,
    fromId: usesFrom(shape) ? (d.fromId ?? d.casterId) : undefined,
    casterId: d.casterId ?? d.fromId,
    yaw: d.yaw,
    pitch: canPitch(shape) ? d.pitch : 0,
    visibility: d.visibility,
    triggers: d.triggers,
    oncePerTurn: d.oncePerTurn,
  };
}

// ------------------------------------------------------------ angles

export function normalizeYaw(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  // One remainder, so a value already in range comes back unchanged to the last bit.
  const r = deg % 360;
  const n = r < 0 ? r + 360 : r;
  // 359.99999 rounds to 360, which the schema allows but reads oddly.
  return n >= 359.9995 ? 0 : n;
}

/** Rotation snapping: to 15 degrees, to 45 degrees, or free (to a tenth of a degree). */
export function snapYaw(deg: number, mode: SnapMode): number {
  if (mode === "free") return normalizeYaw(Math.round(deg * 10) / 10);
  const step = mode === "45" ? 45 : 15;
  return normalizeYaw(Math.round(deg / step) * step);
}

/** An aim up or down, kept to whole degrees between straight down and straight up. */
export function clampPitch(deg: number): number {
  return Number.isFinite(deg) ? clamp(Math.round(deg), -MAX_PITCH, MAX_PITCH) : 0;
}

/** "Level", "30° up" or "15° down". */
export function aimText(pitch: number): string {
  if (pitch === 0) return "Level";
  return pitch > 0 ? `${pitch}° up` : `${-pitch}° down`;
}

/** Degrees clockwise from east from one point toward another, or null when they coincide. */
export function yawToward(from: Point, to: Point): number | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.hypot(dx, dy) < 1e-6) return null;
  return normalizeYaw((Math.atan2(dy, dx) * 180) / Math.PI);
}

// ------------------------------------------------------------ snapping points

/**
 * A free point snaps to the nearest grid intersection or cell center, the
 * two places a sphere or cone is usually centered on.
 */
export function snapPoint(p: Point): Point {
  const corner = { x: Math.round(p.x), y: Math.round(p.y) };
  const center = { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 };
  return Math.hypot(p.x - corner.x, p.y - corner.y) <= Math.hypot(p.x - center.x, p.y - center.y) ? corner : center;
}

/**
 * The center of a free emanation that surrounds a footprint, snapped so the
 * footprint lines up with the grid the way the token it came from did: an
 * even number of cells across centers on a grid line, an odd number on a
 * cell's middle. A footprint of part of a cell (a Tiny token) snaps like a
 * plain point.
 */
export function snapFootprintCenter(p: Point, fp: Pick<AreaFootprint, "w" | "h">): Point {
  const axis = (v: number, cells: number, plain: number) => {
    if (!Number.isInteger(cells) || cells < 1) return plain;
    return cells % 2 === 0 ? Math.round(v) : Math.floor(v) + 0.5;
  };
  const plain = snapPoint(p);
  return { x: axis(p.x, fp.w, plain.x), y: axis(p.y, fp.h, plain.y) };
}

/**
 * The center of a freely placed cube, snapped so its square lines up with
 * the grid: an even number of cells across centers on an intersection, an
 * odd number on a cell center.
 */
export function snapCubeCenter(p: Point, sizeFt: number, feetPerCell: number): Point {
  const cells = sizeFt / feetPerCell;
  if (!Number.isInteger(cells)) return snapPoint(p);
  if (cells % 2 === 0) return { x: Math.round(p.x), y: Math.round(p.y) };
  return { x: Math.floor(p.x) + 0.5, y: Math.floor(p.y) + 0.5 };
}

// ------------------------------------------------------------ origins

/**
 * A cube's origin on a face, given the point on the face's bottom edge line
 * and the elevation of the cube's bottom. The origin sits at the face's
 * middle height, rounded to a whole foot, and `v` says exactly where that is
 * on the face, so the cube's bottom stays at `bottomFt`. Keeping the origin
 * inside the cube's height, rather than on its bottom face, keeps the
 * shading slice clear of the cube's surface.
 */
export function cubeOrigin(face: Point, bottomFt: number, sizeFt: number, u: number): { origin: Point3; faceOffset: { u: number; v: number } } {
  const z = Math.round(bottomFt + sizeFt / 2);
  const v = clamp((z - bottomFt) / sizeFt - 0.5, -0.5, 0.5);
  return { origin: { x: face.x, y: face.y, z }, faceOffset: { u: clamp(u, -0.5, 0.5), v } };
}

/**
 * Where an area cast from a token starts (design 9.3): cones and lines on
 * the caster's edge at its middle height, a cube's face on the caster's edge
 * with the cube's bottom at the caster's elevation, and an emanation around
 * the caster's footprint.
 */
export function originFromToken(
  d: Pick<AreaDraft, "shape" | "size" | "yaw" | "anchor" | "faceU">,
  token: AreaToken,
  feetPerCell: number,
): { origin: Point3; faceOffset?: { u: number; v: number } } {
  const size = clampFeet(d.size);
  if (d.shape === "cube") return cubeOrigin(edgeOrigin(footprintRect(token), d.yaw), token.elevation, size, d.faceU);
  const o = castFromToken({ shape: d.shape, size, yaw: d.yaw, anchor: d.anchor }, token, feetPerCell).origin;
  return { origin: { x: o.x, y: o.y, z: Math.round(o.z) } };
}

/** The origin of a freely placed area. A cube's point is its center on the ground. */
export function freeOrigin(
  d: Pick<AreaDraft, "shape" | "size" | "yaw">,
  point: Point3,
  feetPerCell: number,
): { origin: Point3; faceOffset?: { u: number; v: number } } {
  if (d.shape === "cube") {
    const half = clampFeet(d.size) / feetPerCell / 2;
    const dir = yawVector(d.yaw);
    return cubeOrigin({ x: point.x - dir.x * half, y: point.y - dir.y * half }, point.z, clampFeet(d.size), 0);
  }
  return { origin: { x: point.x, y: point.y, z: Math.round(point.z) } };
}

// ------------------------------------------------------------ the draft as a template

/** The template a draft stands for, in the fields the rules read and `template.create` stores. */
export type DraftTemplate = AreaTemplateInput & {
  origin: Point3;
  triggers?: AreaTrigger[];
  oncePerTurn?: true;
  width?: number;
  height?: number;
  anchor?: "bottom" | "top";
  faceOffset?: { u: number; v: number };
  attachedTo?: string;
  casterId?: string;
};

/**
 * The template a draft stands for, or null while it has nowhere to be:
 * no token picked and no point tapped. A token the view no longer holds
 * counts as not picked.
 */
export function draftTemplate(d: AreaDraft, tokens: AreaTokens, feetPerCell: number): DraftTemplate | null {
  const base: DraftTemplate = {
    id: d.id,
    rev: 0,
    shape: d.shape,
    size: clampFeet(d.size),
    origin: { x: 0, y: 0, z: 0 },
    yaw: normalizeYaw(d.yaw),
    includeOrigin: d.includeOrigin,
  };
  if (d.shape === "line") base.width = clampFeet(d.width);
  if (normalizeTriggers(d.triggers).length > 0) {
    base.triggers = normalizeTriggers(d.triggers);
    if (d.oncePerTurn) base.oncePerTurn = true;
  }
  if (canPitch(d.shape) && clampPitch(d.pitch) !== 0) base.pitch = clampPitch(d.pitch);
  if (d.shape === "cylinder") {
    base.height = clampFeet(d.height);
    base.anchor = d.anchor;
  }
  const from = d.fromId && usesFrom(d.shape) ? tokens[d.fromId] : undefined;
  if (from) {
    const placed = originFromToken(d, from, feetPerCell);
    base.origin = placed.origin;
    if (placed.faceOffset) base.faceOffset = placed.faceOffset;
    if (d.shape === "emanation" && d.attached) {
      base.attachedTo = from.id;
      const caster = d.targetsOther ? d.casterId : from.id;
      if (caster) base.casterId = caster;
    } else {
      // A cone, line or cube leaves its caster out through casterId. An
      // emanation that stays put also keeps the footprint it was cast from,
      // so it holds its shape once the caster walks away.
      base.casterId = from.id;
      if (d.shape === "emanation") base.footprint = emanationFootprint(from, feetPerCell);
    }
    return base;
  }
  if (!d.point) return null;
  const placed = freeOrigin(d, d.point, feetPerCell);
  base.origin = placed.origin;
  if (placed.faceOffset) base.faceOffset = placed.faceOffset;
  if (d.casterId && tokens[d.casterId]) base.casterId = d.casterId;
  if (d.shape === "emanation" && d.footprint) base.footprint = d.footprint;
  return base;
}

/** The `template.create` payload for a placed draft. Optional fields are left out rather than sent empty. */
export function templateInput(
  t: DraftTemplate,
  extra: { sceneId: string; ownerId: string; color: string; spell?: string; label?: string; visibility: "all" | "dm" },
): TemplateInput {
  const input: TemplateInput = {
    id: t.id,
    sceneId: extra.sceneId,
    shape: t.shape,
    size: t.size,
    origin: { x: t.origin.x, y: t.origin.y, z: Math.round(t.origin.z) },
    yaw: normalizeYaw(t.yaw),
    includeOrigin: t.includeOrigin,
    color: extra.color,
    ownerId: extra.ownerId,
    visibility: extra.visibility,
  };
  if (t.width !== undefined) input.width = t.width;
  if (t.height !== undefined) input.height = t.height;
  if (pitchOf(t) !== 0) input.pitch = pitchOf(t);
  if (t.anchor !== undefined) input.anchor = t.anchor;
  if (t.faceOffset !== undefined) input.faceOffset = t.faceOffset;
  if (t.attachedTo !== undefined) input.attachedTo = t.attachedTo;
  if (t.footprint !== undefined) input.footprint = t.footprint;
  if (t.triggers !== undefined && t.triggers.length > 0) {
    input.triggers = normalizeTriggers(t.triggers);
    if (t.oncePerTurn) input.oncePerTurn = true;
  }
  if (t.casterId !== undefined) input.casterId = t.casterId;
  if (extra.spell) input.spell = extra.spell.slice(0, 80);
  if (extra.label) input.label = extra.label.slice(0, 80);
  return input;
}

/**
 * A shared preview frame (design 7.6). It carries geometry only: shape,
 * origin, aim and size. Who cast it and whom it catches stay on the device.
 */
export function aoeFrame(t: DraftTemplate): Extract<EphEvent, { k: "aoe" }> {
  const e: Extract<EphEvent, { k: "aoe" }> = {
    k: "aoe",
    id: t.id,
    shape: t.shape,
    origin: { x: t.origin.x, y: t.origin.y, z: Math.round(t.origin.z) },
    yaw: normalizeYaw(t.yaw),
    size: t.size,
    shared: true,
  };
  if (pitchOf(t) !== 0) e.pitch = pitchOf(t);
  if (t.width !== undefined) e.width = t.width;
  if (t.height !== undefined) e.height = t.height;
  return e;
}

/** A remote preview frame as a template the rules can shade. */
export function frameTemplate(e: Omit<Extract<EphEvent, { k: "aoe" }>, "k" | "shared">): AreaTemplateInput {
  const t: AreaTemplateInput = {
    id: e.id,
    rev: 0,
    shape: e.shape,
    size: e.size,
    origin: e.origin,
    yaw: e.yaw,
    includeOrigin: defaultIncludeOrigin(e.shape),
  };
  if (e.pitch !== undefined) t.pitch = e.pitch;
  if (e.width !== undefined) t.width = e.width;
  if (e.height !== undefined) t.height = e.height;
  return t;
}

/**
 * The point a free draft would need to give back this template's origin: a
 * cube's center on its bottom, any other shape's origin.
 */
export function freePointOf(
  t: Pick<AreaTemplate, "shape" | "size" | "origin" | "yaw" | "faceOffset">,
  feetPerCell: number,
): Point3 {
  if (t.shape !== "cube") return { ...t.origin };
  return { ...cubeCenter(t, feetPerCell), z: Math.round(t.origin.z - (0.5 + (t.faceOffset?.v ?? 0)) * t.size) };
}

/** A placed template as a draft, to place a copy of it (Fire Storm's ten cubes, Meteor Swarm's four spheres). */
export function draftFromTemplate(t: AreaTemplate, id: string, tokens: AreaTokens, feetPerCell: number): AreaDraft {
  const d = newDraft(id, t.shape, t.color);
  d.size = t.size;
  if (t.width !== undefined) d.width = t.width;
  if (t.height !== undefined) d.height = t.height;
  d.anchor = t.anchor ?? "bottom";
  d.yaw = t.yaw;
  d.pitch = pitchOf(t);
  d.faceU = t.faceOffset?.u ?? 0;
  d.includeOrigin = t.includeOrigin;
  d.visibility = t.visibility;
  d.triggers = normalizeTriggers(t.triggers);
  d.oncePerTurn = t.oncePerTurn === true;
  if (t.spell) d.spell = t.spell;
  const caster = t.casterId ?? undefined;
  if (t.attachedTo && tokens[t.attachedTo]) {
    d.fromId = t.attachedTo;
    d.attached = true;
    if (caster && caster !== t.attachedTo) {
      d.casterId = caster;
      d.targetsOther = true;
    }
    return d;
  }
  d.attached = false;
  const pivot = templatePivot(t, tokens, feetPerCell);
  if (usesFrom(t.shape) && pivot.onCaster && caster) {
    d.fromId = caster;
    d.casterId = caster;
    return d;
  }
  // An emanation that stays put around its caster copies as one cast from
  // that caster again, footprint and all. One with a stored footprint is
  // left where it was cast, and copies from there: a caster that moved but
  // still covers the old origin would otherwise drag the copy along.
  const from = caster ? tokens[caster] : undefined;
  if (t.shape === "emanation" && !t.footprint && from && insideRect(footprintRect(from), t.origin)) {
    d.fromId = caster;
    d.casterId = caster;
    return d;
  }
  if (caster) d.casterId = caster;
  d.point = freePointOf(t, feetPerCell);
  if (t.shape === "emanation" && t.footprint) d.footprint = { ...t.footprint };
  return d;
}

// ------------------------------------------------------------ editing placed templates

/**
 * The point a template turns around, and whether its origin sits on its
 * caster's footprint (a cone cast from a token keeps starting at the
 * caster's edge as it turns). A free cube turns around its center.
 */
export function templatePivot(
  t: Pick<AreaTemplate, "shape" | "size" | "origin" | "yaw" | "faceOffset" | "casterId">,
  tokens: AreaTokens,
  feetPerCell: number,
): { point: Point; onCaster: boolean } {
  const caster = t.casterId ? tokens[t.casterId] : undefined;
  if (caster && isDirectional(t.shape) && onRectEdge(footprintRect(caster), t.origin)) {
    const r = footprintRect(caster);
    return { point: { x: r.x + r.w / 2, y: r.y + r.h / 2 }, onCaster: true };
  }
  if (t.shape === "cube") return { point: cubeCenter(t, feetPerCell), onCaster: false };
  return { point: { x: t.origin.x, y: t.origin.y }, onCaster: false };
}

function insideRect(r: Rect, p: Point): boolean {
  const E = 1e-6;
  return p.x >= r.x - E && p.x <= r.x + r.w + E && p.y >= r.y - E && p.y <= r.y + r.h + E;
}

function onRectEdge(r: Rect, p: Point): boolean {
  const E = 1e-6;
  const inside = insideRect(r, p);
  const onEdge =
    Math.abs(p.x - r.x) < E || Math.abs(p.x - (r.x + r.w)) < E || Math.abs(p.y - r.y) < E || Math.abs(p.y - (r.y + r.h)) < E;
  return inside && onEdge;
}

/** The 2D center of a cube template, from its face origin and offset. */
export function cubeCenter(t: Pick<AreaTemplate, "size" | "origin" | "yaw" | "faceOffset">, feetPerCell: number): Point {
  const s = t.size / feetPerCell;
  const d = yawVector(t.yaw);
  const u = t.faceOffset?.u ?? 0;
  // As in shared/rules/aoe.ts: the face's center is u sides counterclockwise of the origin.
  const fx = t.origin.x + d.y * u * s;
  const fy = t.origin.y - d.x * u * s;
  return { x: fx + (d.x * s) / 2, y: fy + (d.y * s) / 2 };
}

/**
 * The patch that turns a placed template to `yaw`. A cone, line or cube
 * that starts on its caster's edge moves its origin along that edge, so it
 * keeps starting at the caster. A free cube turns around its center.
 */
export function rotatePatch(t: AreaTemplate, yaw: number, tokens: AreaTokens, feetPerCell: number): TemplatePatch {
  const next = normalizeYaw(yaw);
  const pivot = templatePivot(t, tokens, feetPerCell);
  const caster = t.casterId ? tokens[t.casterId] : undefined;
  if (pivot.onCaster && caster) {
    const e = edgeOrigin(footprintRect(caster), next);
    return { yaw: next, origin: { x: e.x, y: e.y, z: t.origin.z } };
  }
  if (t.shape === "cube") {
    const half = t.size / feetPerCell / 2;
    const d = yawVector(next);
    const u = t.faceOffset?.u ?? 0;
    // Back from the center to the face, then u sides clockwise along it.
    const fx = pivot.point.x - d.x * half;
    const fy = pivot.point.y - d.y * half;
    const s = t.size / feetPerCell;
    return { yaw: next, origin: { x: fx - d.y * u * s, y: fy + d.x * u * s, z: t.origin.z } };
  }
  return { yaw: next };
}

/** The patch that moves a placed template by whole cells, so it keeps its place on the grid. */
export function movePatch(t: Pick<AreaTemplate, "origin">, dx: number, dy: number): TemplatePatch {
  return { origin: { x: t.origin.x + Math.round(dx), y: t.origin.y + Math.round(dy), z: t.origin.z } };
}

// ------------------------------------------------------------ drawing

export type Outline =
  | { kind: "circle"; x: number; y: number; r: number }
  | { kind: "poly"; points: number[] }
  | { kind: "roundRect"; x: number; y: number; w: number; h: number; r: number };

/** Where a template's origin really is: an attached one starts from its token wherever it stands now. */
export function liveOrigin(t: AreaTemplateInput, ctx: AreaContext): Point3 {
  const attached = t.attachedTo ? ctx.tokens?.[t.attachedTo] : undefined;
  if (!attached) return t.origin;
  return castFromToken({ shape: t.shape, size: t.size, yaw: t.yaw, anchor: t.anchor }, attached, ctx.settings.feetPerCell).origin;
}

/**
 * The outline of the slice that shading uses: a circle for spheres and
 * cylinders, a triangle for a cone (its slice through the axis), a square
 * or a rectangle for cubes and lines, and the footprint grown by the
 * distance with round corners for an emanation around a token. A cone or
 * line aimed up or down shades what it covers seen from above, and its
 * outline is that too.
 */
export function areaOutline(t: AreaTemplateInput, ctx: AreaContext): Outline | null {
  const fpc = ctx.settings.feetPerCell;
  const o = liveOrigin(t, ctx);
  if (![o.x, o.y, t.yaw, t.size].every(Number.isFinite)) return null;
  if (pitchOf(t) !== 0) {
    const top = resolveArea(t, ctx)?.outline;
    if (top) return { kind: "poly", points: top };
  }
  const L = clamp(t.size, AREA_MIN_FT, AREA_MAX_FT) / fpc;
  const d = yawVector(t.yaw);
  const n = { x: -d.y, y: d.x };
  switch (t.shape) {
    case "sphere":
    case "cylinder":
      return { kind: "circle", x: o.x, y: o.y, r: L };
    case "cone": {
      const tip = { x: o.x + d.x * L, y: o.y + d.y * L };
      return { kind: "poly", points: [o.x, o.y, tip.x + (n.x * L) / 2, tip.y + (n.y * L) / 2, tip.x - (n.x * L) / 2, tip.y - (n.y * L) / 2] };
    }
    case "cube": {
      const c = cubeCenter({ size: t.size, origin: o, yaw: t.yaw, faceOffset: t.faceOffset }, fpc);
      return { kind: "poly", points: boxCorners(c, d, n, L / 2, L / 2) };
    }
    case "line": {
      const hw = clamp(t.width ?? DEFAULT_LINE_WIDTH_FT, AREA_MIN_FT, AREA_MAX_FT) / fpc / 2;
      return { kind: "poly", points: boxCorners({ x: o.x + (d.x * L) / 2, y: o.y + (d.y * L) / 2 }, d, n, L / 2, hw) };
    }
    case "emanation": {
      const r = resolveArea(t, ctx)?.box;
      if (!r) return { kind: "circle", x: o.x, y: o.y, r: L };
      return { kind: "roundRect", x: r.x - L, y: r.y - L, w: r.w + 2 * L, h: r.h + 2 * L, r: L };
    }
  }
}

/** The topmost point of an outline, where its name goes. */
export function outlineTop(o: Outline): { x: number; y: number } {
  switch (o.kind) {
    case "circle":
      return { x: o.x, y: o.y - o.r };
    case "roundRect":
      return { x: o.x + o.w / 2, y: o.y };
    case "poly": {
      let best = { x: o.points[0] ?? 0, y: o.points[1] ?? 0 };
      for (let i = 2; i + 1 < o.points.length; i += 2) if (o.points[i + 1]! < best.y) best = { x: o.points[i]!, y: o.points[i + 1]! };
      return best;
    }
  }
}

/** The lowest point of an outline, where its name goes when the top is crowded. */
export function outlineBottom(o: Outline): { x: number; y: number } {
  switch (o.kind) {
    case "circle":
      return { x: o.x, y: o.y + o.r };
    case "roundRect":
      return { x: o.x + o.w / 2, y: o.y + o.h };
    case "poly": {
      let best = { x: o.points[0] ?? 0, y: o.points[1] ?? 0 };
      for (let i = 2; i + 1 < o.points.length; i += 2) if (o.points[i + 1]! > best.y) best = { x: o.points[i]!, y: o.points[i + 1]! };
      return best;
    }
  }
}

function boxCorners(c: Point, d: Point, n: Point, hu: number, hw: number): number[] {
  const corner = (su: number, sw: number) => [c.x + d.x * hu * su + n.x * hw * sw, c.y + d.y * hu * su + n.y * hw * sw];
  return [...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, 1)];
}

/** Where the rotation handle of a cone, line or cube sits: past the far end of its axis. */
export function handlePoint(t: AreaTemplateInput, ctx: AreaContext, beyondCells: number): Point {
  const o = liveOrigin(t, ctx);
  const L = clamp(t.size, AREA_MIN_FT, AREA_MAX_FT) / ctx.settings.feetPerCell;
  const d = yawVector(t.yaw);
  if (t.shape === "cube") {
    const c = cubeCenter({ size: t.size, origin: o, yaw: t.yaw, faceOffset: t.faceOffset }, ctx.settings.feetPerCell);
    return { x: c.x + d.x * (L / 2 + beyondCells), y: c.y + d.y * (L / 2 + beyondCells) };
  }
  return { x: o.x + d.x * (L + beyondCells), y: o.y + d.y * (L + beyondCells) };
}

/** Whether a map point is inside a template's shading slice, for tapping a placed area to pick it. */
export function areaContains(t: AreaTemplateInput, ctx: AreaContext, p: Point): boolean {
  const area = resolveArea(t, ctx);
  return !!area && (area.shade ?? area.shape).inside(p.x, p.y, area.originZ);
}

/** The height in feet of a point a sphere or cylinder is dropped on: a token's feet, or the ground. */
export function pointHeight(token: AreaToken | undefined): number {
  return token ? Math.round(token.elevation) : 0;
}

/**
 * The ground under a point an area is dropped on in open map, its origin's
 * height when the area is first placed (docs/design-v1-maps-vision.md 4.2:
 * "A free area placed on raised ground takes the ground there as its
 * origin height"). A point on a cell's edge or corner touches every cell
 * around it and takes the highest, as a footprint takes the highest ground
 * under it, so a fireball dropped on a platform's rim sits on the platform.
 */
export function pointGround(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, p: Point): number {
  return rangeGround(chunks, sceneId, { x0: Math.ceil(p.x) - 1, y0: Math.ceil(p.y) - 1, x1: Math.floor(p.x) + 1, y1: Math.floor(p.y) + 1 });
}

/**
 * The height of an area's point set on open map before it is placed: the
 * ground there for a new point, and for a point the DM taps again or drags,
 * the same height above the ground it had, so one put on a platform and
 * then moved to the floor comes down with it, and one raised with the
 * Elevation stepper keeps its lift.
 */
export function freePointHeight(chunks: Readonly<Record<string, BuildChunk>>, sceneId: string, to: Point, from: Point3 | null | undefined): number {
  const ground = pointGround(chunks, sceneId, to);
  return from ? ground + from.z - pointGround(chunks, sceneId, from) : ground;
}

/** A token's center and middle height, for measuring from a caster. */
export function tokenCenter(token: AreaToken, feetPerCell: number): Point3 {
  const r = footprintRect(token);
  return { x: r.x + r.w / 2, y: r.y + r.h / 2, z: token.elevation + tokenHeightFt(token, feetPerCell) / 2 };
}
