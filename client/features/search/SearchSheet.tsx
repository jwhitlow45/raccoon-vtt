import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal, flushSync } from "react-dom";
import { useStore } from "zustand";
import type { Effect } from "#shared/model.ts";
import type { ActorTarget, ClientOp } from "#shared/protocol.ts";
import { Icon } from "../../components/Icon.tsx";
import { ReloadButton } from "../../components/LoadBoundary.tsx";
import { LoadFailed } from "../../components/LoadFailed.tsx";
import { Loading } from "../../components/Loading.tsx";
import { addsWords, useTooltip } from "../../components/Tooltip.tsx";
import { VISUALLY_HIDDEN } from "../../lib/a11y.ts";
import { useBackClose } from "../../lib/backClose.ts";
import { isAppleDevice } from "../../lib/device.ts";
import { useKeyboardView } from "../../lib/keyboardInset.ts";
import { useModalDialog } from "../../lib/modalDialog.ts";
import { footprint } from "../../lib/scene.ts";
import { statusBand, theme } from "../../lib/theme.ts";
import { useChipEnv, useDmMenuView } from "../../pages/ChipMenus.tsx";
import { dmMenuSections, itemsOf, youMenuSections, type ChipAnswer, type ChipEnv, type ChipItem, type ChipUnder } from "../../pages/chipMenus.ts";
import { focusMap, mapFocusSlot } from "../../pages/mapFocus.ts";
import { useRoomScope, useScoped } from "../../state/scope.ts";
import { keyText, letterOf, searchSheetSlot, setSearchSheet, SHORTCUTS, useKeyHint, useShortcutKeys, withKey, type KeyPress, type ShortcutEnv, type ShortcutTool } from "../../state/shortcuts.ts";
import type { RoomView } from "../../state/types.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { useLayoutSize } from "../device/layout.ts";
import { useUiScale } from "../device/settings.ts";
import { useDicePanel } from "../dice/useDicePanel.ts";
import { useSrdBlocks } from "../monsters/srdBlocks.ts";
import { focusOutlineRow } from "../outliner/focus.ts";
import type { OutlineRow } from "../outliner/rows.ts";
import type { PanelsForOptions } from "../panels.ts";
import { dmCatalog, type DmCatalogState } from "./dmCatalog.ts";
import type { SearchAct, SearchEntry, SearchRoute } from "./entry.ts";
import { buildIndex, catalogsFor, recordPage, searchResults, type KeySource, type SearchResults } from "./index.ts";
import { fold, parseQuery } from "./match.ts";
import { loadRecentPicks, recentPicksSlot, rememberPick } from "./recent.ts";
import { openAt } from "./route.ts";
import { KIND_LABEL } from "./words.ts";

/*
 * The room search's sheet (designs/qol/search.md 5.1, 5.2, 5.5 to 5.8 and
 * 6): the field and its ranked list over the room, opened by Ctrl+K or
 * Cmd+K, the top bar's Search and the field atop a phone's Panels list.
 * On a computer it is a dialog under the top bar, on a phone a sheet over
 * the whole screen with the field at its top. What it finds is the
 * index's (index.ts), what a result does the route's and the surfaces'
 * own: a press goes through the real control (route.ts openAt), and only
 * a condition and a menu item run a function, each the very one its own
 * surface calls. The sheet sends no op of its own.
 */

/** Every word the sheet shows (search.md 5.7). A menu item's row takes the menu's own words (chipWords.ts). */
export const SEARCH_WORDS = {
  /** The dialog's name and the top bar button's words. */
  name: "Search",
  placeholder: (role: "dm" | "player") => (role === "dm" ? "Search panels, settings, actions, tokens…" : "Search panels, settings, your character…"),
  panelsField: "Search panels, settings and the room",
  recent: "Recent",
  suggested: "Suggested",
  results: "Results",
  noMatch: (typed: string) => `No match for “${typed}”.`,
  cancel: "Cancel",
  close: "Close search",
  loadingDm: "Loading the DM's results…",
  loadingMonsters: "Loading monsters…",
  failed: "Some results could not load.",
  /** The polite status once typing stops: how many rows show, never what is left out (search.md 5.9). */
  count: (n: number) => (n === 0 ? "No match" : n === 1 ? "1 result" : `${n} results`),
  /** The computer's foot, the keys inside the search. */
  move: "Move",
  go: "Go or do",
  goOnly: "Only go there",
  /** The key on the top bar's Search, as a keyboard prints it. */
  keycap: (apple: boolean) => (apple ? "⌘K" : "Ctrl K"),
} as const;

/** How long typing must stop before the status says the count, so a screen reader is not read every keystroke's. */
export const STATUS_DELAY_MS = 500;

/** Below this layout width the search is a sheet over the whole screen (components/Dialog.tsx DIALOG_PHONE_MAX). */
export const SHEET_MAX = 600;

/** The dialog's width on a computer (search.md 5.1). */
export const DIALOG_PX = 640;

/** The field-like Search in the top bar, a fixed width so the bar's give-way, not a squeeze, turns it into its icon (topBarFit.ts step 0). */
export const BAR_FIELD_PX = 240;

/** A result row's height, a touch target with its two lines (search.md 6). */
const ROW_PX = 52;

/** The pill's height inside the top bar's 44 px target, as the chips' (pages/ChipMenus.tsx). */
const PILL_PX = 28;

// ---------------------------------------------------------------- what a row says

/** The row's second line: its kind, then where it lives or its description, and its value: "Field · Bree: Darkvision 60 ft.". */
export function rowDetail(entry: Pick<SearchEntry, "kind" | "where" | "value" | "description">): string {
  const place = entry.description ?? entry.where;
  const shown = entry.value ? (place ? `${place}: ${entry.value}` : entry.value) : place;
  return shown ? `${KIND_LABEL[entry.kind]} · ${shown}` : KIND_LABEL[entry.kind];
}

