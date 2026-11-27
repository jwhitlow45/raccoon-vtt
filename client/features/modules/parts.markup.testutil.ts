import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createStore } from "zustand/vanilla";
import type { Character, CharacterId, ClassResource, PcStats, RoomState } from "#shared/model.ts";
import { AT, DM, P1, castTable, character, entry, template, token } from "#shared/testutil.ts";
import { api } from "../../lib/api.ts";
import { dmPanelFoldsSlot, scenesFoldsSlot } from "../../lib/folds.ts";
import { EMPTY_HISTORY } from "../../state/history.ts";
import { NO_FLOOR_EPHEMERAL } from "../../state/ephemeral.ts";
import { SCENE_LOAD_IDLE } from "../../state/sceneLoad.ts";
import { RoomScope, RoomScopeProvider } from "../../state/scope.ts";
import { EMPTY_EPHEMERAL, INITIAL_LOCAL, type LocalUi, type RoomView } from "../../state/types.ts";
import { RoomProvider, useRoomView } from "../../state/view.ts";
import { BUILD_MODES, builderSlot, type BuildMode } from "../builder/store.ts";
import { optionSlot } from "../dice/optionState.ts";
import { newPage } from "../dice/groupSave/chain.ts";
import { groupSaveSlot } from "../dice/groupSave/store.ts";
import { pasteSlot } from "../images/pasteRouter.ts";
import { journalSlot } from "../journal/store.ts";
import { seededRoom, towerRoom, viewOf } from "../search/search.testutil.ts";
import { FOLD_KEYS, panelFoldsSlot } from "../tokens/panelFolds.ts";
import { resetServerRoomSoundForTests, serverRoomSound } from "../sound/engine/store.ts";
import { EDITABLE, FOCUS_STOP, INTERACTIVE_ROLES, LINK, NATIVE_CONTROLS } from "./controlSites.ts";
import { ownerOf, type ClaimConditions } from "./gate.ts";
import type { Holder, Home, ModuleId, Role } from "./registry.ts";

/*
 * The parts markup test's fixtures and its markup reader
 * (parts.markup.test.ts). Imported after the test's shims, since the
 * surfaces below load React and the room's stores as they are read.
 */

const { default: DmPanel } = await import("../../panels/DmPanel.tsx");
const { SceneSettings } = await import("../scenes/SceneSettings.tsx");
const { FloorsGroup } = await import("../scenes/FloorsGroup.tsx");
const { NewScene } = await import("../scenes/NewScene.tsx");
const { default: BuilderOptions } = await import("../builder/Options.tsx");
const { default: TimePanel } = await import("../clock/TimePanel.tsx");
const { default: SoundPanel } = await import("../sound/panel/SoundPanel.tsx");
const { default: TrackerPanel } = await import("../../panels/TrackerPanel.tsx");
const { default: LogPanel } = await import("../../panels/LogPanel.tsx");
const { default: MembersPanel } = await import("../../panels/MembersPanel.tsx");
const { TurnCard } = await import("../combat/TurnCard.tsx");
const { useCombatAlerts } = await import("../combat/alerts.ts");
const { CharacterPage } = await import("../tokens/CharacterCard.tsx");
const { default: CharactersPanel } = await import("../tokens/CharactersPanel.tsx");
const { MakeCompanion } = await import("../tokens/CompanionsSection.tsx");
const { ResyncDialog } = await import("../pcstats/Resync.tsx");
const { default: TokenPanel } = await import("../../panels/TokenPanel.tsx");
const { UsesDrawer } = await import("../combat/CombatUses.tsx");
const { TokenActionBar } = await import("../../canvas/TokenActionBar.tsx");
const { AttachBlockDialog, CharacterBlocksPage } = await import("../tokens/CompanionBlocks.tsx");
const { ResourceSheet } = await import("../resources/ResourceSheet.tsx");
const { PcStatsEditor } = await import("../pcstats/PcStatsEditor.tsx");
const { RoomPasteHost } = await import("../images/RoomPaste.tsx");
const { PlayerOptions } = await import("../dice/RollOptions.tsx");
const { default: DicePanel } = await import("../dice/DicePanel.tsx");
const { JournalEditor } = await import("../journal/JournalEditor.tsx");
const { default: JournalPanel } = await import("../journal/JournalPanel.tsx");
const { ChipMenuBody, useChipEnv, useChipHost, useDmMenuView } = await import("../../pages/ChipMenus.tsx");
const { dmMenuSections, showSection, youMenuSections } = await import("../../pages/chipMenus.ts");
const { useHiddenHere, useModule } = await import("./Gate.tsx");
const { CHIP_WORDS } = await import("../../pages/chipWords.ts");
const { default: ThisDevice } = await import("../device/ThisDevice.tsx");
const { Popover } = await import("../../components/Popover.tsx");

