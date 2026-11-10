import { parseKey, type EntityKey } from "#shared/keys.ts";
import type { RoomState } from "#shared/model.ts";
import { MEET_IDS_MOST } from "#shared/numbering.ts";
import { changedSightKeys } from "#shared/project.ts";
import type { OpOf } from "#shared/protocol.ts";
import { meetCandidates } from "#shared/reducer/numbering.ts";
import { floorsOf } from "#shared/rules/floors.ts";

/*
 * The meet step (shared/numbering.ts): at the end of a batch, after its
 * explore and map steps, the creatures the party now holds beside another
 * of their shown name take their numbers, by `sys.meet` ops the actor
 * appends. The ops name the creatures and the reducer reads only the
 * state, so replay never works out sight.
 */

/**
 * The kinds of key a batch must touch for the step to run: what can put a
 * creature in the party's copy, change its shown name, scene or kind, or
 * change who plays it. `member` is here because a member's kind changes
 * who plays a companion, and `opened` because Show floor writes only that.
 */
const STEP_KINDS: ReadonlySet<string> = new Set(["token", "scene", "character", "member", "meta", "fog", "explored", "exploredBy", "holders", "opened", "played", "chunk", "light"]);

/**
 * The step's ops for a batch that went from `before` to `after` touching
 * `touched`: none when it touched no key of STEP_KINDS and changed no sight
 * on the players' scene, since then nothing the party holds or anything
 * the rules read moved. `skip: false` runs the step whatever the batch
 * touched, which the tests compare with the skip.
 */
export function meetOps(before: RoomState, after: RoomState, touched: readonly EntityKey[], opts: { skip?: boolean } = {}): OpOf<"sys.meet">[] {
  if (opts.skip !== false && !touched.some((key) => STEP_KINDS.has(parseKey(key)?.kind ?? "")) && !sightMoved(before, after)) return [];
  const ids = meetCandidates(after, touched, {});
  const ops: OpOf<"sys.meet">[] = [];
  for (let i = 0; i < ids.length; i += MEET_IDS_MOST) ops.push({ t: "sys.meet", tokenIds: ids.slice(i, i + MEET_IDS_MOST) });
  return ops;
}

/** Whether any sight on the players' scene differs between the two states, as a clock's daylight can without a key the step watches. */
function sightMoved(before: RoomState, after: RoomState): boolean {
  const start = after.meta.playerSceneId;
  if (start === null) return false;
  return changedSightKeys(before, after, floorsOf(after, start).map((floor) => floor.id)).length > 0;
}
