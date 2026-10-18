import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import type { HeaderBack } from "../components/SheetHeader.tsx";
import { retryableLazy } from "../lib/retryableLazy.ts";
import { scopeSlot, useScopedIfAny } from "../state/scope.ts";
// The starter catalog's background load joins the panels' (features/starter/catalog.ts). Its pickers live in lazy panels, too late to register it.
import "./starter/catalog.ts";

/**
 * The room's panels (design section 14.4): bottom sheets on phones, sheets
 * docked on the right in phone landscape, tabs of the side panel from
 * 900 px up.
 *
 * Why a registry: each feature owns its panel in its own file, and the Room
 * page renders whatever is listed here. Every panel loads lazily (section
 * 14.1), so a player's first load carries none of them, and a DM-only panel
 * never loads for a player at all. A load that fails can be tried again
 * (lib/retryableLazy.ts), so a panel opened offline opens once back online.
 *
 * A panel is a default-exported React component that takes PanelProps and
 * reads the room with the hooks in state/view.ts. A minimal one, in
 * client/panels/HandoutsPanel.tsx:
 *
 *   export default function HandoutsPanel(props: PanelProps) {
 *     const handouts = useRoomView((s) => s.view?.handouts);
 *     return <ul>{Object.values(handouts ?? {}).map((h) => <li key={h.id}>{h.title}</li>)}</ul>;
 *   }
 *
 * and here: `panel({ id: "handouts", title: "Handouts", order: 60, load: () => import("../panels/HandoutsPanel.tsx") }),`
 */

export type PanelProps = {
  /** The token selected on the map, if any. */
  selectedTokenId: string | null;
  /** Closes the panel's sheet on phones. On wide screens the side panel stays. */
  close(): void;
  /**
   * Whether the panel is on screen. A hidden sheet or side panel keeps its
   * panel mounted (docs/design-v1-layout-hierarchy.md 4.2), so whatever
   * marks content read asks this first.
   */
  shown: boolean;
};

/**
 * Which group a panel is in (docs/design-v1-layout-hierarchy.md M3): the
 * ones a table reaches for in play, the ones for preparing, and the room's
 * own Menu. The groups keep to the order's ranges: play 10 to 24, prepare
 * 40 to 48, and Menu last.
 */
export type PanelGroup = "play" | "prepare" | "room";

export type PanelDef = {
  id: string;
  title: string;
  dmOnly: boolean;
  /** Only where panels are sheets, below 900 px: from there up the side panel shows it another way. */
  narrowOnly: boolean;
  /** Position among the tabs and toolbar buttons, lowest first. */
  order: number;
  group: PanelGroup;
  /** What the panel is about, where that comes from outside it: "selection", the selected token (panelSubject). */
  subject?: "selection";
  /** The DM guide's section on this panel, a heading's anchor in docs/dm-guide.md, for the DM's Guide link at its foot (panels/Panels.tsx). */
  guide?: string;
  Component: ComponentType<PanelProps>;
};

function panel(def: {
  id: string;
  title: string;
  order: number;
  group: PanelGroup;
  dmOnly?: boolean;
  narrowOnly?: boolean;
  subject?: "selection";
  guide?: string;
  load: () => Promise<{ default: ComponentType<PanelProps> }>;
}): PanelDef {
  const dmOnly = def.dmOnly ?? false;
  const Component = retryableLazy(def.load, { roles: dmOnly ? ["dm"] : ["dm", "player"] });
  return {
    id: def.id,
    title: def.title,
    order: def.order,
    group: def.group,
    dmOnly,
    narrowOnly: def.narrowOnly ?? false,
    ...(def.subject ? { subject: def.subject } : null),
    ...(def.guide ? { guide: def.guide } : null),
    Component,
  };
}

/**
 * Every panel, one per line, ordered by use (docs/design-v1-layout-hierarchy.md
 * M3): in play the DM and the players look for the token, Initiative, the
 * party and the Log first, so they lead, and the panels for preparing a
 * session follow. The Token panel stays first and Initiative second, the
 * side panel's default tab.
 */
