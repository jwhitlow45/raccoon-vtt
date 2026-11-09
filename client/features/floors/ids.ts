/*
 * The roots of the floors surfaces (docs/design/design-v1-floors.md 13): the
 * attribute each carries, which the alignment sweep (e2e/alignmentRoom.ts)
 * and the floors e2e files find it by, and the `search=` anchors the room
 * search lands on (features/search/catalog). One list, so every lane names
 * them alike.
 */

/** The attribute every floors root carries, with its value from FLOOR_ROOTS: `[data-floors="menu"]`. */
export const FLOOR_ROOT_ATTR = "data-floors";

export const FLOOR_ROOTS = {
  /** The top bar's Floor button (FloorButton.tsx). */
  button: "button",
  /** The Menu panel's Floor row, where Floor folds (MenuPanel.tsx). */
  menuRow: "menu-row",
  /** The Floors pop-up or sheet (FloorsMenu.tsx). */
  menu: "menu",
  /** The Viewing notice with Back to Thorn (ViewingNotice.tsx). */
  notice: "notice",
  /** The Floors group of a scene's settings (scenes/FloorsGroup.tsx). */
  group: "group",
  /** A floor's page (scenes/FloorPage.tsx). */
  page: "page",
  /** Move to floor's list of floors, in the action bar and the group's More sheet (TokenActionBar.tsx, GroupMoreSheet.tsx). */
  moveList: "move-list",
} as const;

export type FloorRoot = (typeof FLOOR_ROOTS)[keyof typeof FLOOR_ROOTS];

/** The selector of a floors root. */
export function floorRoot(root: FloorRoot): string {
  return `[${FLOOR_ROOT_ATTR}="${root}"]`;
}

/**
 * The `search=` anchors of the floors controls, beside the scene settings'
 * own `scenes.*` ones. Move to floor has none (D-261108-350): it lives on the
 * token's action bar and More sheet, which carry no anchors.
 */
export const FLOOR_SEARCH = {
  group: "scenes.floors",
  addAbove: "scenes.floors.add-above",
  addBelow: "scenes.floors.add-below",
  name: "scenes.floor.name",
  height: "scenes.floor.height",
  players: "scenes.floor.players",
  order: "scenes.floor.order",
  show: "scenes.floor.show",
  remove: "scenes.floor.remove",
} as const;

/*
 * The test ids of stairs and ladders (docs/design/design-v1-floors.md phase
 * 2, 13), which the floors-links e2e files and the alignment sweep find each
 * surface by.
 */

/** An end drawn on the board, its value the end's id: `[data-floor-link="l1"]` (LinkLayer.tsx). */
export const FLOOR_LINK_ATTR = "data-floor-link";
/** Go up or Go down on the bar and the strip, its value "up" or "down": `[data-climb="up"]` (ClimbButton.tsx). */
export const CLIMB_ATTR = "data-climb";
/** An end's pane in the builder's Between floors mode (LinkPane.tsx). */
export const LINK_PANE_ATTR = "data-link-pane";