// ------------------------------------------------------------ reading markup

/** An element of a drawing, as the markup reader finds it. */
export type MarkupNode = { tag: string; attrs: Readonly<Record<string, string>>; children: (MarkupNode | string)[]; parent: MarkupNode | null };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#x27": "'", "#39": "'", nbsp: " " };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#x27|#39|nbsp);/g, (_, name: string) => ENTITIES[name]!);

/** The element tree of a render to markup. React writes every attribute value quoted and escapes `<` in text, so a tag walker reads it whole. */
export function parseMarkup(html: string): MarkupNode {
  const root: MarkupNode = { tag: "#root", attrs: {}, children: [], parent: null };
  let at = root;
  // The comments React puts between neighboring texts are no part of either.
  for (const m of html.replace(/<!--[\s\S]*?-->/g, "").matchAll(/<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s=>/]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g)) {
    if (m[5] !== undefined) {
      at.children.push(decode(m[5]));
      continue;
    }
    const tag = m[2]!.toLowerCase();
    if (m[1]) {
      let open: MarkupNode | null = at;
      while (open && open !== root && open.tag !== tag) open = open.parent;
      at = open && open !== root ? (open.parent ?? root) : at;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of (m[3] ?? "").matchAll(/([^\s=]+)(?:="([^"]*)")?/g)) attrs[a[1]!.toLowerCase()] = decode(a[2] ?? "");
    const node: MarkupNode = { tag, attrs, children: [], parent: at };
    at.children.push(node);
    if (!m[4] && !VOID.has(tag)) at = node;
  }
  return root;
}

function* walk(node: MarkupNode): Generator<MarkupNode> {
  for (const child of node.children) {
    if (typeof child === "string") continue;
    yield child;
    yield* walk(child);
  }
}