export const PANELS: readonly PanelDef[] = [
  panel({ id: "token", title: "Token", order: 10, group: "play", subject: "selection", guide: "tokens", load: () => import("../panels/TokenPanel.tsx") }),
  panel({ id: "tracker", title: "Initiative", order: 12, group: "play", guide: "initiative", load: () => import("../panels/TrackerPanel.tsx") }),
  panel({ id: "dice", title: "Dice", order: 15, group: "play", subject: "selection", guide: "dice", load: () => import("./dice/DicePanel.tsx") }),
  panel({ id: "scenes", title: "Scenes", order: 24, group: "play", dmOnly: true, guide: "scenes", load: () => import("../panels/ScenesPanel.tsx") }),
  panel({ id: "library", title: "Library", order: 48, group: "prepare", load: () => import("../panels/LibraryPanel.tsx") }),
  panel({ id: "areas", title: "Areas", order: 20, group: "play", guide: "areas", load: () => import("./areas/AreasPanel.tsx") }),
  panel({ id: "log", title: "Log", order: 16, group: "play", load: () => import("../panels/LogPanel.tsx") }),
  panel({ id: "journal", title: "Journal", order: 18, group: "play", load: () => import("./journal/JournalPanel.tsx") }),
  panel({ id: "characters", title: "Characters", order: 44, group: "prepare", guide: "characters-and-their-stat-blocks", load: () => import("./tokens/CharactersPanel.tsx") }),
  panel({ id: "monsters", title: "Monsters", order: 40, group: "prepare", dmOnly: true, guide: "monsters", load: () => import("./tokens/MonstersPanel.tsx") }),
  panel({ id: "encounters", title: "Encounters", order: 42, group: "prepare", dmOnly: true, guide: "encounters", load: () => import("./encounters/EncountersPanel.tsx") }),
  // From 900 px up the party bar sits atop the side panel instead (features/party/PartyDock.tsx).
  panel({ id: "party", title: "Party", order: 14, group: "play", dmOnly: true, narrowOnly: true, load: () => import("./party/PartyPanel.tsx") }),
  panel({ id: "dm", title: "DM", order: 22, group: "play", dmOnly: true, guide: "dm-panel", load: () => import("../panels/DmPanel.tsx") }),
  panel({ id: "outliner", title: "Outliner", order: 46, group: "prepare", dmOnly: true, guide: "outliner", load: () => import("./outliner/OutlinerPanel.tsx") }),
  panel({ id: "menu", title: "Menu", order: 90, group: "room", load: () => import("../panels/MenuPanel.tsx") }),
];

export function panelsFor(role: "dm" | "player", wide = false): PanelDef[] {
  return PANELS.filter((p) => (!p.dmOnly || role === "dm") && !(wide && p.narrowOnly)).sort((a, b) => a.order - b.order);
}

/** The labels of a DM's groups of panels (docs/design-v1-layout-hierarchy.md M3). Menu, the room's own, follows a plain line instead. */
const GROUP_LABELS: Partial<Record<PanelGroup, string>> = { play: "In play", prepare: "Prepare" };

export type PanelSection = {
  /** The group, or "all" for a list with no groups. */
  key: PanelGroup | "all";
  /** "In play" or "Prepare" over the section's panels. */
  label?: string;
  /** A plain line before the section, as before Menu. */
  line: boolean;
  panels: PanelDef[];
};

/**
 * Panels in sections, one rule for a DM's phone list of panels and the
 * side panel's More (docs/design-v1-panel-tabs.md 4.1), so a phone and a
 * computer group them one way. Grouped, for a DM, each group in the slice
 * opens a section, under its label, and Menu after a plain line. A group
 * with no panel in the slice has no section, so More's list shows a label
 * only over panels it holds. A player's list is not grouped: five panels
 * read at a glance. The order stays the slice's, the registry's.
 */
export function panelSections(panels: readonly PanelDef[], grouped: boolean): PanelSection[] {
  if (!grouped) return panels.length > 0 ? [{ key: "all", line: false, panels: [...panels] }] : [];
  const sections: PanelSection[] = [];
  for (const p of panels) {
    const last = sections[sections.length - 1];
    if (last?.key === p.group) {
      last.panels.push(p);
      continue;
    }
    const label = GROUP_LABELS[p.group];
    sections.push({ key: p.group, ...(label ? { label } : null), line: label === undefined, panels: [p] });
  }
  return sections;
}

export function panelById(id: string | null): PanelDef | undefined {
  return id === null ? undefined : PANELS.find((p) => p.id === id);
}

