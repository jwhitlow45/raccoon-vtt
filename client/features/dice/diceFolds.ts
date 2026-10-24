import { useSyncExternalStore } from "react";
import type { NamedRoll } from "#shared/dice/bonus.ts";
import type { RoomState } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import type { Size } from "../../lib/camera.ts";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { usePreview } from "../dm/previewContext.ts";
import { layoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";

/*
 * The Dice panel's folds (docs/design-v1-dice-pass.md 6.2 to 6.4): which of
 * its groups show open, as this device last left them, kept apart from the
 * token panel's (features/tokens/panelFolds.ts), since a group here and a
 * section there hold different things. Plain functions and a slot, for
 * node --test, in the token panel's pattern: resolved once per Room page,
 * so a tablet turned across 900 px never refolds anything.
 */

/**
 * What a creature's folds are remembered by (6.3). Folding a monster's
 * Saves and checks never folds a character's.
 */
export const FOLD_KINDS = ["pc", "companion", "monster"] as const;
export type FoldKind = (typeof FOLD_KINDS)[number];

/**
 * One creature's groups in the panel's order (6.1). `saves` is Saves and
 * checks. The action groups and Spells take their named rolls' `section`,
 * so a row's group is its roll's section.
 */
export const CREATURE_GROUPS = ["saves", "skills", "traits", "actions", "bonusActions", "reactions", "legendaryActions", "spells"] as const satisfies readonly ("saves" | "skills" | NamedRoll["section"])[];
export type CreatureGroup = (typeof CREATURE_GROUPS)[number];

/** The groups under several selected (5.3): Saves and checks, Skills and Shared attacks. */
export const SEVERAL_GROUPS = ["saves", "skills", "sharedAttacks"] as const;
export type SeveralGroup = (typeof SEVERAL_GROUPS)[number];

export type CreatureFoldKey = `${FoldKind}.${CreatureGroup}`;
export type SeveralFoldKey = `group.${SeveralGroup}`;
/** Recent rolls is one fold for the device, whoever the panel rolls for. */
export type DiceFoldKey = CreatureFoldKey | SeveralFoldKey | "recent";

export function foldKey(kind: FoldKind, group: CreatureGroup): CreatureFoldKey {
  return `${kind}.${group}`;
}

export function severalKey(group: SeveralGroup): SeveralFoldKey {
  return `group.${group}`;
}

export const DICE_FOLD_KEYS: readonly DiceFoldKey[] = [
  ...FOLD_KINDS.flatMap((kind) => CREATURE_GROUPS.map((group) => foldKey(kind, group))),
  ...SEVERAL_GROUPS.map(severalKey),
  "recent",
];

export type DiceFolds = Readonly<Record<DiceFoldKey, boolean>>;

export const DICE_FOLDS_KEY = "rvtt.diceFolds";

/**
 * A creature's fold kind: a character a player picks, or a player
 * character's token, is `pc`, a companion's token `companion`, and every
 * other creature `monster`, NPCs and objects included. So the DM's NPC
 * lent to a player folds with the monsters, as its options read like a
 * monster's, whether it is a token of its own or of a character the DM
 * keeps for it (options.ts playerCreatures), and so does a beast a player
 * owns.
 */
export function foldKind(view: Pick<RoomState, "tokens">, creature: ActorTarget): FoldKind {
  if ("characterId" in creature) return "pc";
  const token = view.tokens[creature.tokenId];
  if (!token) return "monster";
  if (token.companion !== undefined) return "companion";
  return token.kind === "pc" ? "pc" : "monster";
}

/** The token panel's "computer" (panelFolds.ts foldDefaults): at least 900 px wide and 600 tall. A phone held sideways is a phone. */
export function computerLayout(layout: Size): boolean {
  return layout.width >= theme.layout.wideMinWidth && layout.height >= 600;
}

/**
 * Where each group starts with nothing stored (6.2), the same for every
 * kind. Saves and checks fold on a phone, where they stand 250 px above the
 * first action and request cards roll most saves. Skills and Traits fold
 * everywhere, as they are rare in a fight. The rest is what a turn uses.
 */
export function diceFoldStarts(layout: Size): DiceFolds {
  const computer = computerLayout(layout);
  const creature: Record<CreatureGroup, boolean> = {
    saves: computer,
    skills: false,
    traits: false,
    actions: true,
    bonusActions: true,
    reactions: true,
    legendaryActions: true,
    spells: true,
  };
  // Saves and checks are why the DM selected several, so they open everywhere.
  const several: Record<SeveralGroup, boolean> = { saves: true, skills: false, sharedAttacks: true };
  const out = { recent: true } as Record<DiceFoldKey, boolean>;
  for (const kind of FOLD_KINDS) for (const group of CREATURE_GROUPS) out[foldKey(kind, group)] = creature[group];
  for (const group of SEVERAL_GROUPS) out[severalKey(group)] = several[group];
  return out;
}

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "getItem" | "setItem">;

/** What storage holds, as an object, or nothing for a missing key, bad JSON, something not an object, or storage that throws. */
function stored(storage: ReadStorage | null): Record<string, unknown> {
  try {
    const raw = storage?.getItem(DICE_FOLDS_KEY) ?? null;
    if (raw === null) return {};
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The folds: each stored boolean, and the start at this layout for anything else. */
export function resolveDiceFolds(storage: ReadStorage | null, layout: Size): DiceFolds {
  const from = stored(storage);
  const out = { ...diceFoldStarts(layout) };
  for (const key of DICE_FOLD_KEYS) {
    const value = from[key];
    if (typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** Stores one group's fold beside what is already stored, so a group never tapped keeps following its start. */
export function writeDiceFold(storage: WriteStorage | null, key: DiceFoldKey, open: boolean): void {
  try {
    if (!storage) return;
    const next: Record<string, boolean> = {};
    const from = stored(storage);
    for (const k of DICE_FOLD_KEYS) if (typeof from[k] === "boolean") next[k] = from[k] as boolean;
    next[key] = open;
    storage.setItem(DICE_FOLDS_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage full: the fold lasts for this Room, which is all a blocked storage allows.
  }
}

export type DiceFoldsStore = {
  /** The folds, resolved the first time the panel asks, from storage and the starts at that layout, then kept. */
  get(layout: Size): DiceFolds;
  /** A viewer's tap on a fold row. `write` is false in "view as a player", which reads storage and never writes it. */
  tap(key: DiceFoldKey, open: boolean, write: boolean): void;
  /**
   * The app opens a group for this page, never writing storage (6.4), as a
   * tap on the sticky result line opens Recent rolls. Says whether it was
   * folded, so the caller knows the group's rows draw on a later render.
   */
  open(key: DiceFoldKey): boolean;
  /**
   * Opens a group once for each id it has not seen under that key: an
   * ask's id for Saves and checks, a cast's opening for the group that holds
   * its row (6.4). The ids are kept here, in the Room scope, so a tab pick
   * that remounts the options, or a phone's Dice sheet closing, never opens
   * a group again that the viewer folded since. Says whether any id was new.
   * `quiet` ids are only marked seen, first, as a block's own send is when
   * its creature's groups render with the block (options.ts groupAsks).
   */
  openForNew(key: DiceFoldKey, ids: readonly string[], quiet?: readonly string[]): boolean;
  subscribe(listener: () => void): () => void;
};

export function createDiceFolds(storage: WriteStorage | null): DiceFoldsStore {
  let folds: DiceFolds | null = null;
  const seen = new Map<DiceFoldKey, Set<string>>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  // Before the panel has read its folds, a change starts from the phone's starts, as the token panel's do.
  const current = () => (folds ??= resolveDiceFolds(storage, { width: 0, height: 0 }));
  const open = (key: DiceFoldKey) => {
    if (current()[key]) return false;
    folds = { ...current(), [key]: true };
    // An opening runs while the options render, so their readers hear of it once that render is done, never in the middle of it.
    queueMicrotask(notify);
    return true;
  };
  return {
    get(layout) {
      folds ??= resolveDiceFolds(storage, layout);
      return folds;
    },
    tap(key, next, write) {
      folds = { ...current(), [key]: next };
      if (write) writeDiceFold(storage, key, next);
      notify();
    },
    open,
    openForNew(key, ids, quiet = []) {
      let known = seen.get(key);
      if (!known) {
        known = new Set();
        seen.set(key, known);
      }
      for (const id of quiet) known.add(id);
      let fresh = false;
      for (const id of ids) {
        if (known.has(id)) continue;
        known.add(id);
        fresh = true;
      }
      if (fresh) open(key);
      return fresh;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function deviceStorage(): WriteStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Per Room page (state/scope.ts): the Dice sheet and the side panel's tab draw in separate trees, and both read this. */
export const diceFoldsSlot = scopeSlot(() => createDiceFolds(deviceStorage()));

/** A render with no window, as a render test's, reads the phone's starts. */
const NO_WINDOW: Size = { width: 0, height: 0 };

/**
 * The Dice panel's folds for this Room, kept up to date with every change.
 * `fold` gives a `Group` its `open` and `onToggle`, read when called, so a
 * group the app opened earlier in the same render shows open. A tap is
 * stored, except in "view as a player".
 */
export function useDiceFolds(): { folds: DiceFolds; fold(key: DiceFoldKey): { open: boolean; onToggle(): void }; store: DiceFoldsStore } {
  const store = useScoped(diceFoldsSlot);
  const preview = usePreview() !== null;
  const read = () => store.get(typeof window === "undefined" ? NO_WINDOW : layoutSize(window, uiScale()));
  // The same reader serves a render to markup, so the options' render tests can draw the folds.
  const folds = useSyncExternalStore(store.subscribe, read, read);
  const fold = (key: DiceFoldKey) => ({ open: read()[key], onToggle: () => store.tap(key, !read()[key], !preview) });
  return { folds, fold, store };
}
