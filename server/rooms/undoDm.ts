import { keys, parseKey, readEntity } from "#shared/keys.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { stableStringify } from "#shared/project.ts";
import type { RestoreEntry } from "#shared/protocol.ts";
import { ownEntry } from "#shared/records.ts";
import { guardMatches } from "#shared/reducer/misc.ts";
import { guardHash } from "#shared/reducer/tx.ts";

const POSE_FIELDS = ["sceneId", "x", "y", "elevation", "rotation", "size", "w", "h", "squeeze", "nudge", "path", "attached"] as const;
const POSE_KEYS = new Set<string>(POSE_FIELDS);
/**
 * A creature's number and mark (shared/numbering.ts), which the table
 * gives at a batch's end and so are no edit of the DM's: a meeting since
 * the step never stops its pose from adapting. A pose restore takes them
 * from the step, with its scene, and the restore reconciles them with the
 * creature now (shared/reducer/numbering.ts keepNumbering).
 */
const NUMBERING_FIELDS = ["met", "number"] as const;
const NUMBERING_KEYS = new Set<string>(NUMBERING_FIELDS);

/** After-values belong to the action that created this entry, including an Undo that created a Redo entry. */
export type DmHistoryValues = { after: Record<string, unknown>; poseKeys: Set<string> };
export type HistoryConflict = { key: string; current: unknown; pose: boolean };

function pose(token: Token): string {
  return stableStringify(Object.fromEntries(POSE_FIELDS.filter((key) => token[key] !== undefined).map((key) => [key, token[key]])));
}

function nonPose(token: Token): string {
  return stableStringify(Object.fromEntries(Object.entries(token).filter(([key]) => key !== "rev" && !POSE_KEYS.has(key) && !NUMBERING_KEYS.has(key))));
}

export function dmHistoryValues(inverse: readonly RestoreEntry[], after: RoomState, adaptPose: boolean): DmHistoryValues {
  const values: DmHistoryValues = { after: {}, poseKeys: new Set() };
  for (const entry of inverse) {
    const current = readEntity(after, entry.key);
    values.after[entry.key] = current;
    if (!adaptPose || parseKey(entry.key)?.kind !== "token" || !entry.value || !current) continue;
    if (nonPose(entry.value as Token) === nonPose(current as Token)) values.poseKeys.add(entry.key);
  }
  return values;
}

export function mergeDmHistory(older: DmHistoryValues | undefined, newer: DmHistoryValues | undefined): DmHistoryValues | undefined {
  if (!older || !newer) return undefined;
  const poseKeys = new Set(older.poseKeys);
  for (const key of Object.keys(newer.after)) {
    if (newer.poseKeys.has(key) && (!(key in older.after) || older.poseKeys.has(key))) poseKeys.add(key);
    else poseKeys.delete(key);
  }
  return { after: { ...older.after, ...newer.after }, poseKeys };
}

export function historyConflicts(state: RoomState, entries: readonly RestoreEntry[], values?: DmHistoryValues): HistoryConflict[] {
  const conflicts: HistoryConflict[] = [];
  for (const entry of entries) {
    const current = readEntity(state, entry.key);
    const saved = values?.after[entry.key];
    const byPose = values?.poseKeys.has(entry.key) === true && current !== null && saved != null;
    const matches = byPose ? pose(current as Token) === pose(saved as Token) : guardMatches(entry, current);
    if (!matches) conflicts.push({ key: entry.key, current, pose: byPose });
  }
  return conflicts;
}

export function attributesConflict(conflict: HistoryConflict, values: DmHistoryValues | undefined): boolean {
  if (!values || !Object.hasOwn(values.after, conflict.key)) return false;
  const after = values.after[conflict.key];
  if (conflict.pose) return after != null && pose(conflict.current as Token) === pose(after as Token);
  return guardHash(conflict.key, conflict.current) === guardHash(conflict.key, after);
}

/**
 * Adapt only eligible existing tokens. All other inverses keep their original guards and remain in the atomic restore.
 * A token the restore puts on another floor or scene takes along the areas attached to it since the step
 * (`areasAcross`), as the move itself took those attached then (shared/reducer/tokens.ts areasFollow).
 */
export function dmPoseRestore(state: RoomState, entries: readonly RestoreEntry[], values?: DmHistoryValues): RestoreEntry[] {
  const adapted = entries.map((entry) => {
    if (!values?.poseKeys.has(entry.key)) return entry;
    const current = readEntity(state, entry.key) as Token | null;
    const saved = values.after[entry.key] as Token | null | undefined;
    if (!current || !saved || !entry.value || pose(current) !== pose(saved)) return entry;
    const before = entry.value as Token;
    const value = { ...current };
    for (const key of [...POSE_FIELDS, ...NUMBERING_FIELDS]) {
      delete (value as unknown as Record<string, unknown>)[key];
      if (before[key] !== undefined) (value as unknown as Record<string, unknown>)[key] = before[key];
    }
    return { key: entry.key, value, expectHash: guardHash(entry.key, current) };
  });
  // An area the step holds keeps the step's own entry and guard, so one changed since still answers as changed.
  return [...adapted, ...areasAcross(state, adapted, new Set(entries.map((entry) => entry.key)))];
}

/**
 * The areas a restore takes across with the creatures it puts on another
 * floor (docs/design/design-v1-floors.md phase 2, 8, FL2-OPUS-1): every
 * area that follows such a creature now and lies on the floor it stands on
 * now, as its value now with only its floor changed. They are read from
 * the room, not from the step, so one cast or attached since the step goes
 * too, and one the DM moved onto another creature that crosses goes with
 * that one: no area is left on a floor apart from what it follows. One
 * gone, attached to a creature that stays or lying on another floor is not
 * among them, so an area the player does not receive never answers.
 * `skip` names areas the caller's own entries already write.
 */
export function areasAcross(state: RoomState, moved: readonly RestoreEntry[], skip: ReadonlySet<string> = new Set()): RestoreEntry[] {
  const across = new Map<string, { now: string; back: string }>();
  for (const entry of moved) {
    if (parseKey(entry.key)?.kind !== "token" || !entry.value) continue;
    const id = entry.key.slice("token:".length);
    const now = ownEntry(state.tokens, id)?.sceneId;
    const back = (entry.value as Token).sceneId;
    if (now !== undefined && now !== back) across.set(id, { now, back });
  }
  if (across.size === 0) return [];
  const out: RestoreEntry[] = [];
  for (const current of Object.values(state.templates).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = keys.template(current.id);
    const follows = current.attachedTo === undefined ? undefined : across.get(current.attachedTo);
    if (!follows || current.sceneId !== follows.now || skip.has(key)) continue;
    out.push({ key, value: { ...current, sceneId: follows.back }, expectHash: guardHash(key, current) });
  }
  return out;
}
