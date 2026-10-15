import type { LocalUi } from "./types.ts";

/**
 * How taps change the selection and the token action bar (design 14.3), as
 * plain functions over `local`, so the live store and the player preview
 * follow one set of rules and the rules run under node --test. Each returns
 * the same object when nothing changes, so nothing re-renders for nothing.
 *
 * Several tokens can be selected, to move them as a group or give them all
 * one HP entry (features sections 5 and 10). A phone has no Shift key and no
 * hover, so "Select several" is a mode: while it is on, a tap adds a token
 * or takes it out again, and a tap on empty map keeps the selection. On a
 * desktop, Shift or Cmd with a click does the same without the mode.
 * `selectedId` is always the last token of `selectedIds`: the one the
 * single-token views (its panel, the area tool's caster) show.
 */

/**
 * A tap on a token, on the map or on its initiative row ("tapping a row
 * opens the same menu as tapping the token", features section 10): select
 * it and open its action bar. `add` (Shift on a desktop, or the "Select
 * several" mode) adds it to the selection or takes it out. Null is a tap on
 * empty map, which lets go, except while selecting several.
 */
export function tapToken(local: LocalUi, tokenId: string | null, add = false): LocalUi {
  if (tokenId === null) return local.multi ? local : withIds(local, [], false);
  if (!local.multi && !add) return withIds(local, [tokenId], true);
  const ids = local.selectedIds.includes(tokenId) ? local.selectedIds.filter((id) => id !== tokenId) : [...local.selectedIds, tokenId];
  return withIds(local, ids, ids.length > 0);
}

/** Selects one token without opening or closing its action bar, as placing or duplicating one does. Null lets go. */
export function selectToken(local: LocalUi, tokenId: string | null): LocalUi {
  return withIds(local, tokenId === null ? [] : [tokenId], tokenId === null ? false : local.actionBar);
}

/** Adds every token in a dragged box to the selection, the last one becoming the one shown. */
export function addToSelection(local: LocalUi, tokenIds: readonly string[]): LocalUi {
  const added = tokenIds.filter((id) => !local.selectedIds.includes(id));
  if (added.length === 0) return local;
  return withIds(local, [...local.selectedIds, ...added], true);
}

/** Keeps only the tokens that are still there to select, after a delete or a change of scene. */
export function keepSelected(local: LocalUi, present: (tokenId: string) => boolean): LocalUi {
  const ids = local.selectedIds.filter(present);
  return ids.length === local.selectedIds.length ? local : withIds(local, ids, local.actionBar && ids.length > 0);
}

/** Turns "Select several" on or off. The selection stays, so a group picked on a phone can then be moved or hurt. */
export function setMultiSelect(local: LocalUi, on: boolean): LocalUi {
  return local.multi === on ? local : { ...local, multi: on };
}

/** Opens or closes the selection's action bar, which steps aside once the token's panel is open. */
export function showActions(local: LocalUi, open: boolean): LocalUi {
  const actionBar = open && local.selectedIds.length > 0;
  return local.actionBar === actionBar ? local : { ...local, actionBar };
}

function withIds(local: LocalUi, ids: readonly string[], actionBar: boolean): LocalUi {
  const selectedId = ids[ids.length - 1] ?? null;
  const same = local.selectedId === selectedId && local.actionBar === actionBar && sameIds(local.selectedIds, ids);
  return same ? local : { ...local, selectedId, selectedIds: ids, actionBar };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}
