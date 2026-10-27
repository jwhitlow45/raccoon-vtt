import { LIMITS, litTokenLights } from "#shared/limits.ts";
import type { LightLevel, MapPhase, RoomState, Scene, SceneVision } from "#shared/model.ts";
import type { ClientOp, OpOf } from "#shared/protocol.ts";

/**
 * The rules of a scene's What players see settings (docs/design-v1-maps-vision.md
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

/** A `vision` patch as the protocol takes it, which may name `perPlayer` (docs/design-v1-per-player-vision.md 6.7). */
export type VisionPatch = NonNullable<OpOf<"scene.update">["patch"]["vision"]>;

/**
 * The `vision` patch of the Sight row (docs/design-v1-per-player-vision.md
 * 7.1): Per player or Whole party, leaving party vision and the light as
 * they are. The other two patches name no `perPlayer`, so the scene keeps
 * what it has (the merge rule of 6.7).
 */
export function sightPatch(scene: Pick<Scene, "vision">, perPlayer: boolean): VisionPatch {
  return { on: scene.vision?.on === true, light: lightOf(scene), perPlayer };
}

export type SightChoice = "party" | "player";

/** The Sight row's choice for a scene: Per player while `perPlayer` is stored, whatever party vision says. */
export function sightOf(scene: Pick<Scene, "vision">): SightChoice {
  return scene.vision?.perPlayer === true ? "player" : "party";
}

/** Whether the Sight row shows: while party vision is on, or the scene is a per-player one (7.1). */
export function sightShown(scene: Pick<Scene, "vision">): boolean {
  return scene.vision?.on === true || scene.vision?.perPlayer === true;
}

export const SIGHT_CHOICES: readonly { value: SightChoice; label: string; help: string }[] = [
  { value: "party", label: "Whole party", help: "Every player sees what any party creature sees, and the party shares one map." },
  {
    value: "player",
    label: "Per player",
    help: `Each player sees only what their own creatures see, and creatures that share sight with the party. Each player keeps their own map of where they have been. At most ${LIMITS.sightHoldersPerScene} players per scene.`,
  },
];

/** The Party vision switch's help while it is on (7.1): on a per-player scene each player sees by their own creatures. */
export function visionOnHelp(scene: Pick<Scene, "vision">): string {
  return scene.vision?.perPlayer === true
    ? "On: each player sees only what their own creatures see, by their senses and the light around them."
    : "On: players see only what their characters see, by their own senses and the light around them.";
}

/**
 * What a scene's What players see settings wait on (7.1): `vision`, a change the
 * Party vision switch or the Light control sent, which make the switch
 * busy as before, and `sight`, the last change of the Sight row or of who
 * sees for themselves, which make the row and the list busy instead, and
 * which way it goes. Each only for its own changes, so a tap on one never
 * holds the other.
 */
export function visionPending(pending: readonly { op: ClientOp }[], sceneId: string): { vision: boolean; sight: SightChoice | null } {
  let vision = false;
  let sight: SightChoice | null = null;
  for (const { op } of pending) {
    if (op.t === "vision.holders" && op.sceneId === sceneId) sight = "player";
    if (op.t !== "scene.update" || op.sceneId !== sceneId || op.patch.vision === undefined) continue;
    if (op.patch.vision.perPlayer === undefined) vision = true;
    else sight = op.patch.vision.perPlayer ? "player" : "party";
  }
  return { vision, sight };
}

/** The Sight row's working line, after about 200 ms (7.1): what the server is working out for the change on its way. */
export function sightWorkingText(towardPerPlayer: boolean): string {
  return towardPerPlayer ? "Working out what each player sees…" : "Working out what the party sees…";
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

/**
 * The What players see settings' words for the scene's fog while party
 * vision is on. On a per-player scene each map is a player's own, and what
 * creatures that share sight see goes on every map (review PV5-OPUS-5).
 */
export function fogNote(scene: Pick<Scene, "fogEnabled" | "vision">): { text: string; warning: boolean } {
  const perPlayer = scene.vision?.perPlayer === true;
  if (scene.fogEnabled) {
    return perPlayer
      ? { text: "Each player's map keeps the ground their own creatures have seen, and every map keeps what creatures that share sight have seen, dimmed, with no creatures on it.", warning: false }
      : { text: "Ground the party has seen stays on players' maps, dimmed, with no creatures on it.", warning: false };
  }
  return perPlayer
    ? { text: "Explored ground is not remembered while fog is off. Each player sees the whole map dimmed outside what their own creatures and creatures that share sight see.", warning: true }
    : { text: "Explored ground is not remembered while fog is off. Players see the whole map dimmed outside the party's sight.", warning: true };
}

/**
 * The What players see settings' note for the DM when more tokens carry a
 * lit light on a scene than sight lights, or null. Players' torches and hidden
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
