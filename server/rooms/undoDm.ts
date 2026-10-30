import { parseKey, readEntity } from "#shared/keys.ts";
import type { RoomState, Token } from "#shared/model.ts";
import { stableStringify } from "#shared/project.ts";
import type { RestoreEntry } from "#shared/protocol.ts";
import { guardMatches } from "#shared/reducer/misc.ts";
import { guardHash } from "#shared/reducer/tx.ts";

const POSE_FIELDS = ["sceneId", "x", "y", "elevation", "rotation", "size", "w", "h", "squeeze", "path", "attached"] as const;
const POSE_KEYS = new Set<string>(POSE_FIELDS);

/** After-values belong to the action that created this entry, including an Undo that created a Redo entry. */
export type DmHistoryValues = { after: Record<string, unknown>; poseKeys: Set<string> };
export type HistoryConflict = { key: string; current: unknown; pose: boolean };

function pose(token: Token): string {
  return stableStringify(Object.fromEntries(POSE_FIELDS.filter((key) => token[key] !== undefined).map((key) => [key, token[key]])));
}

function nonPose(token: Token): string {
  return stableStringify(Object.fromEntries(Object.entries(token).filter(([key]) => key !== "rev" && !POSE_KEYS.has(key))));
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

/** Adapt only eligible existing tokens. All other inverses keep their original guards and remain in the atomic restore. */
export function dmPoseRestore(state: RoomState, entries: readonly RestoreEntry[], values?: DmHistoryValues): RestoreEntry[] {
  return entries.map((entry) => {
    if (!values?.poseKeys.has(entry.key)) return entry;
    const current = readEntity(state, entry.key) as Token | null;
    const saved = values.after[entry.key] as Token | null | undefined;
    if (!current || !saved || !entry.value || pose(current) !== pose(saved)) return entry;
    const before = entry.value as Token;
    const value = { ...current };
    for (const key of POSE_FIELDS) {
      delete (value as unknown as Record<string, unknown>)[key];
      if (before[key] !== undefined) (value as unknown as Record<string, unknown>)[key] = before[key];
    }
    return { key: entry.key, value, expectHash: guardHash(entry.key, current) };
  });
}
