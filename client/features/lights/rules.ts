import { LIMITS } from "#shared/limits.ts";
import { FREE_WALL_LATTICE, type Light } from "#shared/model.ts";
import { MAX_NAME, type LightInput } from "#shared/protocol.ts";
import type { Point } from "../../lib/camera.ts";
import type { LightPreset } from "../vision/presets.ts";

/**
 * The rules of the builder's Light mode (docs/design-v1-maps-vision.md
 * sections 3.6 and 4.3.1), as plain functions for node --test: where a
 * placed or dragged light lands, the light a tap places, and the light
 * input an edit sends.
 */

/**
 * Where a light lands for a point: inside the scene, on the 1/64 cell
 * lattice the protocol requires, so sight's test of whether a light sits on
 * a wall stays exact (section 3.6).
 */
export function lightSpot(p: Point, bounds: { w: number; h: number }): Point {
  const on = (v: number, max: number) => Math.round(Math.min(max, Math.max(0, v)) * FREE_WALL_LATTICE) / FREE_WALL_LATTICE;
  return { x: on(p.x, bounds.w), y: on(p.y, bounds.h) };
}

/** A light as `build.lights` takes it: the stored light without its revision and scene. */
export function inputOf(light: Light): LightInput {
  const { rev: _rev, sceneId: _sceneId, ...input } = light;
  return input;
}

/** The light a tap places: the preset's radii, lit, casting shadows, named after the preset. */
export function placedLight(id: string, at: Point, preset: LightPreset): LightInput {
  return { id, x: at.x, y: at.y, bright: preset.bright, dim: preset.dim, on: true, walls: true, label: preset.name };
}

/** How many lights a scene holds, against LIMITS.lightsPerScene. */
export function lightsOn(lights: Readonly<Record<string, Light | undefined>> | undefined, sceneId: string): number {
  let n = 0;
  for (const light of Object.values(lights ?? {})) if (light?.sceneId === sceneId) n++;
  return n;
}

/** Why a tap places no light, or null when it may. */
export function placeRefusal(count: number): string | null {
  return count >= LIMITS.lightsPerScene ? `This scene already has ${LIMITS.lightsPerScene} lights, the most it can hold.` : null;
}

/** A light's label as the protocol takes it: one trimmed line, or none. */
export function cleanLabel(text: string): string | undefined {
  const line = text.replace(/[\p{Cc}\u2028\u2029\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
  const cut = line.slice(0, MAX_NAME).trim();
  return cut.length > 0 ? cut : undefined;
}

/** The light with a patch applied, as `build.lights` takes it, the label dropped when empty. */
export function patched(light: Light, patch: Partial<Omit<LightInput, "id">>): LightInput {
  const next = { ...inputOf(light), ...patch };
  if (next.label === undefined || next.label === "") delete next.label;
  return next;
}