export type TitlePart = { text: string; bold: boolean };

/**
 * The title with the start of each typed word in bold (search.md 5.2).
 * Folding drops accents, apostrophes and punctuation, so the letters shown
 * are found by folding the word letter by letter: "Bree's" for "bree"
 * bolds "Bree".
 */
export function markedTitle(title: string, words: readonly string[]): TitlePart[] {
  const out: TitlePart[] = [];
  const push = (text: string, bold: boolean) => {
    if (text === "") return;
    const last = out.at(-1);
    if (last && last.bold === bold) last.text += text;
    else out.push({ text, bold });
  };
  for (const part of title.split(/(\s+)/)) {
    const folded = fold(part);
    const typed = folded === "" ? undefined : words.filter((w) => folded.startsWith(w)).sort((a, b) => b.length - a.length)[0];
    if (!typed) {
      push(part, false);
      continue;
    }
    let lead = 0;
    while (lead < part.length && fold(part.slice(0, lead + 1)) === "") lead++;
    let cut = part.length;
    for (let i = lead + 1; i <= part.length; i++) {
      if (fold(part.slice(0, i)).length >= typed.length) {
        cut = i;
        break;
      }
    }
    push(part.slice(0, lead), false);
    push(part.slice(lead, cut), true);
    push(part.slice(cut), false);
  }
  return out;
}

/** The status's words: the count once typing stops, or what an item's row says now, read at once. */
export function statusWords(results: SearchResults, said: string | null): string {
  if (said !== null) return said;
  return results.t === "typed" ? SEARCH_WORDS.count(results.rows.length) : "";
}

// ---------------------------------------------------------------- keys inside it

export type SheetKey = "up" | "down" | "go" | "goOnly" | "close" | null;

/**
 * What a key does inside the search (search.md 5.6): Up and Down move the
 * highlight while the field keeps focus and its own Home, End, Left and
 * Right, Enter goes or does, Shift+Enter only goes, Escape closes, and so
 * does the key that opened it, but for a Mac's Ctrl+K in the field, which
 * deletes to the line's end there. Nothing while an input method composes.
 */
export function sheetKey(e: Pick<KeyPress, "key" | "code" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">, opts: { composing: boolean; apple: boolean; inField: boolean }): SheetKey {
  if (opts.composing) return null;
  const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
  if (plain && !e.shiftKey && e.key === "ArrowDown") return "down";
  if (plain && !e.shiftKey && e.key === "ArrowUp") return "up";
  if (plain && e.key === "Enter") return e.shiftKey ? "goOnly" : "go";
  if (e.key === "Escape") return "close";
  if (!e.altKey && !e.shiftKey && letterOf(e) === "k" && (e.metaKey || (e.ctrlKey && !(opts.apple && opts.inField)))) return "close";
  return null;
}

/** The highlight after Up or Down: it stops at the ends, as the list does not wrap. -1 with no rows. */
export function stepActive(active: number, count: number, key: "up" | "down"): number {
  if (count === 0) return -1;
  const at = Math.min(Math.max(active, 0), count - 1);
  return key === "down" ? Math.min(at + 1, count - 1) : Math.max(at - 1, 0);
}

// ---------------------------------------------------------------- what a pick does

/** Initiative and Dice, where a condition's and a dice row's Shift+Enter go. */
const TOKEN_CONDITIONS: SearchRoute = Object.freeze({ panel: "token", section: "combat" });
const DICE: SearchRoute = Object.freeze({ panel: "dice" });

/**
 * A pick's step (search.md 5.5): a verb does it, a noun goes to it, and
 * Shift+Enter only goes. An action's route keeps its press only on Enter.
 * A menu item runs the item's own function, and goes to its twin in a
 * panel on Shift+Enter. A token is selected and framed, or its panel
 * opens. A condition goes on or off the selection, or its panel opens at
 * Conditions. A dice formula rolls, or the Dice panel opens.
 */
export type PickStep =
  | { t: "route"; route: SearchRoute }
  | { t: "key"; shortcut: string }
  | { t: "token"; tokenId: string }
  | { t: "tokenPanel"; tokenId: string }
  | { t: "condition"; condition: string; remove: boolean }
  | { t: "item"; itemId: string }
  | { t: "roll"; formula: string };

function onlyGoes(route: SearchRoute): SearchRoute {
  if (!route.press) return route;
  const { press: _press, ...rest } = route;
  return rest;
}

export function pickStep(act: SearchAct, only: boolean): PickStep {
  switch (act.t) {
    case "open":
      return { t: "route", route: only ? onlyGoes(act.route) : act.route };
    case "key":
      return { t: "key", shortcut: act.shortcut };
    case "token":
      return only ? { t: "tokenPanel", tokenId: act.tokenId } : { t: "token", tokenId: act.tokenId };
    case "character":
      return { t: "route", route: act.route ?? { panel: "characters", page: recordPage("character", act.characterId) } };
    case "condition":
      return only ? { t: "route", route: TOKEN_CONDITIONS } : { t: "condition", condition: act.condition, remove: act.remove };
    case "item":
      return only ? { t: "route", route: onlyGoes(act.twin) } : { t: "item", itemId: act.itemId };
    case "roll":
      return only ? { t: "route", route: DICE } : { t: "roll", formula: act.formula };
  }
}

/**
 * The op a condition's pick sends: the one the token bar's Conditions picker
 * sends (canvas/TokenActionBar.tsx toggleEffect), Exhaustion at level 1.
 * Read against the creature as it is now, so a row built before another
 * device took the condition off adds nothing twice and removes nothing
 * gone. Null where it would change nothing.
 */