/**
 * A panel's subpage, as the sheet or side panel shows it in its header
 * (docs/design-v1-visual.md 2.3): Members inside Menu, a journal page, the
 * encounter editor. `title` is the subpage's name and `parent` the panel's,
 * for the back button's name, "Back to Menu". `armed` is a question the
 * back button asks first, such as "Discard changes?" (SheetHeader.tsx
 * HeaderBack).
 *
 * `id` names the subpage for good, for a subpage whose title can change
 * while it is open: the encounter editor, named by the draft's name as it
 * is typed, or a journal page renamed from another device. Focus follows
 * a change of subpage (useSubpageFocus), and with an `id` a new title is
 * not one. Without it the title is the subpage's identity.
 */
export type PanelHeader = {
  title: string;
  parent: string;
  onBack(): void;
  armed?: string | null;
  id?: string;
};

/**
 * Which subpage shows, not what it is called: a title typed or renamed in
 * place is no change of page, and two pages with one title differ by their
 * ids. Focus follows it (useSubpageFocus), and a sheet's swipe ends when it
 * changes (lib/sheetSwipe.ts).
 */
export function subpageKey(subpage: Pick<PanelHeader, "parent" | "title" | "id">): string {
  return `${subpage.parent}\n${subpage.id ?? subpage.title}`;
}

/** Publishes a panel's subpage to its host, and hands back what withdraws it. */
type PublishHeader = (header: PanelHeader) => () => void;

const PanelHeaderContext = createContext<PublishHeader | null>(null);

const PanelHereContext = createContext<string | null>(null);

/**
 * The id of the panel the calling code is drawn in, or null outside the
 * panels, such as on the map or in the token window. A link inside a
 * panel passes it as `from` when it opens another panel (state/types.ts
 * PanelHow), so with two panels it opens in the other pane and never
 * covers the one it was pressed in (docs/design-v1-split-panel.md 5.1). A
 * panel never names itself, since the same code may draw in either pane.
 */
export function usePanelHere(): string | null {
  return useContext(PanelHereContext);
}

/** Names the panel inside it for usePanelHere. PanelBody wraps each panel in one. */
export function PanelHere(props: { id: string; children?: ReactNode }): ReactElement {
  return createElement(PanelHereContext.Provider, { value: props.id }, props.children);
}

/**
 * Names the subpage a panel shows, or null while it shows its own first
 * page. The host around the panel (PanelHeaderHost) then titles its header
 * with the subpage and wires its back button to `onBack`, so a phone sheet
 * says "Members" with "Back to Menu" instead of a second back link in the
 * body.
 *
 * Why a context and not a prop: the panels are lazy components behind one
 * registry, and only some of them have subpages. A panel that names none
 * changes nothing, and where no host listens (a panel rendered outside the
 * room, or before the room wires it) the hook does nothing at all, so a
 * panel can adopt it on its own.
 *
 * `onBack` may be a new function on every render: the host always calls
 * the latest one. A change of title, parent or armed label publishes
 * again, in a layout effect, so the header never paints a frame behind.
 */
export function usePanelHeader(header: PanelHeader | null): void {
  const publish = useContext(PanelHeaderContext);
  const onBack = useRef(header?.onBack);
  onBack.current = header?.onBack;
  const title = header?.title ?? null;
  const parent = header?.parent ?? null;
  const armed = header?.armed ?? null;
  const id = header?.id;
  useLayoutEffect(() => {
    if (!publish || title === null || parent === null) return;
    return publish({ title, parent, armed, onBack: () => onBack.current?.(), ...(id === undefined ? null : { id }) });
  }, [publish, title, parent, armed, id]);
}

/**
 * The host's side of usePanelHeader: a subpage goes to the host's latest
 * `onHeader`, and its withdrawal goes back to the same one. A host reused
 * for another panel, as the phone's sheet reuses its body when one panel
 * replaces another, has already taken the incoming panel's `onHeader` when
 * the outgoing panel's cleanup runs, so a withdrawal sent to the latest
 * would clear the incoming panel's header and leave the outgoing one's
 * behind, its Back doing nothing the next time that panel opens.
 */
export function headerSink(latest: { readonly current: (header: PanelHeader | null) => void }): PublishHeader {
  return (header) => {
    const target = latest.current;
    target(header);
    return () => target(null);
  };
}

