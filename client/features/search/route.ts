import { useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import { createStore, type StoreApi } from "zustand/vanilla";
import {
  DM_PANEL_SECTIONS,
  dmPanelFoldsSlot,
  SCENES_SECTIONS,
  scenesFoldsSlot,
  SOUND_SECTIONS,
  soundFoldsSlot,
  THIS_DEVICE_SECTIONS,
  thisDeviceFoldsSlot,
  type DmPanelSection,
  type ScenesSection,
  type SoundSection,
  type ThisDeviceSection,
} from "../../lib/folds.ts";
import { startInScrollBox } from "../../lib/reveal.ts";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped, type RoomScope } from "../../state/scope.ts";
import type { RoomUi } from "../../state/store.ts";
import type { PanelHow } from "../../state/types.ts";
import { journalSlot } from "../journal/store.ts";
import { canonicalPanelId, SOUND_PANEL, takeOverPanelScroll } from "../panels.ts";
import { openSoundNow, soundViewSlot, type SoundView } from "../sound/music/open.ts";
import { characterPageSlot, openCharacterPage } from "../tokens/characterPage.ts";
import { FOLD_KEYS, PAGE_FOLD_KEYS, panelFoldsSlot, type FoldKey, type RelationFold } from "../tokens/panelFolds.ts";
import { searchSelector, type SearchRoute } from "./entry.ts";

/*
 * The route (designs/qol/search.md 5.5, D-261106-150): the one way to open
 * a panel at a page, a section and a control, for the search and for any
 * QOL action that opens a panel at a section. Modeled on the Ambiance
 * panel's request, which the sound layout removed: blur a field typed in
 * the panel, open the folds on the way for now, turn the page, publish a
 * request that the panels with pages read, then open the panel. Room lands
 * focus on the control once the panel draws it (pages/Room.tsx focusNext's
 * kind `anchor`), after the panel's own focus placement, with no waits.
 */

/** A route as published, `seq` telling one request from the next, so the same route asked twice acts twice. */
export type RouteRequest = SearchRoute & { readonly seq: number };

/**
 * What Room lends the route while it is mounted, as it lends
 * panelFocusSlot's focus (pages/mapFocus.ts): which panels the viewer may
 * open now, and the ask for focus on the route's landing.
 */
export type RouteRoom = {
  /** The panels Room offers this viewer now (features/panels.ts panelsFor), so a player's route never opens a DM's panel. */
  offers(panelId: string): boolean;
  /** Blurs a field typed in that panel, which a change of page could unmount unsaved, and asks for focus on the landing. */
  ask(request: RouteRequest): void;
};

export type RouteSlot = {
  readonly store: StoreApi<{ readonly request: RouteRequest | null }>;
  /** The last request each panel took, so a panel that mounts after a request takes it once, and a remount never again. */
  readonly taken: Map<string, number>;
  seq: number;
  room: RouteRoom | null;
};

/** Per Room page (state/scope.ts), so a route in "view as a player" never reaches the DM's own panels. */
export const routeSlot = scopeSlot<RouteSlot>(() => ({ store: createStore(() => ({ request: null })), taken: new Map(), seq: 0, room: null }));

/**
 * Opens `route.panel` at its page, its section and its control. True when
 * it did. A panel the viewer may not open, or a Room not mounted, does
 * nothing at all: no fold opens and no page turns.
 *
 * Only the newest request counts: a second one before the first has landed
 * takes its place. `how` places the panel, as `ui.openPanel` takes it, for
 * a press inside another panel.
 */
export function openAt(scope: RoomScope, ui: Pick<RoomUi, "openPanel">, route: SearchRoute, how?: PanelHow): boolean {
  const slot = scope.get(routeSlot);
  const panel = canonicalPanelId(route.panel);
  const room = slot.room;
  if (!room?.offers(panel)) return false;
  slot.seq += 1;
  const request: RouteRequest = { ...route, panel, seq: slot.seq };
  room.ask(request);
  if (request.section !== undefined) revealOnRoute(scope, request.panel, request.page, request.section);
  turnPage(scope, request);
  slot.store.setState({ request });
  const view = panel === SOUND_PANEL ? soundView(request.page) : null;
  if (view) {
    // Open Sound's own way in (music/open.ts), which leaves a Sound subpage through its Back and shows the view's top.
    openSoundNow(scope, ui);
    if (view === "library") scope.get(soundViewSlot).setState({ view });
    if (how) ui.openPanel(panel, how);
  } else ui.openPanel(panel, how);
  return true;
}