export function conditionOp(effects: readonly Pick<Effect, "id" | "key">[], step: { condition: string; remove: boolean }, target: ActorTarget, newId: () => string): ClientOp | null {
  const existing = effects.find((e) => e.key === step.condition);
  if (step.remove) return existing ? { t: "actor.effect.remove", target, effectId: existing.id } : null;
  if (existing) return null;
  const key = step.condition as Effect["key"];
  return { t: "actor.effect.add", target, effect: { id: newId(), key, ...(key === "exhaustion" ? { level: 1 } : {}) } };
}

/** The selection's effects and its target, for a condition's pick: the token's own creature, or the character it stands for. */
function selectionEffects(s: Pick<RoomView, "view" | "local">): { effects: readonly Effect[]; target: ActorTarget } | null {
  const id = s.local.selectedId;
  const token = id ? s.view?.tokens[id] : undefined;
  if (!token) return null;
  const actor = "inline" in token.actor ? token.actor.inline : s.view?.characters[token.actor.ref]?.actor;
  return { effects: actor?.effects ?? [], target: { tokenId: token.id } };
}

/** A token as the outliner's tap takes it (outliner/focus.ts), so the search frames it the same way: Find my token's framing, then its action bar. */
function tokenRow(s: Pick<RoomView, "view">, tokenId: string): OutlineRow | null {
  const t = s.view?.tokens[tokenId];
  if (!t) return null;
  const fp = footprint(t);
  return { key: `token:${t.id}`, group: "tokens", kind: "token", id: t.id, name: t.name, detail: "", mark: null, rect: { x: t.x, y: t.y, width: fp.w, height: fp.h }, search: "" };
}

/** A key's press as the search runs it: no key of its own, so a row that reads the press finds none. */
const NO_PRESS: KeyPress = { key: "", code: "", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, repeat: false, defaultPrevented: false, target: null };

// ---------------------------------------------------------------- what is still loading

/** The SRD monsters as the search has them, for a DM: their chunk, which the Monsters panel shares. */
export type MonstersPart = { status: "none" | "loading" | "in" | "failed"; tries: number };

export type LoadRows = {
  /** The muted rows of what is still loading, after the shared delay. */
  loading: string[];
  /** A part failed: Try again, or Reload where the browser keeps the failed module for the page's life, as Chrome does, so a second try failed at once. */
  failed: null | "retry" | "reload";
};

/**
 * What the list says about its parts (search.md 5.8): the DM's results
 * while their chunk loads, the monsters while theirs does once something is
 * typed, which is where they show, and one line for any part that failed.
 */
export function loadRows(dm: DmCatalogState, monsters: MonstersPart, typed: boolean): LoadRows {
  const loading: string[] = [];
  if (dm.status === "loading" || dm.status === "idle") loading.push(SEARCH_WORDS.loadingDm);
  if (monsters.status === "loading" && typed) loading.push(SEARCH_WORDS.loadingMonsters);
  const dmTries = dm.status === "failed" ? dm.tries : 0;
  const monsterTries = monsters.status === "failed" ? monsters.tries : 0;
  if (dmTries === 0 && monsterTries === 0) return { loading, failed: null };
  return { loading, failed: dmTries > 1 || monsterTries > 1 ? "reload" : "retry" };
}

// ---------------------------------------------------------------- a menu item's row

/** A menu item that asked first, as its row stands until a second Enter (chipMenus.ts ChipAsk). */
type Asked = { id: string; warning: string; anyway: string };

/**
 * A menu item's row as the menu draws the item (search.md 5.5,
 * chipMenus.ts asDrawn). Asked, its title is the item's confirm with the
 * warning under it. Refused, why is under it. Busy, its busy words. Null for
 * a row that is no menu item.
 */
export function itemLook(item: Pick<ChipItem, "id" | "busy" | "under" | "disabled"> | undefined, asked: Asked | null, said: ReadonlyMap<string, string>): { title?: string; under?: ChipUnder; inert: boolean } | null {
  if (!item) return null;
  if (asked?.id === item.id && !item.busy) return { title: asked.anyway, under: { text: asked.warning, tone: "warning" }, inert: false };
  const refused = said.get(item.id);
  if (refused !== undefined && !item.busy) return { under: { text: refused, tone: "danger" }, inert: item.disabled === true };
  return { ...(item.under ? { under: item.under } : {}), inert: item.busy === true || item.disabled === true };
}

// ---------------------------------------------------------------- the host

export type SearchHostProps = {
  /** From 900 px up, where the side panel stands in for the narrow-only panels (panelsFor). */
  wide: boolean;
  tools: readonly ShortcutTool[];
  /** The top bars' height over the map, the band's included, in layout px. */
  top: number;
  /** What a player's panel list waits for, as the Room has it (pages/timeSound.ts playerWaits). */
  panelOptions: PanelsForOptions;
  /** A "view as a player" preview, which has no search (D-261106-152). */
  preview: boolean;
};

/**
 * The search while it is open, in the Room page. Focus goes back to what
 * had it as the search opened, or where that has gone, such as the Panels
 * list's field, to the map's focus target (search.md 6).
 */