/**
 * Listens for the subpage of the panel inside it (usePanelHeader). Wrap
 * each panel's body in one, and keep what `onHeader` receives in state:
 * null while the panel shows its first page. `onHeader` may change between
 * renders without the panel publishing again.
 */
export function PanelHeaderHost(props: { onHeader(header: PanelHeader | null): void; children?: ReactNode }): ReactElement {
  const latest = useRef(props.onHeader);
  latest.current = props.onHeader;
  const [sink] = useState(() => headerSink(latest));
  return createElement(PanelHeaderContext.Provider, { value: sink }, props.children);
}

/** A subpage's back button for SheetHeader: named "Back to" and the panel's name, asking the armed question first. */
export function subpageBack(header: PanelHeader): HeaderBack {
  return { label: `Back to ${header.parent}`, onBack: header.onBack, armed: header.armed ?? null };
}

/**
 * The control that opened a subpage, as it can be found again once its
 * page has mounted anew: its element, the `data-opener` id it or its row
 * carries, and else its tag, its name and its place among the controls
 * with that same tag and name. `top` is how far the page was scrolled
 * when it was pressed, read then, since by the time the subpage mounts
 * in the same scrolling body the browser has already cut the offset down
 * to the subpage's height.
 */
type Opener = { el: HTMLElement; id: string | null; tag: string; name: string; index: number; top: number };

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function nameOf(el: HTMLElement): string {
  return (el.getAttribute("aria-label") ?? el.textContent ?? "").trim();
}

function sameNamed(body: HTMLElement, tag: string, name: string): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>(tag)].filter((el) => nameOf(el) === name);
}

function openerOf(body: HTMLElement, el: HTMLElement): Opener {
  const marked = el.closest("[data-opener]");
  const tag = el.tagName.toLowerCase();
  const name = nameOf(el);
  return { el, id: marked && body.contains(marked) ? marked.getAttribute("data-opener") : null, tag, name, index: sameNamed(body, tag, name).indexOf(el), top: body.scrollTop };
}

/**
 * The opener on the page that mounted anew, or null for the title. In
 * order: the same element if it is still there; the control marked with
 * the same `data-opener` id, which finds a row that moved and finds
 * nothing for one that was removed; else the control with the same tag
 * and name at the same place among its namesakes, so the second of two
 * rows named "Notes" comes back to the second.
 */
function findOpener(body: HTMLElement | null, opener: Opener | null): HTMLElement | null {
  if (!body || !opener) return null;
  if (opener.el.isConnected && body.contains(opener.el)) return opener.el;
  if (opener.id !== null) {
    const marked = [...body.querySelectorAll<HTMLElement>("[data-opener]")].find((el) => el.getAttribute("data-opener") === opener.id);
    if (!marked) return null;
    return marked.matches(FOCUSABLE) ? marked : marked.querySelector<HTMLElement>(FOCUSABLE);
  }
  return sameNamed(body, opener.tag, opener.name)[opener.index] ?? null;
}

/**
 * Moves focus as a panel's subpage comes and goes, for whatever draws the
 * header (the phone Sheet, the desktop side panel), so every panel with
 * subpages gets it without code of its own. Entering a subpage unmounts
 * the row that opened it, and leaving unmounts the subpage, and either
 * way focus fell to the page.
 *
 * - On entry, focus goes to the header's title, a heading that takes focus
 *   from script (SheetHeader `titleRef`), so a screen reader starts at the
 *   subpage's name.
 * - On Back, it goes to the control that opened the subpage, found again
 *   on the page that mounted anew (findOpener): by its `data-opener` id
 *   (Row's `opener`), else by its tag, name and place among its
 *   namesakes. When it is gone, focus goes to the title, or where the
 *   header goes with the subpage (the desktop side panel's), to
 *   `fallback`: something that stays, such as the panel's chosen tab.
 *
 * Focus moves only when it was in the panel or lost to the page, so a
 * change made elsewhere never takes focus from where the person is.
 * `root` holds both the header and the body: the body's parent unless
 * given.
 */