/** The route to Sound's Now playing at its top, as the Now playing chip's Open Sound opens it (lane SL-C). */
export const NOW_PLAYING: SearchRoute = Object.freeze({ panel: SOUND_PANEL, page: "now" });

/* Pages. */

/** A record's page, "<kind>:<id>", as the search's index writes it (index.ts recordPage). */
export function recordPage(kind: string, id: string): string {
  return `${kind}:${id}`;
}

/** The id in a record's page of this kind, or null for any other page or none. */
export function recordId(kind: string, page: string | undefined): string | null {
  const head = `${kind}:`;
  return page !== undefined && page.startsWith(head) && page.length > head.length ? page.slice(head.length) : null;
}

/** Menu's subpages (panels/MenuPanel.tsx), each its own subpage's header id. Room settings is a DM's alone. */
export const MENU_PAGES = ["members", "settings", "about", "device"] as const;
export type MenuPage = (typeof MENU_PAGES)[number];

/**
 * A paged panel's page after a request (panels/MenuPanel.tsx): the page it
 * names, if the panel has it for this viewer, or the panel's first page
 * for a control there, else the page it shows.
 */
export function pageAfter<P extends string>(request: Pick<SearchRoute, "page" | "anchor">, pages: readonly P[], current: P | null): P | null {
  if (request.page !== undefined) return pages.find((p) => p === request.page) ?? current;
  return request.anchor !== undefined ? null : current;
}

/**
 * The pages the route turns from outside, through the slots the panels
 * already read (characterPage.ts, journal/store.ts): a character's page or
 * a journal page by id, or the list for a control on it. Opening a
 * character's page from outside makes a form in the panel leave, asking
 * first when it holds typed changes.
 */
function turnPage(scope: RoomScope, request: RouteRequest): void {
  const toList = request.page === undefined && request.anchor !== undefined;
  if (request.panel === "characters") {
    const store = scope.get(characterPageSlot);
    const id = recordId("character", request.page);
    if (id !== null) openCharacterPage(store, id);
    else if (toList) store.setState((s) => ({ characterId: null, opened: s.opened + 1 }));
  } else if (request.panel === "journal") {
    const id = recordId("page", request.page);
    if (id !== null || toList) scope.get(journalSlot).setState({ pageId: id });
  }
}

/** Sound's view a route names (docs/design/design-v1-sound-layout.md 4.1): Now playing, or Library, where a playlist and a track live. */
function soundView(page: string | undefined): SoundView | null {
  if (page === "now") return "now";
  if (page === "library" || recordId("playlist", page) !== null || recordId("track", page) !== null) return "library";
  return null;
}

/* Folds. */

/** The token panel's own folds, by the names a route gives them: the viewer's own relation (panelFolds.ts relationKey). */
const TOKEN_FOLDS: readonly FoldKey[] = FOLD_KEYS.filter((k) => !k.startsWith("other.") && !(PAGE_FOLD_KEYS as readonly string[]).includes(k));

/** A character's page's folds: its own, and the stat block's, which it shares with the token panel. */
const PAGE_FOLDS: readonly FoldKey[] = [...PAGE_FOLD_KEYS, "statBlock"];

/** The folds kept apart by relation (panelFolds.ts RelationFold): a route opens the viewer's own and another creature's alike. */
const RELATION_FOLDS: readonly string[] = ["statBlock", "combat", "notes"] satisfies RelationFold[];

const NO_FOLDS: readonly string[] = [];

/**
 * The folds a route may open on its way to a panel's page: lib/folds.ts's
 * surfaces (the DM panel, Scenes, Sound and This device in Menu), the
 * token panel's and a character's page's (panelFolds.ts). A route's
 * `section` names one of these, which the search's catalog test holds it
 * to (search.md 5.10).
 */
