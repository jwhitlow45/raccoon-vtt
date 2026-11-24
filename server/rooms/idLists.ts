import { FALL_RIDERS_MOST, type RoomState, type TrapDue } from "#shared/model.ts";
import { playersToken } from "#shared/players.ts";
import { ownEntry } from "#shared/records.ts";

/*
 * The lists a room stored below SEALED_IDS_SNAPSHOT_VERSION kept by their
 * version 7 ids, set right once those ids are given anew: the first load's
 * new ids (reid.ts renamedState) and an import of an older export
 * (remap.ts remapState) both apply these, so the two give one room the
 * same cards.
 */

const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * A trap occurrence's list of creatures cut at its cap kept the first by
 * version 7 id, and those it left out were never stored, so no new id can
 * choose among them again. Such a list goes, its creatures counted as an
 * occurrence that named none counts them (`hitsMore`, `more`), and the DM
 * picks who it hits. A fall card's riders stop at FALL_RIDERS_MOST with no
 * count, so a full list goes, and the card names its creature alone.
 */
export function withoutCutLists(state: RoomState): RoomState {
  let traps: RoomState["traps"] | null = null;
  for (const [id, trap] of Object.entries(state.traps ?? {})) {
    const due = trap.rig?.due;
    if (!trap.rig || !due?.some((d) => (d.hitsMore ?? 0) > 0 || (d.more ?? 0) > 0)) continue;
    traps ??= { ...state.traps };
    traps[id] = { ...trap, rig: { ...trap.rig, due: due.map(uncut) } };
  }
  let falls: NonNullable<RoomState["falls"]> | null = null;
  for (const [id, card] of Object.entries(state.falls ?? {})) {
    if ((card.riders?.length ?? 0) < FALL_RIDERS_MOST) continue;
    falls ??= { ...state.falls };
    const { riders: _cut, ...rest } = card;
    falls[id] = rest;
  }
  if (traps === null && falls === null) return state;
  return { ...state, ...(traps === null ? {} : { traps }), ...(falls === null ? {} : { falls }) };
}

function uncut(due: TrapDue): TrapDue {
  const out = { ...due };
  if ((due.hitsMore ?? 0) > 0) {
    out.hits = [];
    out.hitsMore = due.hits.length + due.hitsMore!;
  }
  if ((due.more ?? 0) > 0) {
    out.by = [];
    out.more = due.by.length + due.more!;
  }
  return out;
}

/**
 * The lists the reducer writes in id order, sorted again by the ids they
 * hold now, where they hold a new one, so none keeps the order of the
 * version 7 ids it held:
 * - a history step's walks, by creature;
 * - a trap occurrence's creatures it hits, which a group save's rows keep
 *   on a name tie (client/features/dice/groupSave/rows.ts groupRows), so
 *   the HP lines players read follow it;
 * - who set it off, those players own or saw first, which Do its effects
 *   names to players in that order (shared/reducer/traps.ts trapAct). The
 *   creatures players saw are those the DM's trap line marks, and those
 *   players own, those they own now;
 * - a fall card's riders, which its group save's rows keep on a name tie.
 * Every other list of ids keeps its order: no output follows it (a step's
 * companions' Reactions, the creatures a turn revealed, a turn's mounts),
 * it is the order an asker or the DM chose (an ask's targets, a roll
 * request's), or it is a line players read already (`trapSeen`).
 */
export function inIdOrderAgain(state: RoomState, fresh: ReadonlySet<string>): RoomState {
  const holdsFresh = (ids: readonly string[]) => ids.some((id) => fresh.has(id));
  if (state.encounterHistory.some((step) => step.walks !== undefined)) {
    state.encounterHistory = state.encounterHistory.map((step) => (step.walks === undefined ? step : { ...step, walks: [...step.walks].sort((a, b) => byCodeUnit(a.tokenId, b.tokenId)) }));
  }
  for (const trap of Object.values(state.traps ?? {})) {
    const due = trap.rig?.due;
    if (!trap.rig || !due?.some((d) => holdsFresh(d.hits) || holdsFresh(d.by))) continue;
    trap.rig.due = due.map((d) => {
      const out = { ...d };
      if (holdsFresh(d.hits)) out.hits = [...d.hits].sort(byCodeUnit);
      if (holdsFresh(d.by)) {
        const line = state.trapLog.find((l) => l.id === d.id)?.data;
        const marked = new Set(line?.type === "trap" ? (line.seen ?? []).map((i) => line.by[i]) : []);
        const shown = (id: string) => {
          const token = ownEntry(state.tokens, id);
          return marked.has(id) || (token !== undefined && playersToken(state, token));
        };
        const sorted = [...d.by].sort(byCodeUnit);
        out.by = [...sorted.filter(shown), ...sorted.filter((id) => !shown(id))];
      }
      return out;
    });
  }
  for (const card of Object.values(state.falls ?? {})) {
    if (card.riders && holdsFresh(card.riders)) card.riders = [...card.riders].sort(byCodeUnit);
  }
  return state;
}
