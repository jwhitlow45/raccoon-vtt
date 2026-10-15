import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ComponentType,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react";
import type { HeaderBack } from "../components/SheetHeader.tsx";
import { retryableLazy } from "../lib/retryableLazy.ts";

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
};

export type PanelDef = {
  id: string;
  title: string;
  dmOnly: boolean;
  /** Only where panels are sheets, below 900 px: from there up the side panel shows it another way. */
  narrowOnly: boolean;
  /** Position among the tabs and toolbar buttons, lowest first. */
  order: number;
  Component: ComponentType<PanelProps>;
};

function panel(def: {
  id: string;
  title: string;
  order: number;
  dmOnly?: boolean;
  narrowOnly?: boolean;
  load: () => Promise<{ default: ComponentType<PanelProps> }>;
}): PanelDef {
  const dmOnly = def.dmOnly ?? false;
  const Component = retryableLazy(def.load, { roles: dmOnly ? ["dm"] : ["dm", "player"] });
  return { id: def.id, title: def.title, order: def.order, dmOnly, narrowOnly: def.narrowOnly ?? false, Component };
}

/** Every panel, one per line. */
export const PANELS: readonly PanelDef[] = [
  panel({ id: "token", title: "Token", order: 10, load: () => import("../panels/TokenPanel.tsx") }),
  panel({ id: "tracker", title: "Initiative", order: 20, load: () => import("../panels/TrackerPanel.tsx") }),
  panel({ id: "scenes", title: "Scenes", order: 30, dmOnly: true, load: () => import("../panels/ScenesPanel.tsx") }),
  panel({ id: "library", title: "Library", order: 40, load: () => import("../panels/LibraryPanel.tsx") }),
  panel({ id: "areas", title: "Areas", order: 45, load: () => import("./areas/AreasPanel.tsx") }),
  panel({ id: "log", title: "Log", order: 50, load: () => import("../panels/LogPanel.tsx") }),
  panel({ id: "journal", title: "Journal", order: 55, load: () => import("./journal/JournalPanel.tsx") }),
  panel({ id: "characters", title: "Characters", order: 15, load: () => import("./tokens/CharactersPanel.tsx") }),
  panel({ id: "monsters", title: "Monsters", order: 16, dmOnly: true, load: () => import("./tokens/MonstersPanel.tsx") }),
  panel({ id: "encounters", title: "Encounters", order: 17, dmOnly: true, load: () => import("./encounters/EncountersPanel.tsx") }),
  // From 900 px up the party bar sits atop the side panel instead (features/party/PartyDock.tsx).
  panel({ id: "party", title: "Party", order: 14, dmOnly: true, narrowOnly: true, load: () => import("./party/PartyPanel.tsx") }),
  panel({ id: "dm", title: "DM", order: 60, dmOnly: true, load: () => import("../panels/DmPanel.tsx") }),
  panel({ id: "outliner", title: "Outliner", order: 35, dmOnly: true, load: () => import("./outliner/OutlinerPanel.tsx") }),
  panel({ id: "menu", title: "Menu", order: 90, load: () => import("../panels/MenuPanel.tsx") }),
];

export function panelsFor(role: "dm" | "player", wide = false): PanelDef[] {
  return PANELS.filter((p) => (!p.dmOnly || role === "dm") && !(wide && p.narrowOnly)).sort((a, b) => a.order - b.order);
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

const PanelHeaderContext = createContext<((header: PanelHeader | null) => void) | null>(null);

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
    publish({ title, parent, armed, onBack: () => onBack.current?.(), ...(id === undefined ? null : { id }) });
    return () => publish(null);
  }, [publish, title, parent, armed, id]);
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
  const sink = useCallback((header: PanelHeader | null) => latest.current(header), []);
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

  // Which subpage shows, not what it is called: a title typed or renamed in place is no change of page.
  const key = subpage ? `${subpage.parent}\n${subpage.id ?? subpage.title}` : null;
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
     * moved the selected token.
     */
    if (active instanceof Element && active.closest('[role="tablist"]')) return;
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