export function routeFolds(panel: string, page?: string): readonly string[] {
  switch (panel) {
    case "dm":
      return DM_PANEL_SECTIONS;
    case "scenes":
      return SCENES_SECTIONS;
    case SOUND_PANEL:
      return SOUND_SECTIONS;
    case "menu":
      return page === "device" ? THIS_DEVICE_SECTIONS : NO_FOLDS;
    case "token":
      return TOKEN_FOLDS;
    case "characters":
      return recordId("character", page) !== null ? PAGE_FOLDS : NO_FOLDS;
    default:
      return NO_FOLDS;
  }
}

/**
 * Opens a section on the way, for now and never written (lib/folds.ts
 * reveal): a DM who folded it on purpose finds it folded again once its
 * panel closes. A section the panel does not fold is left alone.
 */
function revealOnRoute(scope: RoomScope, panel: string, page: string | undefined, section: string): void {
  if (!routeFolds(panel, page).includes(section)) return;
  switch (panel) {
    case "dm":
      scope.get(dmPanelFoldsSlot).reveal(section as DmPanelSection);
      return;
    case "scenes":
      scope.get(scenesFoldsSlot).reveal(section as ScenesSection);
      return;
    case SOUND_PANEL:
      scope.get(soundFoldsSlot).reveal(section as SoundSection);
      return;
    case "menu":
      scope.get(thisDeviceFoldsSlot).reveal(section as ThisDeviceSection);
      return;
    default: {
      const folds = scope.get(panelFoldsSlot);
      folds.reveal(section as FoldKey);
      if (panel === "token" && RELATION_FOLDS.includes(section)) folds.reveal(`other.${section}` as FoldKey);
    }
  }
}

/* The panels' side. */

/** The newest request for `panel` that it has not taken yet, marked taken. Null when there is none. */
export function takeRequest(slot: RouteSlot, panel: string): RouteRequest | null {
  const request = slot.store.getState().request;
  if (!request || request.panel !== panel || slot.taken.get(panel) === request.seq) return null;
  slot.taken.set(panel, request.seq);
  return request;
}

/**
 * A paged panel's read of the route (search.md 5.5): `take` hears each new
 * request for `panel` once, as the panel draws, a request made before it
 * mounted included, so a panel that loads its code on the route's open
 * still turns to the page.
 */
export function useRouteRequest(panel: string, take: (request: RouteRequest) => void): void {
  const slot = useScoped(routeSlot);
  const request = useStore(slot.store, (s) => (s.request?.panel === panel ? s.request : null));
  const latest = useRef(take);
  latest.current = take;
  useLayoutEffect(() => {
    if (!request) return;
    const taken = takeRequest(slot, panel);
    if (taken) latest.current(taken);
  }, [slot, panel, request]);
}

/** The attribute a row that stands for a record's page carries, its value that page: a scene's row in Scenes. */
export const SEARCH_PAGE_ATTR = "data-search-page";

/* Room's side: where focus lands. */

/** What Room reads of a panel as it lands a route: the pane or sheet the panel draws in while on screen, and the id of the subpage it shows. */
export type RouteView = {
  container: Pick<ParentNode, "querySelector"> | null;
  /** The panel's subpage header id (features/panels.ts PanelHeader), null on its first page. */
  subpage: string | null;
};

export type Landing = { t: "wait" } | { t: "panel" } | { t: "land"; el: HTMLElement };

const WAIT: Landing = { t: "wait" };
const PANEL: Landing = { t: "panel" };

/** Panels whose subpages the route turns, each subpage's header id the page as the route names it. */
const SUBPAGED = new Set(["menu", "characters", "journal"]);

/** How Room tells that the panel shows the route's page: a subpage's header id, or a mark on the panel's first page. */
type PageShown = { t: "subpage" } | { t: "mark"; selector: string; row: boolean };

function pageShown(panel: string, page: string): PageShown | null {
  if (SUBPAGED.has(panel)) return { t: "subpage" };
  if (panel === "scenes" && recordId("scene", page) !== null) return { t: "mark", selector: `[${SEARCH_PAGE_ATTR}="${page}"]`, row: true };
  const view = panel === SOUND_PANEL ? soundView(page) : null;
  // Sound's first page marks the view it shows (SoundPanel.tsx DmSoundFirstPage).
  if (view) return { t: "mark", selector: `[data-sound-view="${view}"]`, row: false };
  return null;
}