export function SearchSheetHost(props: SearchHostProps) {
  const scope = useRoomScope();
  const slot = scope.get(searchSheetSlot);
  const subscribe = useCallback(
    (listener: () => void) => {
      slot.listeners.add(listener);
      return () => void slot.listeners.delete(listener);
    },
    [slot],
  );
  const open = useSyncExternalStore(subscribe, () => slot.open, () => false);
  const role = useRoomView((s) => s.you?.role);
  const shown = open && role !== undefined && !props.preview;
  const opener = useRef<HTMLElement | null>(null);
  const wasShown = useRef(false);
  if (shown && !wasShown.current) {
    const active = typeof document === "undefined" ? null : document.activeElement;
    opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  const close = useCallback(() => setSearchSheet(scope, false), [scope]);
  useLayoutEffect(() => {
    const was = wasShown.current;
    wasShown.current = shown;
    if (!was || shown) return;
    // After the dialog's own return of focus, and before a route's landing, which takes it from wherever this leaves it.
    queueMicrotask(() => {
      const active = document.activeElement;
      if (active === null || active === document.body) focusMap(scope.get(mapFocusSlot));
    });
  }, [shown, scope]);
  // Opened where it cannot show, before the room said who this is: it stays shut, so the next key opens it afresh.
  useEffect(() => {
    if (open && !shown) close();
  }, [open, shown, close]);
  if (!shown || !role) return null;
  const body = { ...props, role, opener, close };
  return role === "dm" ? <DmSearch {...body} /> : <PlayerSearch {...body} />;
}

type BodyProps = SearchHostProps & { role: "dm" | "player"; opener: RefObject<HTMLElement | null>; close(): void };

/** A DM's search runs the DM menu's items (chipMenus.ts dmMenuSections). What gave way from the bar is left out: Time and Sound are panels of their own (search.md 4). */
function DmSearch(props: BodyProps) {
  const v = useDmMenuView(false, false, null);
  // A new object each render: kept as one value while what it holds stands, so the index is built again as the room changes, never on each key.
  const view = useMemo(() => v, [v.blackout, v.follow, v.viewing, v.playerScene?.id, v.playerScene?.name, v.focusHere, v.handouts, v.handoutDocs, v.members, v.recent, v.images, v.time?.text, v.nowPlaying, v.movingTo, v.revealing, v.outShown]);
  const env = useChipEnv(() => props.opener.current);
  const items = useMemo(() => itemsOf(dmMenuSections(view)), [view]);
  return <SearchDialog {...props} items={items} env={env} />;
}

/** A player's search runs only their You menu's items (chipMenus.ts youMenuSections), never a DM menu item (QD-OPUS-18). */
function PlayerSearch(props: BodyProps) {
  const memberId = useRoomView((s) => s.you?.memberId ?? "");
  const member = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId] : undefined));
  const characters = useRoomView((s) => s.view?.characters);
  const env = useChipEnv(() => props.opener.current);
  return <SearchDialog {...props} items={itemsOf(youMenuSections({ memberId, member, characters: characters ?? {}, preview: false }))} env={env} />;
}

// ---------------------------------------------------------------- the dialog

function useDmCatalog(role: "dm" | "player"): DmCatalogState {
  const subscribe = useCallback((listener: () => void) => dmCatalog.subscribe(listener), []);
  // A request in the read is safe (dmCatalog.ts): it starts a DM's load once, before the preload if that has not run, and tells no one.
  return useSyncExternalStore(subscribe, () => dmCatalog.request(role), () => dmCatalog.peek(role));
}