function textOf(node: MarkupNode | undefined): string {
  if (!node) return "";
  const out: string[] = [];
  const add = (n: MarkupNode) => {
    for (const c of n.children) {
      if (typeof c === "string") out.push(c);
      else add(c);
    }
  };
  add(node);
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** The nearest `data-part` at or around a node, or "core". */
function ownerAt(node: MarkupNode): string {
  for (let n: MarkupNode | null = node; n; n = n.parent) {
    const part = n.attrs["data-part"];
    if (part !== undefined) return part;
  }
  return "core";
}

/** Every part marked on the element or around it, nearest first: a control inside a part's surface goes with it, whoever owns it. */
function partsAround(node: MarkupNode): string[] {
  const out: string[] = [];
  for (let n: MarkupNode | null = node; n; n = n.parent) {
    const part = n.attrs["data-part"];
    if (part !== undefined) out.push(part);
  }
  return out;
}

function inside(node: MarkupNode, attr: string): boolean {
  for (let n: MarkupNode | null = node; n; n = n.parent) if (n.attrs[attr] !== undefined) return true;
  return false;
}

/** Whether an element is a control by the seeds the control-site scan counts (controlSites.ts), read off the drawn element. */
function controlKind(node: MarkupNode): string | null {
  const { tag, attrs } = node;
  if (NATIVE_CONTROLS.includes(tag)) return "native";
  if (tag === LINK.tag && attrs[LINK.attribute] !== undefined) return "link";
  if (attrs.role !== undefined && INTERACTIVE_ROLES.includes(attrs.role)) return "role";
  if (attrs[FOCUS_STOP.attribute.toLowerCase()] === String(FOCUS_STOP.value)) return "tabIndex";
  const editable = attrs[EDITABLE.attribute.toLowerCase()];
  if (editable !== undefined && editable !== "false") return "contentEditable";
  return null;
}

/** A control's name, as a reader would hear it, from its words and labels, never from ids, which change with every drawing. */
function nameOf(node: MarkupNode, byId: ReadonlyMap<string, MarkupNode>, labelFor: ReadonlyMap<string, MarkupNode>): string {
  const { attrs } = node;
  if (attrs["aria-label"]) return attrs["aria-label"];
  if (attrs["aria-labelledby"]) return attrs["aria-labelledby"].split(/\s+/).map((id) => textOf(byId.get(id))).join(" ").trim();
  const forLabel = attrs.id ? labelFor.get(attrs.id) : undefined;
  if (forLabel) return textOf(forLabel);
  for (let n = node.parent; n; n = n.parent) if (n.tag === "label") return textOf(n);
  return textOf(node) || attrs.placeholder || attrs.title || attrs.name || attrs.value || "";
}

/** A drawn control: its key, its owner, every part around it (`within`, its owner first), whether a listed part took it from inside another's (`taken`), and whether it is a way back. */
export type Control = { key: string; owner: string; within: readonly string[]; taken: boolean; wayBack: boolean };
export type Anchor = { id: string; owner: string; within: readonly string[]; wayBack: boolean };

/** What a drawing holds: its controls in order, its anchors, its parts and its Hidden on this device lines. */
export type Drawing = { controls: Control[]; anchors: Anchor[]; parts: Set<string>; lines: Map<string, string[]> };

/** An option a part takes from inside a shared control its gate cannot mark, such as one radio of a Segmented: the surface, the control's key without its count, the part, and why. */
export type InnerOwner = { surface: string; key: string; owner: ModuleId; why: string };

export function readDrawing(html: string, surface: string, inner: readonly InnerOwner[]): Drawing {
  const root = parseMarkup(html);
  const nodes = [...walk(root)];
  const byId = new Map(nodes.flatMap((n) => (n.attrs.id ? [[n.attrs.id, n] as const] : [])));
  const labelFor = new Map(nodes.flatMap((n) => (n.tag === "label" && n.attrs.for ? [[n.attrs.for, n] as const] : [])));
  const seen = new Map<string, number>();
  const controls: Control[] = [];
  const anchors: Anchor[] = [];
  const parts = new Set<string>();
  const lines = new Map<string, string[]>();
  for (const node of nodes) {
    const part = node.attrs["data-part"];
    if (part !== undefined) parts.add(part);
    const home = node.attrs["data-hidden-here"];
    if (home !== undefined) lines.set(home, [...walk(node)].filter((n) => n.tag === "button").map((n) => textOf(n)));
    // A chip menu's Show items are the menu home's way back, items where a menu holds no line (D-261127-632).
    const menuShow = node.attrs["data-chip-item"]?.startsWith("show:") === true;
    if (menuShow) lines.set("menu", [...(lines.get("menu") ?? []), textOf(node)]);
    const wayBack = inside(node, "data-hidden-here") || menuShow;
    if (node.attrs["data-search"] !== undefined) anchors.push({ id: node.attrs["data-search"], owner: ownerAt(node), within: partsAround(node), wayBack });
    if (controlKind(node) === null) continue;
    const role = node.attrs.role;
    const type = node.tag === "input" ? `[${node.attrs.type ?? "text"}]` : "";
    const search = node.attrs["data-search"];
    const base = `${node.tag}${role ? `[role=${role}]` : ""}${type} "${nameOf(node, byId, labelFor).slice(0, 90)}"${search ? ` @${search}` : ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const taken = inner.find((o) => o.surface === surface && o.key === base)?.owner;
    const owner = taken ?? ownerAt(node);
    controls.push({ key: n === 1 ? base : `${base} #${n}`, owner, within: taken ? [taken, ...partsAround(node)] : partsAround(node), taken: taken !== undefined, wayBack });
  }
  return { controls, anchors, parts, lines };
}

// ------------------------------------------------------------ drawing

const noop = () => {};
/** The room's actions and setters, every one a no-op a drawing never calls. */
const ACTIONS = new Proxy({ dispatch: () => 1, newId: () => "x" } as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : noop) });
const UI = new Proxy({} as Record<string, unknown>, { get: () => noop });

export type Fixture = {
  surface: string;
  name: string;
  roles: readonly Role[];
  /** The claim conditions that hold in this drawing (D-261127-311): Floors' one-floor scene. */
  conditions?: ClaimConditions;
  /** The homes the drawing stands, each with the creature it names parts for. */
  homes?: readonly { home: Home; holder?: Holder }[];
  room?(): RoomState;
  sceneId?: string;
  local?: Partial<LocalUi>;
  seed?(scope: RoomScope, role: Role): void;
  /** A part's own panel or tool, which Room draws only while the part shows, drawn inside its `data-part` as Room shows a part's own. */
  own?: { kind: "panel" | "tool"; id: string };
  draw(role: Role): ReactElement;
};

/** The part a fixture's own panel or tool belongs to, if any. */
export function ownPart(fixture: Fixture): ModuleId | null {
  return fixture.own ? (ownerOf(fixture.own.kind, fixture.own.id)?.module ?? null) : null;
}

const scopes: RoomScope[] = [];

/** Lets go of what the drawings started. */
export function disposeDrawn(): void {
  for (const scope of scopes.splice(0)) scope.dispose();
}

