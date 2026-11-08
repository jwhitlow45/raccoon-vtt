import { onPlayersScene, openFloor } from "#shared/rules/floors.ts";
import type { IconName } from "../../../components/Icon.tsx";
import { dmMenuSections, type ChipItem, type DmMenuView } from "../../../pages/chipMenus.ts";
import { audienceDetail, CHIP_WORDS, type DmItemKind } from "../../../pages/chipWords.ts";
import type { RoomView } from "../../../state/types.ts";
import { TIME_ENTRIES } from "../../clock/search.ts";
import { DM_MEMBERS_ENTRIES, DM_PANEL_ENTRIES } from "../../dm/search.ts";
import { TRACKER_ENTRIES } from "../../encounter/search.ts";
import { entryKey } from "../../handouts/recentList.ts";
import { SCENES_ENTRIES } from "../../scenes/search.ts";
import { ROOM_SETTINGS_ENTRIES } from "../../settings/search.ts";
import { SOUND_ENTRIES } from "../../sound/search.ts";
import { DM_CHARACTERS_ENTRIES, DM_TOKEN_FIELDS } from "../../tokens/dmSearch.ts";
import type { SearchRoute } from "../entry.ts";
import { recordPage, SUGGEST } from "../index.ts";
import type { Catalog, CatalogEntry } from "./types.ts";
import { onOff } from "./write.ts";

/**
 * The DM's part of the search (docs/design/design-v1-qol.md 5, Loading and Players): the DM
 * panel, Room settings, the DM's part of Members, Scenes, Time, Sound,
 * Initiative, Characters' party rest, the token panel's DM fields, the DM's
 * panels' words and the adapter from the DM menu's items with their twins.
 * Only dmCatalog.ts loads it, by a dynamic import behind a strict role
 * check, so it is a chunk of its own that a player's device never asks
 * for. A static import anywhere else would fold it into the room's chunk,
 * and dmCatalog.test.ts's source scan fails on one, as on any other import
 * of the feature files whose DM entries this gathers.
 */

/** The DM menu's kinds the search finds. Time and Now playing stand in for the bar's chips that gave way, and the search reaches those as panels (design-v1-qol.md 5, What it finds). */
export type SearchedItemKind = Exclude<DmItemKind, "time" | "nowPlaying">;

export function searchedKind(kind: ChipItem["kind"]): kind is SearchedItemKind {
  return kind !== "time" && kind !== "nowPlaying" && kind !== "cancel" && kind !== "sheet" && kind !== "xcard";
}

const screens = (anchor: string): SearchRoute => ({ panel: "dm", section: "screens", anchor });
const handouts = (anchor: string): SearchRoute => ({ panel: "dm", section: "handouts", anchor });
/** The scene the DM looks at, by its row in Scenes. */
const sceneRow = (view: DmMenuView): SearchRoute => (view.viewing ? { panel: "scenes", page: recordPage("scene", view.viewing.id) } : { panel: "scenes" });

/**
 * Each kind of item's twin (design-v1-qol.md 5, Acting): the panel control that does the
 * same, which Shift+Enter goes to without pressing it. An item and its twin
 * are one row: the twin has no entry of its own (dm/search.ts). A kind
 * added to the menu without a twin here fails to typecheck, and
 * catalog.test.ts fails on a kind the menu draws with no row.
 */
export const TWINS: Readonly<Record<SearchedItemKind, (view: DmMenuView) => SearchRoute>> = {
  blackout: () => screens("dm.screens.blackout"),
  endBlackout: () => screens("dm.screens.blackout"),
  follow: () => screens("dm.screens.follow"),
  bringEveryone: () => screens("dm.screens.bring"),
  movePlayers: sceneRow,
  showPlayers: sceneRow,
  // The scene in view's own Show a phase, in its Map and grid (phases/PhasesSection.tsx).
  phase: () => ({ panel: "scenes", section: "map", anchor: "scenes.map.phases" }),
  hideHandout: () => handouts("dm.handouts"),
  showRecent: () => handouts("dm.handouts.recent"),
  showHandout: () => handouts("dm.handouts.show"),
  viewAs: () => ({ panel: "dm", section: "check", anchor: "dm.preview.view-as" }),
};

