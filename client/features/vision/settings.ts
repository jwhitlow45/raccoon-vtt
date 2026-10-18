import { LIMITS, litTokenLights } from "#shared/limits.ts";
import type { LightLevel, MapPhase, RoomState, Scene, SceneVision } from "#shared/model.ts";

/**
 * The rules of a scene's Vision settings (docs/design-v1-maps-vision.md
 * sections 4.3.1 and 4.3.8), as plain functions for node --test.
 */

export const LIGHT_LEVELS: readonly { value: LightLevel; label: string; note: string }[] = [
  { value: "bright", label: "Bright", note: "Lit everywhere, as by day: the party sees everything in its line of sight." },
  { value: "dim", label: "Dim", note: "Dim everywhere: shadows the party sees darker. Darkvision sees Dim Light as Bright Light." },
  { value: "dark", label: "Dark", note: "Dark where no light reaches: the party sees only by light and Darkvision." },
];

/** The scene's light level, Bright until the DM picks one. */
export function lightOf(scene: Pick<Scene, "vision">): LightLevel {
  const light = scene.vision?.light;
  return light === "dim" || light === "dark" ? light : "bright";
}

/** The `vision` patch that turns party vision on or off, keeping the light level. The reducer turns fog on with it. */
export function visionPatch(scene: Pick<Scene, "vision">, on: boolean): SceneVision {
  return { on, light: lightOf(scene) };
}

/** The `vision` patch that sets the light level, leaving party vision as it is. */
export function lightPatch(scene: Pick<Scene, "vision">, light: LightLevel): SceneVision {
  return { on: scene.vision?.on === true, light };
}

/**
 * The phase list with one phase's light set, or taken off with null, so
 * switching to it leaves the light as it is. Null when nothing changes.
 * Only a stored list has phases to switch between.
 */
export function phaseWithLight(phases: readonly MapPhase[] | undefined, phaseId: string, light: LightLevel | null): MapPhase[] | null {
  if (!phases || !phases.some((p) => p.id === phaseId)) return null;
  let changed = false;
  const next = phases.map((p) => {
    if (p.id !== phaseId || (p.light ?? null) === light) return p;
    changed = true;
    const { light: _old, ...rest } = p;
    return light === null ? rest : { ...rest, light };
  });
  return changed ? next : null;
}

/** What the Vision settings say about the scene's fog while party vision is on. */
export function fogNote(scene: Pick<Scene, "fogEnabled">): { text: string; warning: boolean } {
  return scene.fogEnabled
    ? { text: "Ground the party has seen stays on players' maps, dimmed, with no creatures on it.", warning: false }
    : { text: "Explored ground is not remembered while fog is off. Players see the whole map dimmed outside the party's sight.", warning: true };
}

/**
 * What the Vision settings tell the DM when more tokens carry a lit light
 * on a scene than sight lights, or null. Players' torches and hidden
 * combatants revealed on their turn are never refused at the cap, and past
 * it sight lights the party's own lights first, then the rest by token ID
 * (shared/rules/vision.ts carriedLights), and those past it light nothing.
 * In a Bright scene lights change nothing, so there is nothing to say.
 */
export function carriedLightsNote(tokens: RoomState["tokens"], sceneId: string, light: LightLevel): string | null {
  if (light === "bright") return null;
  const over = litTokenLights({ tokens }, sceneId) - LIMITS.litTokenLightsPerScene;
  if (over <= 0) return null;
  const cap = LIMITS.litTokenLightsPerScene;
  return `${over} carried ${over === 1 ? "light lights" : "lights light"} nothing for the party: at most ${cap} do, the party's own first.`;
}