/** The fixture drawn as a role, with whatever this device's choices are now. */
export function draw(fixture: Fixture, role: Role): string {
  const state = (fixture.room ?? tableRoom)();
  const viewer = role === "dm" ? DM : P1;
  const view = viewOf(state, viewer, fixture.sceneId ? { sceneId: fixture.sceneId } : {});
  const room: RoomView = {
    ...(view as RoomView),
    floorView: view.view,
    projectedSceneId: view.sceneId,
    connection: "open",
    online: [],
    accessVersion: 0,
    joinRequestsVersion: 0,
    ephemeral: EMPTY_EPHEMERAL,
    ephemeralFloors: NO_FLOOR_EPHEMERAL,
    toasts: [],
    ended: null,
    confirmed: null,
    pending: [],
    refused: [],
    trapped: [],
    sceneLoad: SCENE_LOAD_IDLE,
    history: EMPTY_HISTORY,
    local: { ...INITIAL_LOCAL, ...view.local, ...fixture.local },
  } as unknown as RoomView;
  const store = createStore(() => room);
  const scope = new RoomScope();
  scopes.push(scope);
  // Every group open, so each draws its controls rather than its fold alone.
  openFolds(scope.get(dmPanelFoldsSlot), DM_FOLDS);
  openFolds(scope.get(scenesFoldsSlot), SCENE_FOLDS);
  for (const key of FOLD_KEYS) scope.get(panelFoldsSlot).reveal(key);
  fixture.seed?.(scope, role);
  currentScope = scope;
  const part = ownPart(fixture);
  const body = fixture.draw(role);
  return renderToStaticMarkup(
    createElement(RoomScopeProvider, {
      scope,
      children: createElement(RoomProvider, {
        store: store as never,
        actions: ACTIONS as never,
        ui: UI as never,
        assets: { url: () => "" } as never,
        children: part ? createElement("div", { "data-part": part }, body) : body,
      }),
    }),
  );
}

/** The first element in a component's returned tree that `test` picks, through element children alone. */
function findIn(node: ReactNode, test: (props: Record<string, unknown>) => boolean): Record<string, unknown> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findIn(child, test);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement(node)) return null;
  const props = node.props as Record<string, unknown>;
  if (test(props)) return props;
  return findIn(props.children as ReactNode, test);
}

/** A control's words, from its element children, for `findIn`. */
function words(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(words).join("");
  return isValidElement(node) ? words((node.props as { children?: unknown }).children) : "";
}

/**
 * A component drawn after one press inside its own first render: it runs
 * as part of this wrapper, so the press sets the wrapper's state, and a
 * render to markup draws a state set during render again before it writes
 * (a render phase update). That is the one way a drawing reaches a state
 * the component keeps itself, such as New scene's picked kind.
 */
function pressed<P>(component: (props: P) => ReactNode, props: P, press: (tree: ReactNode, scope: RoomScope) => void, opts: { effects?: boolean } = {}): () => ReactElement {
  return () => {
    let done = false;
    function Pressed() {
      effectsNow.on = opts.effects === true && !done;
      const tree = component(props);
      effectsNow.on = false;
      if (!done) {
        done = true;
        press(tree, currentScope!);
      }
      return tree as ReactElement;
    }
    return createElement(Pressed);
  };
}

/** The scope of the drawing under way, for a press that reaches a slot. */
let currentScope: RoomScope | null = null;

/**
 * While on, an effect runs as it is declared, during render: a press needs
 * that where a component hands its setter out from an effect, as RoomPaste
 * hands out its offer. The test's useEffect shim reads it.
 */
export const effectsNow: { on: boolean } = ((globalThis as Record<symbol, unknown>)[Symbol.for("parts.markup.effects")] as { on: boolean } | undefined) ?? { on: false };

// ------------------------------------------------------------ the rooms

const RAGE: ClassResource = { id: "rage", name: "Rage", max: 3, used: 1, reset: "shortOne", preset: "barbarian-rage", level: 5, atLevel: 3 };
const HANDS: ClassResource = { id: "hands", name: "Lay on Hands", max: 25, used: 0, reset: "long", pool: true, preset: "paladin-lay-on-hands", level: 5, atLevel: 5 };
/** Barbarian past Rage's preset level, so its level-up asks, and Wizard, so she holds spell slots and Hit Point Dice. */
const BREE_CLASSES: NonNullable<Character["classes"]> = [
  { id: "barbarian", level: 6 },
  { id: "wizard", level: 3 },
];