export function useSubpageFocus(
  subpage: PanelHeader | null,
  refs: {
    title: RefObject<HTMLElement | null>;
    body: RefObject<HTMLElement | null>;
    root?: RefObject<HTMLElement | null>;
    fallback?: RefObject<HTMLElement | null>;
  },
): void {
  const lastFocus = useRef<Opener | null>(null);
  const opener = useRef<Opener | null>(null);
  const shown = useRef<string | null>(null);
  const { title, body, root, fallback } = refs;

  /*
   * The control in the body that was last focused or pressed, kept past its
   * unmounting: the opener of the next subpage. A press counts as well as
   * focus, since Safari, VoiceOver included, does not focus a button that
   * is clicked or tapped. Seen in the capture phase, before the click's
   * own handler opens the subpage.
   */
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const remember = (target: EventTarget | null) => {
      if (target instanceof HTMLElement && target !== el && el.contains(target)) lastFocus.current = openerOf(el, target);
    };
    const onFocusIn = (e: FocusEvent) => remember(e.target);
    const onClick = (e: MouseEvent) => remember(e.target instanceof Element ? e.target.closest("button, a[href]") : null);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("click", onClick, true);
    return () => {
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("click", onClick, true);
    };
  }, [body]);

  const key = subpage ? subpageKey(subpage) : null;
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = key;
    if (was === key) return;
    // A control pressed on an earlier page never opens the next subpage.
    const pressed = lastFocus.current;
    lastFocus.current = null;
    /*
     * The opener follows every entry and exit, wherever focus is: only the
     * move itself waits on focus being here. Skipped along with the move,
     * a subpage opened and closed from outside the panel left the opener
     * of an earlier one behind, and a later Back went to that stale row.
     */
    /*
     * The first page and its subpages share one scrolling body, which kept
     * its offset: a stat block opened from far down the monster list showed
     * its last lines, and Back left the list where the subpage had been
     * scrolled, with the row that took focus out of sight. So a subpage
     * opens at its top, and Back puts the first page where it was when the
     * row was pressed, when that row is there again.
     */
    const scroller = body.current;
    let target: HTMLElement | null;
    let back: HTMLElement | null = null;
    if (key !== null) {
      if (was === null) opener.current = pressed;
      target = title.current;
      if (scroller) scroller.scrollTop = 0;
    } else {
      back = findOpener(scroller, opener.current);
      if (back && scroller && opener.current) scroller.scrollTop = opener.current.top;
      // A header drawn only for a subpage is gone with it, and its title with it.
      target = back ?? (title.current?.isConnected ? title.current : null) ?? fallback?.current ?? null;
      opener.current = null;
    }
    const area = root?.current ?? body.current?.parentElement ?? null;
    const active = document.activeElement;
    const lost = active === null || active === document.body;
    if (!lost && !(area?.contains(active) ?? false)) return;
    /*
     * A tab chosen by click or arrow key changes the page too, to a panel
     * that may show a subpage. The tab pattern keeps focus on the tab, and
     * moved to the subpage's title, the next arrow left the tab list and
     * moved the selected token. The side panel's More menu is part of the
     * tabs: a panel picked there keeps focus for More (pages/SideTabs.tsx).
     * The split's bar (pages/SplitBar.tsx) names the bottom panel as a tab
     * names the top one, and its own menu carries `data-tabs-menu`.
     */
    if (active instanceof Element && active.closest('[role="tablist"], [data-tabs-menu], [data-pane-bar]')) return;
    target?.focus({ preventScroll: true });
    /*
     * The row Back found can lie outside the view the offset put back: a
     * journal page another device added above it moved it down, or it was
     * focused from the keyboard without scrolling there. So it is brought
     * just into view. Not with lib/reveal.ts, which reads the offset chain:
     * the body is not its rows' offset parent.
     */
    if (!back || !scroller) return;
    const row = back.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    if (row.top < view.top || row.bottom > view.bottom) back.scrollIntoView({ block: "nearest" });
  }, [key, title, body, root, fallback]);
}

/**
 * Where a panel was scrolled when it last showed: its scroller's offsets,
 * whether it sat at its end, the page it showed then, null for its first
 * page or a subpage's key (subpageKey), and what it was about (panelSubject).
 */
export type PanelScroll = { top: number; left: number; end: boolean; page: string | null; subject: string | null };

/**
 * Each panel's last scroll, by panel id, for this Room page: a panel that
 * shows again, by any path, opens where it was left, in either pane of the
 * side panel or a phone's sheet. Numbers and keys only, never an element,
 * so a panel that left holds none of its DOM here.
 */
