import type { RoomState, Viewer } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";

/**
 * A member's copy of a room for the attach tests: the projection of scene
 * s1, links and all (docs/design-v1-attach.md 8.5). Never imported by
 * production code.
 */
export function copyFor(state: RoomState, viewer: Viewer): RoomState {
  return projectState(state, viewer, { sceneId: "s1" }) as unknown as RoomState;
}
