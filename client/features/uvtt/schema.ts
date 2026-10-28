import { z } from "zod";
import type { UvttEnvironment } from "../vision/uvttLight.ts";
import { count, MAX_FILE_LIGHTS, MAX_POINTS, MAX_POLYLINES, MAX_PORTALS, NO_IMAGE, NOT_UVTT, SLACK_SQUARES } from "./limits.ts";

/**
 * The subset of a Universal VTT file the import reads
 * (docs/design-v1-maps-vision.md section 3.1). Dungeondraft, Dungeon
 * Alchemist and DungeonFog write the same JSON under three extensions.
 * Unknown keys are ignored, a missing optional key reads as empty, and
 * every count and coordinate is bounded, since the file is untrusted.
 *
 * Everything here is in the file's own units: squares, with the map's
 * corner at `map_origin`. convert.ts moves it into the scene.
 */

export type Point = { x: number; y: number };

/** `position` is kept only to tell which exporter wrote the file (outlines.ts): Arkenforge writes a portal's size there, the others its midpoint. */
export type UvttPortal = { a: Point; b: Point; closed: boolean; position: Point | null };
export type UvttLight = { at: Point; range: number; color: string | null; shadows: boolean };

export type UvttMap = {
  origin: Point;
  size: Point;
  pixelsPerGrid: number;
  walls: Point[][];
  objects: Point[][];
  portals: UvttPortal[];
  lights: UvttLight[];
  /** Whether the image is lit already, and its ambient light, for the scene's proposed light level (vision/uvttLight.ts). */
  environment?: UvttEnvironment | null;
  /** The map image, base64, still undecoded. */
  image: string;
};

/** zod's own numbers refuse NaN and the infinities, which JSON can spell as 1e999. */
const num = z.number();
const point = z.object({ x: num, y: num });
const polylines = z.array(z.array(point).max(MAX_POINTS)).max(MAX_POLYLINES);

const fileSchema = z.object({
  resolution: z.object({
    map_origin: point.optional(),
    map_size: z.object({ x: num.positive(), y: num.positive() }),
    pixels_per_grid: num.positive(),
  }),
  line_of_sight: polylines.nullish(),
  objects_line_of_sight: polylines.nullish(),
  portals: z
    .array(
      z.object({
        bounds: z.array(point).length(2),
        // Dungeondraft's "block light" switch. A portal that leaves it out is an ordinary door.
        closed: z.boolean().nullish(),
        // Only a hint, so one that is not a point reads as none rather than refusing the file.
        position: point.nullish().catch(null),
      }),
    )
    .max(MAX_PORTALS)
    .nullish(),
  lights: z
    .array(
      z.object({
        position: point,
        range: num.nonnegative(),
        // Only a hint, so a color the import cannot use reads as none. Dungeon Alchemist's beta writes "ffRGBA(0.750, 0.750, 0.750, 0.750)", past the bound.
        color: z.string().max(32).nullish().catch(null),
        shadows: z.boolean().nullish(),
      }),
    )
    .max(MAX_FILE_LIGHTS)
    .nullish(),
  // Read by hand (environmentOf), so a file whose environment is shaped oddly still imports, with no light proposed.
  environment: z.unknown().optional(),
  image: z.string(),
});

export type ReadResult = { ok: true; map: UvttMap } | { ok: false; error: string };