/**
 * Where a route lands now, or "wait" for a later commit. The page comes
 * first: a subpage's header must name it, since the sheet or pane moves
 * focus to a new subpage's title as it publishes (useSubpageFocus), which
 * would take focus back from a control focused before. Then the anchor
 * by its `data-search` id, or a record's row, or the panel itself. A
 * page the route does not turn (a monster, a DM's handout) is the
 * panel's to show, and the landing does not wait for it.
 */
export function landing(request: Pick<SearchRoute, "panel" | "page" | "anchor">, view: RouteView): Landing {
  const { container } = view;
  if (!container) return WAIT;
  const shown = request.page === undefined ? null : pageShown(request.panel, request.page);
  let row: HTMLElement | null = null;
  if (shown?.t === "subpage") {
    if (view.subpage !== request.page) return WAIT;
  } else if (shown) {
    if (view.subpage !== null) return WAIT;
    const mark = container.querySelector<HTMLElement>(shown.selector);
    if (!mark) return WAIT;
    if (shown.row) row = mark;
  } else if (request.page === undefined && request.anchor !== undefined && SUBPAGED.has(request.panel) && view.subpage !== null) return WAIT;
  if (request.anchor !== undefined) {
    const el = container.querySelector<HTMLElement>(searchSelector(request.anchor));
    return el ? { t: "land", el } : WAIT;
  }
  return row ? { t: "land", el: row } : PANEL;
}

/** How long a landed control wears its ring (search.md 5.5), so a tap that draws no focus ring still shows where it went. */
export const RING_MS = 1_500;

/** Room above a landed control, so its label or its section's header shows over it. */
const LAND_MARGIN = theme.space(3);

/** What takes focus by itself: a control, or a heading that takes it from script. */
const OWN_FOCUS = "button, a[href], input, select, textarea, [tabindex]";

/** What inside a group takes its focus: the first control, never a heading kept out of the tab order. */
const INNER_FOCUS = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** The element an anchor's focus goes to: the anchor itself, a group's chosen option, or its first control. */
export function focusTarget(el: HTMLElement): HTMLElement {
  if (el.matches(OWN_FOCUS)) return el;
  return el.querySelector<HTMLElement>("input:checked") ?? el.querySelector<HTMLElement>(INNER_FOCUS) ?? el;
}

/** Whether a press would act: an action whose control is off is focused, not pressed, and its own help says why (search.md 5.5). */
export function pressable(el: HTMLElement): boolean {
  return !el.matches(":disabled") && el.getAttribute("aria-disabled") !== "true";
}

/**
 * The landing (search.md 5.5): the control comes near the top of its
 * panel, counting as the viewer taking the scroller so a remembered offset
 * still being put back never pulls it away, takes focus, wears the ring,
 * and is pressed when the route asks and it is on. Its own confirm, busy
 * state and Undo are then the control's. Returns what took focus.
 */
export function landOn(el: HTMLElement, press: boolean): HTMLElement {
  const target = focusTarget(el);
  takeOverPanelScroll(el);
  startInScrollBox(el, LAND_MARGIN);
  target.focus({ preventScroll: true });
  ring(el);
  if (press && pressable(target)) target.click();
  return target;
}

/**
 * The ring, as an animation that ends by itself, so nothing restores a
 * style React may have changed meanwhile. The color is the focus ring's,
 * read now: a keyframe's own var() is not read alike in every browser.
 */
function ring(el: HTMLElement): void {
  if (typeof el.animate !== "function" || typeof getComputedStyle !== "function") return;
  const style = getComputedStyle(el);
  const color = ["--rvtt-focus", "--rvtt-accent", "--rvtt-base-accent"].map((name) => style.getPropertyValue(name).trim()).find((v) => v !== "") ?? theme.color.crest;
  const frame = { outline: `2px solid ${color}`, outlineOffset: "2px" };
  el.animate([frame, frame], { duration: RING_MS });
}