const STATS: PcStats = {
  abilities: { str: 16, dex: 14, con: 14, int: 8, wis: 12, cha: 10 },
  saves: ["str", "con"],
  skills: {},
  adjust: {},
  defenses: {},
  rolls: [],
};

/**
 * The table every fixture starts from, the room search's seeded room with
 * Bree made a character that holds every Characters part: classes that
 * give her spell slots and Hit Point Dice, two class resources a level
 * behind her Barbarian level (the level-up ask), a stat block synced from
 * D&D Beyond (Re-sync), an owl companion on the map, and a fight on her
 * turn. A clock runs, shown to players, and Bree's Fireball area stands.
 */
export function tableRoom(): RoomState {
  const state = seededRoom();
  const bree = state.characters.bree!;
  state.characters.bree = {
    ...bree,
    level: 9,
    classes: BREE_CLASSES,
    resources: [RAGE, HANDS],
    stats: STATS,
    // A spent use her block no longer lists stands as its own row beside her class resources, so a Uses list draws with them hidden and shows that their own gate holds.
    actor: { ...bree.actor, sheetUrl: "https://www.dndbeyond.com/characters/12345678", uses: { "traits:second-wind": { kind: "day", name: "Second Wind", used: 1, max: 1 } } },
    ddbSync: { at: AT, from: "12345678", base: {} as never, rolls: {} },
  };
  state.tokens.owl = token("owl", { name: "Owl", kind: "npc", ownerIds: ["p1"], companion: { of: "bree", turn: "shared" }, x: 3, y: 2 });
  state.encounter = { rev: 0, round: 1, activeEntryId: "e1", entries: [entry("e1", { tokenId: "tbree", value: 15 }), entry("e2", { tokenId: "g1", value: 12 })] };
  state.clock = { id: "c1", rev: 0, t: 0, shown: true, calendar: { kind: "days" } } as never;
  state.templates.a1 = template("a1", { ownerId: "p1", casterId: "tbree", spell: "Fireball", sceneId: "s1" });
  return state;
}

/** Bree as the table holds her, for the fixtures that take a character. */
const bree = () => tableRoom().characters.bree!;
/** Bree on her own page, where this viewer may add classes and resources (D-261127-423), and on her token, where she holds what she has. */
const BREE_HOLDS: Holder = { classes: BREE_CLASSES, resources: [RAGE, HANDS], ddbSync: { at: AT }, mayAdd: true };
const BREE_TOKEN_HOLDS: Holder = { classes: BREE_CLASSES, resources: [RAGE, HANDS], ddbSync: { at: AT } };

/** The cast table of the save spell tests (docs/design/design-v1-player-save-spell.md 8), Thorn holding Fireball, which has an area to place. */
function castRoom(): RoomState {
  const state = castTable();
  state.characters["thorn-c"] = character("thorn-c", {
    name: "Thorn",
    ownerIds: ["p1"],
    level: 5,
    stats: { ...STATS, spellAbility: "int", rolls: [{ id: "fb", name: "Fireball", kind: "spell", ability: "spell", level: 3, save: { ability: "dex", onPass: "half" }, dice: [{ formula: "8d6", type: "fire", upcast: "1d6" }] }] },
  });
  return state;
}

/** Turns the server's sound switch on, as GET /api/config would, so Scene sound and the Sound panel draw their controls. */
export async function soundOn(): Promise<void> {
  resetServerRoomSoundForTests();
  const real = api.getConfig;
  api.getConfig = (async () => ({ roomSound: true })) as unknown as typeof api.getConfig;
  await serverRoomSound();
  api.getConfig = real;
}

function openFolds<S extends string>(slot: { tap(section: S, open: boolean): void }, sections: readonly S[]): void {
  for (const s of sections) slot.tap(s, true);
}

const PANEL = { close: noop, selectedTokenId: null };
/** A chip's menu handle, open, as the chip's tap leaves it. */
const OPEN_MENU = { kind: "menu", contentId: "parts-menu", open: true, how: "pointer", anchor: { current: null }, box: { current: null }, focusInside: { current: null }, show: noop, close: noop, anchorProps: {} };

/** A menu body in its open popover, as the chip draws it. */
function inMenu(body: ReactElement): ReactElement {
  return createElement(Popover, { handle: OPEN_MENU as never, side: "below", bound: () => ({ left: 0, top: 0, right: 1440, bottom: 900 }), children: body });
}

/** The menu home's hidden parts as the chip menus end with them (ChipMenus.tsx useMenuShows). */
function useMenuShows() {
  return useHiddenHere("menu").map((p) => ({ id: p.id, label: p.label, show: p.show }));
}