function lengthOf(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/**
 * Counts the arrays before the schema walks them. zod checks an array's
 * length after it has parsed every element, so a file with ten million
 * points would be walked in full only to be refused. These are plain
 * length reads, cheap at any size.
 */
function precheck(raw: Record<string, unknown>): string | null {
  const walls = raw.line_of_sight;
  const objects = raw.objects_line_of_sight;
  const polylineCount = lengthOf(walls) + lengthOf(objects);
  if (polylineCount > MAX_POLYLINES) return `This file has ${count(polylineCount)} wall lines. An import takes at most ${count(MAX_POLYLINES)}.`;
  let points = 0;
  for (const list of [walls, objects]) {
    if (!Array.isArray(list)) continue;
    for (const line of list) points += lengthOf(line);
  }
  if (points > MAX_POINTS) return `This file's walls have ${count(points)} points. An import takes at most ${count(MAX_POINTS)}.`;
  const portals = lengthOf(raw.portals);
  if (portals > MAX_PORTALS) return `This file has ${count(portals)} doors and windows. An import takes at most ${count(MAX_PORTALS)}.`;
  const lights = lengthOf(raw.lights);
  if (lights > MAX_FILE_LIGHTS) return `This file has ${count(lights)} lights. An import takes at most ${count(MAX_FILE_LIGHTS)}.`;
  return null;
}

/**
 * Checks parsed JSON and returns the map in the file's units, or a sentence
 * for the DM. `geometry: false` leaves out the check that walls, doors and
 * lights lie near the map, for a phase, which takes only the image. The
 * counts are bounded either way, since they bound the work of the parse.
 */
export function readUvtt(raw: unknown, options: { geometry?: boolean } = {}): ReadResult {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: NOT_UVTT };
  const record = raw as Record<string, unknown>;
  if (typeof record.resolution !== "object" || record.resolution === null) return { ok: false, error: NOT_UVTT };
  if (typeof record.image !== "string" || record.image.length === 0) return { ok: false, error: NO_IMAGE };
  const tooMany = precheck(record);
  if (tooMany) return { ok: false, error: tooMany };
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: NOT_UVTT };
  const f = parsed.data;
  const origin = f.resolution.map_origin ?? { x: 0, y: 0 };
  const size = f.resolution.map_size;
  const map: UvttMap = {
    origin: { x: origin.x, y: origin.y },
    size: { x: size.x, y: size.y },
    pixelsPerGrid: f.resolution.pixels_per_grid,
    walls: (f.line_of_sight ?? []).map((line) => line.map((p) => ({ x: p.x, y: p.y }))),
    objects: (f.objects_line_of_sight ?? []).map((line) => line.map((p) => ({ x: p.x, y: p.y }))),
    portals: (f.portals ?? []).map((p) => ({
      a: { x: p.bounds[0]!.x, y: p.bounds[0]!.y },
      b: { x: p.bounds[1]!.x, y: p.bounds[1]!.y },
      closed: p.closed ?? true,
      position: p.position ? { x: p.position.x, y: p.position.y } : null,
    })),
    lights: (f.lights ?? []).map((l) => ({ at: { x: l.position.x, y: l.position.y }, range: l.range, color: l.color ?? null, shadows: l.shadows ?? true })),
    environment: environmentOf(f.environment),
    image: f.image,
  };
  if (options.geometry !== false && !withinMap(map)) return { ok: false, error: "This file has walls, doors or lights far outside its map." };
  return { ok: true, map };
}

/** The file's `environment`, or null when it has none the import can read. */
function environmentOf(raw: unknown): UvttEnvironment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const { baked_lighting: baked, ambient_light: ambient } = raw as Record<string, unknown>;
  return { baked: baked === true, ambient: typeof ambient === "string" && ambient.length <= 32 ? ambient : null };
}

/** Every coordinate within SLACK_SQUARES of the map's own rectangle. */
function withinMap(map: UvttMap): boolean {
  const x0 = map.origin.x - SLACK_SQUARES;
  const y0 = map.origin.y - SLACK_SQUARES;
  const x1 = map.origin.x + map.size.x + SLACK_SQUARES;
  const y1 = map.origin.y + map.size.y + SLACK_SQUARES;
  const inside = (p: Point) => p.x >= x0 && p.x <= x1 && p.y >= y0 && p.y <= y1;
  for (const list of [map.walls, map.objects]) {
    for (const line of list) for (const p of line) if (!inside(p)) return false;
  }
  for (const p of map.portals) if (!inside(p.a) || !inside(p.b)) return false;
  for (const l of map.lights) if (!inside(l.at)) return false;
  return true;
}