export const panelScrollSlot = scopeSlot(() => new Map<string, PanelScroll>());

/**
 * What a panel is about, where that comes from outside it: the selected
 * token for a panel whose registry entry says `subject: "selection"` (the
 * Token panel, and Dice, whose options are the selected token's), else null. A panel that shows again about another subject
 * opens at its top, since its old place belonged to something else.
 */
export function panelSubject(id: string, selectedTokenId: string | null): string | null {
  return panelById(id)?.subject === "selection" ? selectedTokenId : null;
}

/** Under this many px from the foot, a scroller sits at its end. */
const END_SLOP = 2;

/** How long a panel that shows again keeps waiting for its content to hold its old offset, such as the monster list arriving after the panel draws. */
export const RESTORE_WAIT_MS = 1000;

/**
 * A scroller's place now, on `page`, about `subject`. At its end only once
 * scrolled: a panel that fits its scroller, or one scrolled back to its
 * top, opens at its top again even if it has grown since.
 */
export function scrollOf(el: { scrollTop: number; scrollLeft: number; scrollHeight: number; clientHeight: number }, page: string | null, subject: string | null = null): PanelScroll {
  const end = el.scrollTop > 0 && el.scrollHeight - el.scrollTop - el.clientHeight <= END_SLOP;
  return { top: el.scrollTop, left: el.scrollLeft, end, page, subject };
}

/**
 * One try at putting a panel back where it was (`saved`), given the page
 * and subject it shows now and its scroller's size:
 *
 * - "done" with nothing to put back: nothing remembered, or a place about
 *   another subject (the Token panel left on another token), so the panel
 *   keeps its own first scroll, its top, or the Log's newest line.
 * - "wait" while a remembered subpage has yet to publish its header.
 * - "set" an offset, and `held` once the content is tall enough to hold
 *   it. Until then the caller tries again as content arrives. At its end,
 *   it is the new end, so whatever arrived meanwhile (a Log line) shows.
 */
export type RestoreStep = { kind: "done" } | { kind: "wait" } | { kind: "set"; top: number; left: number; held: boolean };

export function restoreStep(saved: PanelScroll | undefined, now: { page: string | null; subject?: string | null; scrollHeight: number; clientHeight: number }): RestoreStep {
  if (!saved || saved.subject !== (now.subject ?? null)) return { kind: "done" };
  if (saved.page !== now.page) return { kind: "wait" };
  const room = Math.max(0, now.scrollHeight - now.clientHeight);
  if (saved.end) return { kind: "set", top: room, left: saved.left, held: true };
  return { kind: "set", top: saved.top, left: saved.left, held: room >= saved.top - 1 };
}

/** What the keeper reads and sets of a panel's scroller, an element. No client rects means it has no box yet, as in a dialog not yet open or a hidden pane. */
export type ScrollBox = { scrollTop: number; scrollLeft: number; readonly scrollHeight: number; readonly clientHeight: number; getClientRects(): { readonly length: number } };

/**
 * The rule of usePanelScroll, apart from React and the DOM so a test can
 * run it through any order of events. A panel that shows again starts a
 * restore, which stays pending until its content holds the offset, the
 * viewer takes the scroller, or RESTORE_WAIT_MS passes after the scroller
 * is first drawn. While it is pending no scroll is recorded, so a scroll
 * the restore caused, clamped by content not there yet, never replaces
 * the place it is putting back. With no map (`kept` null, outside any
 * Room) it keeps and puts back nothing.
 */
export class PanelScrollKeeper {
  private shown: string | null = null;
  private pending: { id: string; since: number | null } | null = null;
  private readonly kept: Map<string, PanelScroll> | null;
  private readonly box: () => ScrollBox | null;
  private readonly now: () => number;

  constructor(kept: Map<string, PanelScroll> | null, box: () => ScrollBox | null, now: () => number) {
    this.kept = kept;
    this.box = box;
    this.now = now;
  }

  /** Whether a restore is still pending. */
  get waiting(): boolean {
    return this.pending !== null;
  }

  /** The panel the body shows now. Another one than before starts a restore. */
  show(id: string | null): void {
    if (this.shown === id) return;
    this.shown = id;
    this.pending = id === null || this.kept === null ? null : { id, since: null };
  }