/** What the search adds to an item's own words, by its kind: its icon, other names, best bets and place on Suggested. */
const ITEM_WORDS: Readonly<Record<SearchedItemKind, { icon: IconName; names?: readonly string[]; bets?: readonly string[]; suggest?: number }>> = {
  blackout: { icon: "hidden", names: ["pause the game"], bets: ["pause", "blackout"], suggest: SUGGEST.blackout },
  endBlackout: { icon: "shown", names: ["resume", "unpause"], bets: ["blackout"], suggest: SUGGEST.blackout },
  showPlayers: { icon: "shown", names: ["reveal the scene"] },
  follow: { icon: "dm", names: ["follow the dm"] },
  bringEveryone: { icon: "dm", names: ["move players' maps"] },
  movePlayers: { icon: "scenes", names: ["send players here", "change scene"] },
  phase: { icon: "scenes", names: ["map phase"] },
  hideHandout: { icon: "hidden", names: ["close handout"] },
  showRecent: { icon: "library", names: ["show again"] },
  showHandout: { icon: "library", names: ["picture", "image", "pdf", "letter"], suggest: SUGGEST.showHandout },
  viewAs: { icon: "viewAs", names: ["preview"] },
};

/**
 * The DM menu's items as the search's rows (design-v1-qol.md 5, Acting and
 * What keeps it current): each titled as the menu titles it, a recent showing
 * with its audience ("Show
 * Belak's letter to Pat", design-v1-qol.md 10, The catalogs), and running the item's own function,
 * found by its id in `dmMenuSections` when picked, so the menu and the
 * search send the same op.
 */
export function dmMenuEntries(view: DmMenuView): CatalogEntry[] {
  const recent = new Map(view.recent.map((e) => [`recent:${entryKey(e)}`, e]));
  const out: CatalogEntry[] = [];
  for (const s of dmMenuSections(view)) {
    // The blackout's two items lead the menu with no heading of their own, under the chip that opens them.
    const where = `${CHIP_WORDS.dmMenuName} menu · ${s.heading ?? CHIP_WORDS.playersSeeBlack}`;
    for (const item of s.items) {
      if (!searchedKind(item.kind)) continue;
      const kind = item.kind;
      const { icon, ...words } = ITEM_WORDS[kind];
      const shown = recent.get(item.id);
      // The members a re-show goes to, as the menu names them (chipMenus.ts audienceNames).
      const names = shown && shown.to !== "all" ? shown.to.map((id) => view.members[id]?.name ?? "").filter((n) => n !== "") : "all";
      out.push({
        id: `item:${item.id}`,
        kind: "action",
        title: shown ? `${item.title} ${audienceDetail(names)}` : item.title,
        ...words,
        where,
        icon,
        // Black out stands in the menu only while off, so its row says nothing more. Follow me's says which way it stands.
        ...(item.role === "checkbox" && kind !== "blackout" ? { value: onOff(item.checked === true) } : kind === "movePlayers" && item.note ? { value: item.note } : null),
        ...(item.description ? { description: item.description } : null),
        act: { t: "item", itemId: item.id, twin: TWINS[kind](view) },
      });
    }
  }
  return out;
}

/**
 * The DM menu's view from the room's state alone, for an index built
 * without the menu's own (catalog/types.ts SearchContext): no recent
 * showings, and Bring everyone here offered wherever the DM looks at the
 * players' scene, since its run checks the camera itself.
 */
export function dmMenuViewOf(state: Pick<RoomView, "view" | "sceneId">): DmMenuView {
  const view = state.view;
  const playerId = view?.meta.playerSceneId ?? null;
  const playerName = playerId ? view?.scenes[playerId]?.name : undefined;
  return {
    blackout: view?.meta.view.blackout === true,
    follow: view?.meta.view.follow === true,
    viewing: (state.sceneId ? view?.scenes[state.sceneId] : undefined) ?? null,
    playerScene: playerId && playerName !== undefined ? { id: playerId, name: playerName } : null,
    playersHoldHere: view && state.sceneId ? openFloor(view, state.sceneId) : false,
    playersSceneHere: view && state.sceneId ? onPlayersScene(view, state.sceneId) : false,
    focusHere: true,
    handouts: view?.handouts ?? {},
    handoutDocs: view?.handoutDocs ?? {},
    members: view?.members ?? {},
    recent: [],
    images: null,
    time: null,
    nowPlaying: false,
    movingTo: null,
    revealing: null,
    outShown: false,
  };
}

export const DM_CATALOG: Catalog = {
  entries: [...DM_PANEL_ENTRIES, ...ROOM_SETTINGS_ENTRIES, ...DM_MEMBERS_ENTRIES, ...SCENES_ENTRIES, ...TIME_ENTRIES, ...SOUND_ENTRIES, ...TRACKER_ENTRIES, ...DM_CHARACTERS_ENTRIES],
  fields: DM_TOKEN_FIELDS,
  panels: { dm: { names: ["dm tools"] }, monsters: { names: ["creatures", "bestiary"] }, scenes: { names: ["maps"] } },
  items: (ctx) => (ctx.role === "dm" && ctx.state.view ? dmMenuEntries(ctx.dmMenu ?? dmMenuViewOf(ctx.state)) : []),
};