/** The DM menu as the DM chip draws it open (ChipMenus.tsx DmMenuBody), its Time item there while Date and time shows, as Room passes it (D-261127-631). */
function DmMenu() {
  const host = useChipHost(OPEN_MENU as never);
  const view = useDmMenuView(useModule("time"), true, null, true);
  const env = useChipEnv(() => null);
  const shows = useMenuShows();
  return createElement(ChipMenuBody, { host, env, label: CHIP_WORDS.dmMenuName, sections: [...dmMenuSections(view), ...showSection(shows)], mark: "dm" });
}

/** The You menu as a player's chip draws it open (ChipMenus.tsx YouMenuBody). */
function YouMenu() {
  const host = useChipHost(OPEN_MENU as never);
  const env = useChipEnv(() => null);
  const memberId = useRoomView((s) => s.you?.memberId ?? "");
  const member = useRoomView((s) => (s.you ? s.view?.members[s.you.memberId] : undefined));
  const characters = useRoomView((s) => s.view?.characters);
  const shows = useMenuShows();
  const sections = [...youMenuSections({ memberId, member, characters: characters ?? {}, preview: false, volume: null }), ...showSection(shows)];
  return createElement(ChipMenuBody, { host, env, label: CHIP_WORDS.youMenuName, sections, mark: "you" });
}

/** The turn card of the fight's turn now, as the alerts column draws it. */
function Turn(props: { folded: boolean }) {
  const alerts = useCombatAlerts();
  return alerts.turn ? createElement(TurnCard, { model: alerts.turn, folded: props.folded, foldable: true, onShow: noop, onDismiss: noop }) : createElement("p", null, "No turn card");
}

const DM_FOLDS = ["handouts", "screens", "check", "link", "display"] as const;
const SCENE_FOLDS = ["floors", "light", "sound", "players", "map", "walls", "scene"] as const;

/** An area's group save, its page shown in Dice, as the guard moves one there while Areas hides (D-261127-393). */
function areaSave(scope: RoomScope): void {
  const page = newPage({ id: "ga", sceneId: "s1", source: { kind: "area", templateId: "a1" }, test: { kind: "save", ability: "dex" }, dc: 15, secret: true, spell: true, switches: { dcShown: true, resultShown: true } });
  scope.get(groupSaveSlot).setState({ page, shownIn: "dice" });
}

const BUILDER_MODES: readonly BuildMode[] = BUILD_MODES.map((m) => m.value).filter((m) => m !== "link");

// ------------------------------------------------------------ the fixtures

