import type { Scene } from "#shared/model.ts";
import { MAX_NAME, type OpOf } from "#shared/protocol.ts";
import { copyFogEnabled } from "#shared/reducer/duplicate.ts";

/**
 * Duplicating a scene (docs/design-v1-maps-vision.md section 3.2). The map,
 * its phases, the build, labels, stamps and lights always come along. The
 * rest is the DM's choice, with these defaults: monsters, NPCs and objects
 * yes, player characters no, since the DM brings the party over by moving
 * players, and no fog or drawings, so a map scene's copy starts fully fogged
 * like any new map scene.
 */

export type DuplicateInclude = OpOf<"scene.duplicate">["include"];

export const DUPLICATE_DEFAULTS: DuplicateInclude = Object.freeze({ creatures: true, characters: false, fog: false, drawings: false });

const SUFFIX = " (copy)";

/**
 * "<name> (copy)", shortened so the whole stays within the protocol's name
 * limit. It cuts between characters, never inside an emoji's surrogate pair.
 */
export function copyName(name: string): string {
  const room = MAX_NAME - SUFFIX.length;
  let base = "";
  for (const ch of name.trim()) {
    if (base.length + ch.length > room) break;
    base += ch;
  }
  return `${base.trimEnd() || "Scene"}${SUFFIX}`;
}

/**
 * What the Fog option means for this scene, so the sheet never promises a
 * fogged copy the reducer will not make (`copyFogEnabled`).
 */
export function fogHint(scene: Pick<Scene, "map" | "fogEnabled">, includeFog: boolean): string {
  if (!copyFogEnabled(scene, includeFog)) return "Fog is off on this scene, so the copy's is too.";
  return "Left off, the copy starts fully fogged.";
}

export function duplicateOp(sceneId: string, newSceneId: string, name: string, include: DuplicateInclude): OpOf<"scene.duplicate"> {
  return { t: "scene.duplicate", sceneId, newSceneId, name: copyName(name), include: { ...include } };
}
