import { readEntity } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import { reads, satisfies } from "#shared/reads.ts";
import { applyOp } from "#shared/reducer.ts";
import { guardHash } from "#shared/reducer/tx.ts";
import { undoScope } from "#shared/undoScope.ts";
import type { PendingOp } from "./types.ts";

export const SETUP_SAVED = "Saved. Undo in Setup history.";

/** A batch can include other devices. Only a fully known batch supplies each accepted op's before-state. */
export function confirmedSetupSave(input: {
  before: ProjectedState;
  after: ProjectedState;
  beforeSeq: number;
  seq: number;
  accepted: readonly PendingOp[];
  viewer: Viewer | null;
  sceneId: string | null;
}): boolean {
  if (input.viewer?.role !== "dm" || input.seq - input.beforeSeq !== input.accepted.length) return false;
  let state = input.before as RoomState;
  let saved = false;
  for (const [index, pending] of input.accepted.entries()) {
    // An incomplete projection cannot establish this op's effects or the next op's before-state.
    if (!satisfies(reads(pending.op, state), state as ProjectedState, input.viewer, { sceneId: input.sceneId })) return false;
    const scope = undoScope(pending.op, state);
    const result = applyOp(state, pending.op, input.viewer, { seq: input.beforeSeq + index + 1, at: new Date(pending.at).toISOString() });
    if (!result.ok) return false;
    if (scope === "setup" || (scope === "play" && pending.groupScope === "setup")) {
      saved ||= result.inverse?.some(({ key, value }) =>
        guardHash(key, value) !== guardHash(key, readEntity(result.state, key))
        && guardHash(key, readEntity(input.before as RoomState, key)) !== guardHash(key, readEntity(input.after as RoomState, key)),
      ) === true;
    }
    state = result.state;
  }
  return saved;
}