function SearchDialog(props: BodyProps & { items: readonly ChipItem[]; env: ChipEnv }) {
  const { role, close } = props;
  const store = useRoomStore();
  const actions = useRoomActions();
  const ui = useRoomUi();
  const scope = useRoomScope();
  const dice = useDicePanel();
  const dialog = useRef<HTMLDialogElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const ids = useId();
  const listId = `${ids}-list`;
  const rowId = (i: number) => `${ids}-row-${i}`;
  const [apple] = useState(isAppleDevice);
  useBackClose(true, close);
  useModalDialog(dialog, { onClose: close, returnFocus: props.opener });
  const scale = useUiScale();
  const keyboard = useKeyboardView();
  const sheet = useLayoutSize().width < SHEET_MAX;

  // The index, built again as the view, the scene or the selection changes (search.md 5.10).
  const view = useRoomView((s) => s.view);
  const sceneId = useRoomView((s) => s.sceneId);
  const selectedId = useRoomView((s) => s.local.selectedId);
  const you = useRoomView((s) => s.you);
  const roomId = useRoomView((s) => s.roomId);
  const dm = useDmCatalog(role);
  const catalogs = useMemo(() => catalogsFor({ you }, dmCatalog).catalogs, [you, dm]);
  const [monsterTry, setMonsterTry] = useState(0);
  const srd = useSrdBlocks(role === "dm", String(monsterTry));
  const monsters: MonstersPart = role !== "dm" ? { status: "none", tries: 0 } : srd.list ? { status: "in", tries: 0 } : srd.failed ? { status: "failed", tries: monsterTry + 1 } : { status: "loading", tries: 0 };
  const keyMap = useShortcutKeys();
  const shortcutEnv = useCallback((): ShortcutEnv => ({ role, tools: props.tools, getState: () => store.getState(), actions, ui, scope }), [role, props.tools, store, actions, ui, scope]);
  // The search's own key finds nothing in it: it would only close what it opens.
  const keys = useMemo<KeySource>(() => {
    const env = shortcutEnv();
    return { applies: (s) => s.id !== "search" && (!s.when || s.when(env)), text: (id) => keyText(id, keyMap) };
  }, [shortcutEnv, keyMap]);
  const index = useMemo(
    () => buildIndex({ state: store.getState(), wide: props.wide, panelOptions: props.panelOptions, keys, catalogs, monsters: role === "dm" ? srd.list : null }),
    // The store is read whole, so its parts the index reads are the deps.
    [store, view, sceneId, selectedId, you, props.wide, props.panelOptions, keys, catalogs, role, srd.list],
  );

  const recentStore = useScoped(recentPicksSlot);
  const memberId = you?.memberId ?? null;
  useLayoutEffect(() => {
    if (memberId) loadRecentPicks(recentStore, roomId, memberId);
  }, [recentStore, roomId, memberId]);
  const recentIds = useStore(recentStore, (s) => s.ids);

  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchResults(index, text, recentIds), [index, text, recentIds]);
  const typed = results.t === "typed";
  const rows: readonly SearchEntry[] = results.t === "typed" ? results.rows : [...results.recent, ...results.suggested];
  const at = rows.length === 0 ? -1 : Math.min(Math.max(active, 0), rows.length - 1);
  const words = useMemo(() => parseQuery(text).words, [text]);
  const load = loadRows(dm, monsters, typed);

  // A menu item's asking, its answers and its wait, kept while the search is open (search.md 5.5).
  const [asked, setAsked] = useState<Asked | null>(null);
  const [said, setSaid] = useState<ReadonlyMap<string, string>>(new Map());
  const waiting = useRef(new Set<string>());
  // Whether an answer that comes later finds the search still open. Set again on each mount, as React's development double mount runs the cleanup once between.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const itemOf = (entry: SearchEntry): ChipItem | undefined => {
    const act = entry.act;
    return act.t === "item" ? props.items.find((i) => i.id === act.itemId) : undefined;
  };

  // The status: the count once typing stops, an item's warning, refusal or wait at once.
  const activeEntry = at >= 0 ? rows[at] : undefined;
  const activeLook = activeEntry ? itemLook(itemOf(activeEntry), asked, said) : null;
  const rowSays = activeLook?.under?.text ?? null;
  const [status, setStatus] = useState("");
  const counted = statusWords(results, null);
  useEffect(() => {
    if (rowSays !== null) {
      setStatus(rowSays);
      return;
    }
    const timer = setTimeout(() => setStatus(counted), STATUS_DELAY_MS);
    return () => clearTimeout(timer);
  }, [counted, rowSays]);

  useLayoutEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-search-at="${at}"]`)?.scrollIntoView({ block: "nearest" });
  }, [at, results]);

  const settle = (id: string, answer: ChipAnswer) => {
    waiting.current.delete(id);
    if (answer.t === "taken") {
      if (mounted.current) close();
      return;
    }
    // Closed while it waited: the refusal is the room's toast, as any op's is.
    if (mounted.current) setSaid((m) => new Map(m).set(id, answer.words));
    else ui.notify(answer.words, "error");
  };

  const runItem = (itemId: string) => {
    const item = props.items.find((i) => i.id === itemId);
    if (!item || item.busy || item.disabled || waiting.current.has(itemId)) return;
    const confirmed = asked?.id === itemId;
    setAsked(null);
    setSaid((m) => {
      if (!m.has(itemId)) return m;
      const next = new Map(m);
      next.delete(itemId);
      return next;
    });
    const result = item.run(props.env, confirmed ? { confirmed: true } : undefined);
    if (result.t === "ask") {
      setAsked({ id: itemId, warning: result.warning, anyway: result.anyway });
      return;
    }
    if (result.t === "wait") {
      waiting.current.add(itemId);
      void result.answer.then((answer) => settle(itemId, answer));
      return;
    }
    // Sent, or a dialog opened, which takes focus as the search goes and hands it back to the search's opener.
    close();
  };

  const pick = (entry: SearchEntry, only: boolean) => {
    const step = pickStep(entry.act, only);
    if (step.t === "item") {
      const look = itemLook(itemOf(entry), asked, said);
      if (look?.inert) return;
    }
    // A typed dice formula's row is no entry of the index, so it is not kept (recent.ts).
    if (index.byId.has(entry.id)) rememberPick(recentStore, entry.id);
    switch (step.t) {
      case "route":
        // The landing comes in a microtask after this commit, after the focus the closing dialog hands back (route.ts).
        openAt(scope, ui, step.route);
        close();
        return;
      case "item":
        runItem(step.itemId);
        return;
      case "roll":
        // As the Dice panel's Roll, with its next-roll choices, then the panel, where the roll's line shows.
        dice.roll([{ formula: step.formula }]);
        openAt(scope, ui, DICE);
        close();
        return;
      case "tokenPanel":
        ui.select(step.tokenId);
        ui.showActions(false);
        openAt(scope, ui, { panel: "token" });
        close();
        return;
    }
    // The rest act on the map or as a key would, once the search has gone and given focus back.
    flushSync(close);
    const s = store.getState();
    if (step.t === "key") {
      const shortcut = SHORTCUTS.find((x) => x.id === step.shortcut);
      const env = shortcutEnv();
      if (shortcut && (!shortcut.when || shortcut.when(env))) shortcut.run(env, NO_PRESS);
    } else if (step.t === "token") {
      const row = tokenRow(s, step.tokenId);
      if (!row || !s.sceneId || !s.view) return;
      // On a phone the panel's sheet goes first, so the token is not under it, as the outliner's tap does.
      if (!props.wide) ui.closePanel();
      focusOutlineRow(row, { scope, ui, actions, sceneId: s.sceneId, tokens: s.view.tokens });
    } else {
      const on = selectionEffects(s);
      const op = on ? conditionOp(on.effects, step, on.target, () => actions.newId()) : null;
      if (op) actions.dispatch(op);
    }
  };

  const change = (next: string) => {
    setText(next);
    setActive(0);
    setAsked(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const key = sheetKey(e, { composing: e.nativeEvent.isComposing, apple, inField: e.target === field.current });
    if (key === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (key === "close") close();
    else if (key === "up" || key === "down") {
      setAsked(null);
      setActive(stepActive(at, rows.length, key));
    } else if (activeEntry) pick(activeEntry, key === "goOnly");
  };

  const renderRow = (entry: SearchEntry, i: number) => {
    const look = itemLook(itemOf(entry), asked, said);
    return (
      <ResultRow
        key={entry.id}
        id={rowId(i)}
        at={i}
        entry={entry}
        title={look?.title ?? entry.title}
        under={look?.under}
        active={i === at}
        words={words}
        onHover={() => {
          if (i !== at) {
            setAsked(null);
            setActive(i);
          }
        }}
        onPick={() => {
          setActive(i);
          pick(entry, false);
        }}
      />
    );
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: theme.space(2), padding: sheet ? `${theme.space(2)}px ${theme.space(2)}px ${theme.space(2)}px ${theme.space(4)}px` : `${theme.space(2.5)}px ${theme.space(2)}px ${theme.space(2.5)}px ${theme.space(4)}px`, borderBottom: `${theme.line.border}px solid ${theme.color.border}` }}>
      <span aria-hidden style={{ display: "flex", color: theme.color.textMuted }}>
        <Icon name="search" />
      </span>
      <input
        ref={field}
        autoFocus
        type="text"
        role="combobox"
        aria-label={SEARCH_WORDS.name}
        aria-expanded={rows.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={at >= 0 ? rowId(at) : undefined}
        enterKeyHint="go"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={SEARCH_WORDS.placeholder(role)}
        value={text}
        onChange={(e) => change(e.target.value)}
        data-search-field=""
        style={{ flex: "1 1 auto", minWidth: 0, height: theme.touch, padding: 0, border: "none", outline: "none", background: "transparent", color: theme.color.text, fontFamily: theme.font.body, fontSize: theme.font.input }}
      />
      {sheet ? (
        <button type="button" onClick={close} style={{ ...BARE, height: theme.touch, minWidth: theme.touch, padding: `0 ${theme.space(3)}px`, color: theme.color.text, fontSize: theme.font.input, fontWeight: theme.weight.strong }}>
          {SEARCH_WORDS.cancel}
        </button>
      ) : (
        <button type="button" aria-label={SEARCH_WORDS.close} aria-keyshortcuts="Escape" onClick={close} style={{ ...BARE, display: "grid", placeItems: "center", height: theme.touch, minWidth: theme.touch }}>
          <Keycap>Esc</Keycap>
        </button>
      )}
    </div>
  );

  const body = (
    <div ref={list} style={{ flex: sheet ? "1 1 auto" : "0 1 auto", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain", padding: theme.space(2) }}>
      <SearchList
        ids={ids}
        listId={listId}
        results={results}
        text={text}
        load={load}
        row={renderRow}
        retry={() => {
          if (dm.status === "failed") dmCatalog.retry(role);
          if (monsters.status === "failed") setMonsterTry((n) => n + 1);
        }}
        focusTo={() => field.current}
        reload={<SearchReload />}
      />
    </div>
  );

  const foot = sheet ? null : (
    <div aria-hidden style={{ display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: theme.space(4), rowGap: theme.space(1), padding: `${theme.space(2)}px ${theme.space(4)}px`, borderTop: `${theme.line.border}px solid ${theme.color.border}`, color: theme.color.textMuted, fontSize: theme.font.small, lineHeight: theme.leading.body }}>
      <Hint keys={["↑", "↓"]}>{SEARCH_WORDS.move}</Hint>
      <Hint keys={["Enter"]}>{SEARCH_WORDS.go}</Hint>
      <Hint keys={["Shift Enter"]}>{SEARCH_WORDS.goOnly}</Hint>
    </div>
  );

  const top = `calc(${theme.safe.top} + ${props.top + theme.space(3)}px)`;
  const card: CSSProperties = sheet
    ? { position: "absolute", inset: 0, display: "flex", flexDirection: "column", paddingTop: theme.safe.top, paddingLeft: theme.safe.left, paddingRight: theme.safe.right, background: theme.color.surface }
    : {
        position: "absolute",
        top,
        left: 0,
        right: 0,
        marginInline: "auto",
        width: `min(${DIALOG_PX}px, calc(100% - ${theme.space(8)}px))`,
        maxHeight: `calc(100% - ${props.top + theme.space(9)}px - ${theme.safe.top})`,
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        background: theme.color.surface,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.lg,
        boxShadow: theme.shadow.dialog,
        overflow: "hidden",
      };

  return createPortal(
    <dialog
      ref={dialog}
      aria-modal="true"
      aria-label={SEARCH_WORDS.name}
      tabIndex={-1}
      data-search-sheet={sheet ? "sheet" : "dialog"}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      onKeyDown={onKeyDown}
      style={{
        // Drawn before showModal runs, as Dialog's is, so the field's autoFocus takes focus in the commit, inside the tap that opened it, and a phone raises its keyboard.
        display: "block",
        position: "fixed",
        // The dialog's own px are zoomed by the interface size (useModalDialog), the keyboard's are the page's: the list ends at the keyboard.
        inset: keyboard ? `${keyboard.top / scale}px 0 ${keyboard.inset / scale}px` : 0,
        width: "100%",
        height: keyboard ? "auto" : "100%",
        maxWidth: "none",
        maxHeight: "none",
        margin: 0,
        padding: 0,
        border: "none",
        background: sheet ? theme.color.surface : theme.color.scrim,
        boxShadow: statusBand(scale),
        fontFamily: theme.font.body,
        color: theme.color.text,
        outline: "none",
        overflow: "hidden",
      }}
    >
      <section style={card}>
        {header}
        {body}
        {foot}
        <div role="status" style={VISUALLY_HIDDEN}>
          {status}
        </div>
      </section>
    </dialog>,
    document.body,
  );
}

/** The reload a failed module asks for (components/LoadBoundary.tsx ReloadButton), once Try again could not work. */
function SearchReload() {
  const pending = useRoomView((s) => s.pending.length);
  const connection = useRoomView((s) => s.connection);
  return <ReloadButton pending={pending} connection={connection} />;
}

/** Groups of the list: Recent then Suggested on an empty field, or the one ranked list, each with the index of its first row. */
export function listGroups(results: SearchResults): { key: string; label: string | null; from: number; entries: readonly SearchEntry[] }[] {
  if (results.t === "typed") return [{ key: "typed", label: null, from: 0, entries: results.rows }];
  return [
    ...(results.recent.length > 0 ? [{ key: "recent", label: SEARCH_WORDS.recent, from: 0, entries: results.recent }] : []),
    ...(results.suggested.length > 0 ? [{ key: "suggested", label: SEARCH_WORDS.suggested, from: results.recent.length, entries: results.suggested }] : []),
  ];
}

/**
 * The list and what it says under its rows (search.md 5.2 and 5.8): the
 * listbox, "No match", the muted rows of what is still loading, after the
 * shared delay, and the line of a part that failed with its way out.
 */
export function SearchList(props: {
  ids: string;
  listId: string;
  results: SearchResults;
  text: string;
  load: LoadRows;
  row(entry: SearchEntry, at: number): ReactNode;
  retry(): void;
  /** Where Try again hands focus as its line goes. */
  focusTo(): HTMLElement | null;
  reload: ReactNode;
  /** The loading rows' delay, the shared indicator's unless a test says. */
  loadDelay?: number;
}) {
  const { results, load } = props;
  const inset = `${theme.space(2)}px ${theme.space(3) + theme.line.border}px`;
  return (
    <>
      <div id={props.listId} role="listbox" aria-label={SEARCH_WORDS.results}>
        {listGroups(results).map((g) =>
          g.label === null ? (
            g.entries.map((entry, n) => props.row(entry, g.from + n))
          ) : (
            <div key={g.key} role="group" aria-labelledby={`${props.ids}-${g.key}`}>
              <ListLabel id={`${props.ids}-${g.key}`}>{g.label}</ListLabel>
              {g.entries.map((entry, n) => props.row(entry, g.from + n))}
            </div>
          ),
        )}
      </div>
      {results.t === "typed" && results.rows.length === 0 ? (
        <p data-search-none="" style={{ margin: 0, padding: `${theme.space(3)}px ${theme.space(3) + theme.line.border}px`, color: theme.color.textMuted, fontSize: theme.font.body14, lineHeight: theme.leading.body }}>
          {SEARCH_WORDS.noMatch(props.text.trim())}
        </p>
      ) : null}
      {load.loading.map((words) => (
        // No box of its own until the line shows, so a quick load leaves no gap.
        <div key={words} data-search-loading="">
          <Loading small text={words} {...(props.loadDelay !== undefined ? { delay: props.loadDelay } : null)} style={{ display: "flex", padding: inset }} />
        </div>
      ))}
      {load.failed ? (
        <div data-search-failed={load.failed} style={{ padding: inset }}>
          {load.failed === "reload" ? (
            <LoadFailed reload={props.reload}>{SEARCH_WORDS.failed}</LoadFailed>
          ) : (
            <LoadFailed retry={props.retry} focusTo={props.focusTo}>
              {SEARCH_WORDS.failed}
            </LoadFailed>
          )}
        </div>
      ) : null}
    </>
  );
}

const BARE: CSSProperties = { flex: "none", border: `${theme.line.border}px solid transparent`, borderRadius: theme.radius.md, background: "transparent", fontFamily: theme.font.body, cursor: "pointer" };

function ListLabel(props: { id: string; children: ReactNode }) {
  // In by the rows' padding and border, so the label starts where their icons do.
  return (
    <div id={props.id} role="presentation" style={{ padding: `${theme.space(2)}px ${theme.space(3) + theme.line.border}px`, fontSize: theme.font.small, fontWeight: theme.weight.bold, letterSpacing: theme.caps, textTransform: "uppercase", lineHeight: theme.leading.body, color: theme.color.textMuted }}>
      {props.children}
    </div>
  );
}

function Keycap(props: { children: ReactNode }) {
  return (
    <kbd
      style={{
        flex: "none",
        display: "inline-block",
        fontFamily: theme.font.body,
        fontSize: theme.font.tiny,
        fontWeight: theme.weight.strong,
        lineHeight: "18px",
        padding: `0 ${theme.space(1.5)}px`,
        border: `${theme.line.border}px solid ${theme.color.border}`,
        borderRadius: theme.radius.xs,
        color: theme.color.textMuted,
        background: theme.color.surfaceRaised,
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
    </kbd>
  );
}

function Hint(props: { keys: readonly string[]; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: theme.space(1) }}>
      {props.keys.map((k) => (
        <Keycap key={k}>{k}</Keycap>
      ))}
      <span>{props.children}</span>
    </span>
  );
}

/** One result (search.md 5.2): its kind's icon, the title with the typed starts in bold and a mark, the second line, the key that does the same, and a menu item's line under. */
export function ResultRow(props: { id: string; at: number; entry: SearchEntry; title: string; under?: ChipUnder | undefined; active: boolean; words: readonly string[]; onHover(): void; onPick(): void }) {
  const { entry } = props;
  const line: CSSProperties = { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
  return (
    <div
      id={props.id}
      role="option"
      aria-selected={props.active}
      data-search-at={props.at}
      data-search-row={entry.id}
      data-search-kind={entry.kind}
      onPointerMove={props.onHover}
      // The field keeps focus, so a tap that does not close the search, such as a move's warning, leaves the keyboard up.
      onMouseDown={(e) => e.preventDefault()}
      onClick={props.onPick}
      style={{
        display: "grid",
        gridTemplateColumns: `${theme.icon.md}px minmax(0, 1fr) auto`,
        alignItems: "center",
        columnGap: theme.space(3),
        minHeight: ROW_PX,
        boxSizing: "border-box",
        padding: `${theme.space(1.5)}px ${theme.space(3)}px`,
        borderRadius: theme.radius.md,
        border: `${theme.line.border}px solid ${props.active ? theme.color.accent : "transparent"}`,
        background: props.active ? theme.color.accentTint : "transparent",
        cursor: "pointer",
      }}
    >
      <span style={{ display: "flex", color: theme.color.textMuted }}>
        <Icon name={entry.icon} />
      </span>
      <span style={{ display: "grid", minWidth: 0 }}>
        <span style={{ ...line, fontSize: theme.font.input, lineHeight: theme.leading.tight, color: theme.color.text }}>
          {props.title === entry.title ? (
            markedTitle(entry.title, props.words).map((p, i) =>
              p.bold ? (
                <strong key={i} style={{ fontWeight: theme.weight.bold }}>
                  {p.text}
                </strong>
              ) : (
                <span key={i}>{p.text}</span>
              ),
            )
          ) : (
            <span>{props.title}</span>
          )}
          {entry.mark ? <span style={{ marginInlineStart: theme.space(2), fontSize: theme.font.small, color: theme.color.textMuted }}>{entry.mark}</span> : null}
        </span>
        <span style={{ ...line, fontSize: theme.font.small, lineHeight: theme.leading.tight, color: theme.color.textMuted }}>{rowDetail(entry)}</span>
        {props.under ? <Under under={props.under} /> : null}
      </span>
      {entry.keys ? <Keycap>{entry.keys}</Keycap> : <span />}
    </div>
  );
}

/** A menu item's line under its row, as the menu draws it (pages/ChipMenus.tsx underLine): the warning, a refusal, or the shared wait. Read through the sheet's status. */
function Under(props: { under: ChipUnder }) {
  const { under } = props;
  if (under.tone === "busy") return <Loading small delay={0} live={false} text={under.text} />;
  return <span style={{ fontSize: theme.font.small, lineHeight: theme.leading.body, whiteSpace: "normal", overflowWrap: "break-word", color: under.tone === "warning" ? theme.color.warning : theme.color.dangerText }}>{under.text}</span>;
}

// ---------------------------------------------------------------- the ways in

function useOpenSearch(): (before?: () => void) => void {
  const scope = useRoomScope();
  // At once, inside the tap: a phone raises its keyboard only for a field focused in the gesture itself.
  return useCallback((before) => flushSync(() => {
    before?.();
    setSearchSheet(scope, true);
  }), [scope]);
}

/**
 * The top bar's Search (search.md 5.1, plan.md 4): a field-like button with
 * the magnifier, "Search" and its key, or the 44 px magnifier the give-way
 * leaves (pages/topBarFit.ts). Its tooltip and `aria-keyshortcuts` take the
 * key from the shortcut table, so a touch screen with no keyboard names
 * none.
 */
export function SearchButton(props: { form: "field" | "icon" }) {
  const open = useOpenSearch();
  const hint = useKeyHint("search");
  const tip = withKey(SEARCH_WORDS.name, hint);
  const tooltip = useTooltip(tip, { describes: addsWords(tip, SEARCH_WORDS.name) });
  const [apple] = useState(isAppleDevice);
  const common = { type: "button" as const, "aria-label": SEARCH_WORDS.name, "aria-keyshortcuts": hint?.aria, "data-search-open": "bar", "data-search-form": props.form, onClick: () => open() };
  if (props.form === "icon") {
    return (
      <>
        <button {...common} {...tooltip.anchor()} style={{ ...BARE, display: "grid", placeItems: "center", width: theme.touch, height: theme.touch, padding: 0, color: theme.color.text }}>
          <Icon name="search" />
        </button>
        {tooltip.tip}
      </>
    );
  }
  return (
    <>
      <button {...common} {...tooltip.anchor()} style={{ flex: "none", display: "flex", alignItems: "center", width: BAR_FIELD_PX, height: theme.touch, padding: 0, border: 0, background: "transparent", color: theme.color.textMuted, cursor: "pointer", font: "inherit" }}>
        <span
          style={{
            flex: "1 1 auto",
            display: "flex",
            alignItems: "center",
            gap: theme.space(2),
            minWidth: 0,
            height: PILL_PX,
            boxSizing: "border-box",
            padding: `0 ${theme.space(1)}px 0 ${theme.space(2.5)}px`,
            border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
            borderRadius: theme.radius.md,
            background: theme.color.surface,
            fontSize: theme.font.body14,
          }}
        >
          <Icon name="search" size="sm" />
          <span style={{ flex: "1 1 auto", minWidth: 0, textAlign: "start", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{SEARCH_WORDS.name}</span>
          {hint ? <Keycap>{SEARCH_WORDS.keycap(apple)}</Keycap> : null}
        </span>
      </button>
      {tooltip.tip}
    </>
  );
}

/**
 * The field atop a phone's Panels list (search.md 5.1, P1), always there:
 * a tap closes the list and opens the search with the keyboard up. It is a
 * button that looks like a field, so the list itself never raises a
 * keyboard.
 */
export function PanelsSearchField(props: { onOpen(): void }) {
  const open = useOpenSearch();
  return (
    <button
      type="button"
      data-search-open="panels"
      onClick={() => open(props.onOpen)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: theme.space(2),
        width: "100%",
        height: theme.touch,
        boxSizing: "border-box",
        marginBottom: theme.space(3),
        padding: `0 ${theme.space(3)}px`,
        border: `${theme.line.border}px solid ${theme.color.controlBorder}`,
        borderRadius: theme.radius.md,
        background: theme.color.bg,
        color: theme.color.textMuted,
        fontFamily: theme.font.body,
        fontSize: theme.font.input,
        cursor: "pointer",
      }}
    >
      <Icon name="search" size="sm" />
      <span style={{ flex: "1 1 auto", minWidth: 0, textAlign: "start", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{SEARCH_WORDS.panelsField}</span>
    </button>
  );
}