  /**
   * One try, on the page and about the subject the panel shows now.
   * Whether to try again on the next frame: only while pending with the
   * scroller drawn. A scroller not drawn yet keeps the restore pending for
   * the commit that draws it, with no frames meanwhile, so a hidden pane
   * runs no loop.
   */
  attempt(page: string | null, subject: string | null = null): boolean {
    const ask = this.pending;
    const el = this.box();
    if (!ask || !el || !this.kept || el.getClientRects().length === 0) return false;
    const now = this.now();
    ask.since ??= now;
    if (now - ask.since >= RESTORE_WAIT_MS) {
      this.pending = null;
      return false;
    }
    const step = restoreStep(this.kept.get(ask.id), { page, subject, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
    if (step.kind === "wait") return true;
    if (step.kind === "set") {
      if (el.scrollTop !== step.top) el.scrollTop = step.top;
      if (el.scrollLeft !== step.left) el.scrollLeft = step.left;
      if (!step.held) return true;
    }
    this.pending = null;
    return false;
  }

  /** The scroller scrolled: kept as the panel's place, unless a restore is pending. */
  scrolled(page: string | null, subject: string | null = null): void {
    const el = this.box();
    if (this.shown === null || this.pending !== null || !el || !this.kept) return;
    this.kept.set(this.shown, scrollOf(el, page, subject));
  }

  /**
   * After each commit: a panel now about another subject than its kept
   * place, shown again so or changed in place (Token on another token),
   * keeps its place now about that subject. So it comes back about the one
   * it was left on, and never about one it showed earlier.
   */
  note(page: string | null, subject: string | null): void {
    if (this.shown === null || this.pending !== null || !this.kept) return;
    const saved = this.kept.get(this.shown);
    if (saved === undefined || saved.subject !== subject) this.scrolled(page, subject);
  }

  /** The viewer wheeled, touched, pressed or typed in the scroller: a pending restore stops there, so content that fills in late never pulls them back. */
  takeOver(): void {
    this.pending = null;
  }
}

/**
 * Keeps a panel's scroll as it leaves and puts it back as it shows again
 * (panelScrollSlot, PanelScrollKeeper), for whatever scrolls a panel: a
 * side panel's pane or a phone's sheet. Call it after useSubpageFocus on
 * the same body, since that hook sets the offset as a subpage comes and
 * goes, and this one has the last word.
 *
 * A panel shows again when the panel in the body changes. The first try
 * is in a layout effect, before paint, so nothing jumps, and after
 * whatever opens the scroller, since a body with no box takes no offset.
 * Content may come later than the first frame: a remembered subpage
 * publishes its header a commit later, and the monster list or a page's
 * pictures fill in after the panel draws. So a pending restore tries again
 * on each commit and each frame until it ends, which takes at most
 * RESTORE_WAIT_MS.
 */
export function usePanelScroll(id: string | null, subpage: PanelHeader | null, body: RefObject<HTMLElement | null>, subject: string | null = null): void {
  // A sheet outside any Room, as on the dev kit page, renders without keeping scroll.
  const kept = useScopedIfAny(panelScrollSlot);
  const page = subpage ? subpageKey(subpage) : null;
  const now = useRef({ page, subject });
  now.current = { page, subject };
  const [keeper] = useState(() => new PanelScrollKeeper(kept, () => body.current, () => performance.now()));
  const framing = useRef(false);
  const tryRestore = useRef(() => {});
  tryRestore.current = () => {
    if (!keeper.attempt(now.current.page, now.current.subject) || framing.current) return;
    framing.current = true;
    const frame = () => {
      if (keeper.attempt(now.current.page, now.current.subject)) requestAnimationFrame(frame);
      else framing.current = false;
    };
    requestAnimationFrame(frame);
  };
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const record = () => keeper.scrolled(now.current.page, now.current.subject);
    const takeOver = () => keeper.takeOver();
    el.addEventListener("scroll", record, { passive: true });
    for (const type of VIEWER_INPUT) el.addEventListener(type, takeOver, { passive: true });
    return () => {
      el.removeEventListener("scroll", record);
      for (const type of VIEWER_INPUT) el.removeEventListener(type, takeOver);
    };
  }, [body, keeper]);
  useLayoutEffect(() => {
    keeper.show(id);
    tryRestore.current();
    keeper.note(page, subject);
  });
}

/** What the viewer does to take a scroller over. */
const VIEWER_INPUT = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