/** Every drawn surface of surfaces.ts in the states that show its controls (design section 14's table). DSLOTS's classes, slots, Classes sheet and slot offer are FT-D's to add. */
export const FIXTURES: readonly Fixture[] = [
  { surface: "DM panel", name: "open, Table display unfolded", roles: ["dm"], homes: [{ home: "dmPanel" }], draw: () => createElement(DmPanel as never, PANEL as never) },

  {
    surface: "Scene settings",
    name: "a one-floor scene, every group open",
    roles: ["dm"],
    conditions: { oneFloor: true },
    homes: [{ home: "sceneSettings" }],
    draw: () => createElement(SceneSettingsOf, { sceneId: "s1" }),
  },
  {
    surface: "Scene settings",
    name: "a floored scene, every group open",
    roles: ["dm"],
    conditions: { oneFloor: false },
    homes: [{ home: "sceneSettings" }],
    room: towerRoom,
    sceneId: "ground",
    draw: () => createElement(SceneSettingsOf, { sceneId: "ground" }),
  },
  {
    surface: "Scene settings",
    name: "a floor's page open in Floors",
    roles: ["dm"],
    conditions: { oneFloor: false },
    room: towerRoom,
    sceneId: "ground",
    draw: pressed(FloorsGroupOf, { sceneId: "ground" }, (tree) => {
      const rows = findIn(tree, (p) => typeof p.onOpen === "function" && p.sceneId === "ground");
      (rows?.onOpen as ((id: string) => void) | undefined)?.("upper");
    }),
  },

  {
    surface: "New scene",
    name: "Builder picked",
    roles: ["dm"],
    homes: [{ home: "newScene" }],
    draw: pressed(NewScene, { sceneCount: 2, close: noop }, (tree) => {
      const kinds = findIn(tree, (p) => p.label === "Kind of scene");
      (kinds?.onChange as ((k: string) => void) | undefined)?.("builder");
    }),
  },

  ...BUILDER_MODES.map(
    (mode): Fixture => ({
      surface: "Builder options",
      name: `mode ${mode}`,
      roles: ["dm"],
      own: { kind: "tool", id: "build" },
      local: { tool: "build" },
      seed: (s) => s.get(builderSlot).store.setState({ mode }),
      draw: () => createElement(BuilderOptions as never),
    }),
  ),
  {
    surface: "Builder options",
    name: "mode link, on a floored scene",
    roles: ["dm"],
    own: { kind: "tool", id: "build" },
    room: towerRoom,
    sceneId: "ground",
    local: { tool: "build" },
    seed: (s) => s.get(builderSlot).store.setState({ mode: "link" }),
    draw: () => createElement(BuilderOptions as never),
  },

  { surface: "Time, Sound, Initiative, Log, Members", name: "Time with a clock running", roles: ["dm", "player"], own: { kind: "panel", id: "time" }, draw: () => createElement(TimePanel as never, PANEL as never) },
  { surface: "Time, Sound, Initiative, Log, Members", name: "Sound", roles: ["dm", "player"], own: { kind: "panel", id: "sound" }, draw: () => createElement(SoundPanel as never, PANEL as never) },
  { surface: "Time, Sound, Initiative, Log, Members", name: "Initiative in a fight", roles: ["dm", "player"], draw: () => createElement(TrackerPanel as never, PANEL as never) },
  { surface: "Time, Sound, Initiative, Log, Members", name: "the turn card, full", roles: ["player"], draw: () => createElement(Turn, { folded: false }) },
  { surface: "Time, Sound, Initiative, Log, Members", name: "the turn card, folded", roles: ["player"], draw: () => createElement(Turn, { folded: true }) },
  { surface: "Time, Sound, Initiative, Log, Members", name: "the Log", roles: ["dm", "player"], draw: () => createElement(LogPanel as never, PANEL as never) },
  { surface: "Time, Sound, Initiative, Log, Members", name: "Members", roles: ["dm", "player"], draw: () => createElement(MembersPanel as never, PANEL as never) },

  {
    surface: "Characters",
    name: "Bree's page",
    roles: ["dm", "player"],
    homes: [{ home: "uses", holder: BREE_HOLDS }, { home: "companions" }, { home: "statBlock", holder: BREE_HOLDS }],
    draw: () => createElement(CharacterPage, { character: bree(), close: noop, onAddCompanion: noop, onBlocks: noop, onDelete: () => null }),
  },
  { surface: "Characters", name: "the Characters panel's list", roles: ["dm"], draw: () => createElement(CharactersPanel as never, PANEL as never) },
  {
    surface: "Characters",
    name: "the Characters panel at a player's own page",
    roles: ["player"],
    homes: [{ home: "uses", holder: BREE_HOLDS }, { home: "companions" }, { home: "statBlock", holder: BREE_HOLDS }],
    draw: () => createElement(CharactersPanel as never, PANEL as never),
  },
  { surface: "Characters", name: "Re-sync from D&D Beyond, getting it", roles: ["dm", "player"], draw: () => createElement(ResyncDialog, { characterId: "bree", onClose: noop }) },

  { surface: "Token panel", name: "Bree's token", roles: ["dm", "player"], homes: [{ home: "uses", holder: BREE_TOKEN_HOLDS }], local: { selectedId: "tbree", selectedIds: ["tbree"] }, draw: () => createElement(TokenPanel as never, { ...PANEL, selectedTokenId: "tbree" } as never) },
  { surface: "Token panel", name: "the owl, Bree's companion", roles: ["dm", "player"], homes: [{ home: "companions" }], local: { selectedId: "owl", selectedIds: ["owl"] }, draw: () => createElement(TokenPanel as never, { ...PANEL, selectedTokenId: "owl" } as never) },
  { surface: "Token panel", name: "Bree's companion stat blocks", roles: ["dm", "player"], draw: () => createElement(CharacterBlocksPage, { character: { id: "bree", name: "Bree" }, onBack: noop }) },
  {
    surface: "Token panel",
    name: "the owl's Attach a stat block",
    roles: ["dm", "player"],
    draw: () => createElement(AttachBlockDialog, { token: tableRoom().tokens.owl!, actor: tableRoom().tokens.owl!.actor && "inline" in tableRoom().tokens.owl!.actor ? (tableRoom().tokens.owl!.actor as { inline: object }).inline : undefined, character: { id: "bree", name: "Bree" }, access: { dm: true, owner: true }, onClose: noop }),
  },
  { surface: "Token panel", name: "a goblin", roles: ["dm"], local: { selectedId: "g1", selectedIds: ["g1"] }, draw: () => createElement(TokenPanel as never, { ...PANEL, selectedTokenId: "g1" } as never) },
  {
    surface: "Token panel",
    name: "a goblin's Make a companion open",
    roles: ["dm"],
    draw: pressed(MakeCompanion, { token: tableRoom().tokens.g1! }, (tree) => {
      const opener = findIn(tree, (p) => typeof p.onClick === "function" && words(p.children) === "Make a companion");
      (opener?.onClick as (() => void) | undefined)?.();
    }),
  },

  { surface: "Action bar Uses", name: "Bree's Uses drawer", roles: ["dm", "player"], draw: () => createElement(UsesDrawer, { target: { tokenId: "tbree" }, name: "Bree", onClose: noop }) },
  {
    surface: "Action bar Uses",
    name: "Bree's token bar",
    roles: ["dm", "player"],
    local: { selectedId: "tbree", selectedIds: ["tbree"], actionBar: true },
    draw: () => createElement(TokenActionBar, { token: tableRoom().tokens.tbree!, anchor: { x: 600, y: 400 }, viewport: { width: 1440, height: 900 }, fullAccess: true, onDetails: noop, onClose: noop, tokenHeight: 48 }),
  },

  { surface: "Dialogs and sheets", name: "ResourceSheet, Add", roles: ["dm", "player"], draw: () => createElement(ResourceSheet, { character: bree(), mode: { kind: "add" }, opener: { current: null }, onClose: noop }) },
  { surface: "Dialogs and sheets", name: "ResourceSheet, Edit", roles: ["dm", "player"], draw: () => createElement(ResourceSheet, { character: bree(), mode: { kind: "edit", id: "rage" }, opener: { current: null }, onClose: noop }) },
  { surface: "Dialogs and sheets", name: "the stat block editor at Fill from", roles: ["dm", "player"], draw: () => createElement(PcStatsEditor, { characterId: "bree", onClose: noop }) },
  {
    surface: "Dialogs and sheets",
    name: "the paste dialog with an image",
    roles: ["dm"],
    draw: pressed(RoomPasteHost, {} as never, (_tree, scope) => {
      scope.get(pasteSlot).room?.(new File([new Uint8Array(8)], "map.png", { type: "image/png" }), 1);
    }, { effects: true }),
  },

  {
    surface: "Dice",
    name: "a cast block, its area to place",
    roles: ["player"],
    room: castRoom,
    seed: (s) => s.get(optionSlot).setState({ picked: "c:thorn-c", cast: { key: "c:thorn-c", creature: { characterId: "thorn-c" as CharacterId }, spell: "Fireball", roll: "fb" } as never }),
    draw: () => createElement(PlayerOptions, { view: castRoom() as never, selected: [] }),
  },
  { surface: "Dice", name: "an area's group save in Dice", roles: ["dm"], seed: areaSave, draw: () => createElement(DicePanel as never, PANEL as never) },
  { surface: "Dice", name: "the Dice panel", roles: ["dm", "player"], draw: () => createElement(DicePanel as never, PANEL as never) },

  { surface: "Journal", name: "a page in the editor, a clock running", roles: ["dm"], draw: () => createElement(JournalEditor, { page: tableRoom().journal.town!, folders: [], onClose: noop, onSaved: noop }) },
  { surface: "Journal", name: "a page open in the panel", roles: ["dm", "player"], seed: (s) => s.get(journalSlot).setState({ pageId: "town" }), draw: () => createElement(JournalPanel as never, PANEL as never) },

  { surface: "Chip menus", name: "the DM menu", roles: ["dm"], homes: [{ home: "menu" }], draw: () => inMenu(createElement(DmMenu)) },
  { surface: "Chip menus", name: "the You menu", roles: ["player"], homes: [{ home: "menu" }], draw: () => inMenu(createElement(YouMenu)) },

  { surface: "This device", name: "every section", roles: ["dm", "player"], homes: [{ home: "thisDevice" }], draw: () => createElement(ThisDevice as never) },
];

/** Scene settings for a scene of the room, as the Scenes panel opens it. */
function SceneSettingsOf(props: { sceneId: string }) {
  const scene = useRoomView((s) => s.view?.scenes[props.sceneId]);
  return scene ? createElement(SceneSettings, { scene, others: [], close: noop }) : null;
}

/** The Floors group alone, so a press inside it opens a floor's page. */
function FloorsGroupOf(props: { sceneId: string }): ReactNode {
  const scene = useRoomView((s) => s.view?.scenes[props.sceneId]);
  return scene ? FloorsGroup({ scene, fold: { open: true, onToggle: noop } }) : null;
}

