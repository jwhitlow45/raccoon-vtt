/*
 * The toolbar's order in one table (docs/design/design-v1-layout-hierarchy.md M1),
 * so the hierarchy reads in one place and runs under node --test, which
 * cannot load the tools' own files. Each tool's definition takes its
 * `order` from here.
 *
 * The DM's play tools come first, Fog fourth: it is the DM's busiest tool
 * after Select while exploring, and was eighth, past a phone's swipe. Then
 * a divider and the setup tools: Add token, Pin, Trap, Map builder and
 * Line up grid serve a scene being set up. A player's tools keep their order.
 */

export const TOOL_ORDER = {
  select: 0,
  ruler: 20,
  area: 30,
  fog: 35,
  draw: 40,
  ping: 50,
  "add-token": 55,
  pin: 60,
  trap: 65,
  build: 80,
  grid: 90,
} as const;

/** The tools for setting a scene up rather than playing in it, which stand past the divider. */
export const SETUP_TOOLS: ReadonlySet<string> = new Set(["add-token", "pin", "trap", "build", "grid"]);

/** The index in a toolbar's tools before which the divider stands: its first setup tool, or null when it has none or only those. */
export function setupDivider(tools: readonly { id: string }[]): number | null {
  const at = tools.findIndex((t) => SETUP_TOOLS.has(t.id));
  return at > 0 ? at : null;
}

/** Setup in the toolbar, which stands for the setup tools on a phone (docs/design/design-v1-tool-options.md 5.1). */
export const SETUP_BUTTON = "setup";

/** Hidden tools in the toolbar, which stands for the tools of parts hidden on this device (docs/design/design-v1-features.md 6). */
export const HIDDEN_TOOLS_BUTTON = "hidden-tools";

/** How many tools of parts hidden on this device the toolbar's way back serves: play tools and setup tools (SETUP_TOOLS). */
export type HiddenToolCounts = { readonly play: number; readonly setup: number };

export const NO_HIDDEN_TOOLS: HiddenToolCounts = { play: 0, setup: 0 };

/**
 * The buttons a toolbar draws for a role's tools, in order, and where its
 * divider stands. On the phone layout a DM's setup tools stand behind one
 * Setup button after the divider, so seven buttons and Panels fit a 390 px
 * phone. From 900 px up every tool shows, as a computer has the room and a
 * DM preparing a scene switches between them often. A player has no setup
 * tools, so nothing changes for them.
 *
 * Hidden tools holds the way back to the tools of parts hidden on this
 * device (D-261127-312): from 900 px up one button after the last tool for
 * all of them, and below it one after the play tools for the play tools
 * alone, a setup tool's way back standing at the foot of Setup's menu. It
 * stands only while it lists a tool, so it never adds to a row more than
 * it took away.
 */
export function toolbarButtons(tools: readonly { id: string }[], wide: boolean, hidden: HiddenToolCounts = NO_HIDDEN_TOOLS): { ids: string[]; divider: number | null } {
  const setup = tools.filter((t) => SETUP_TOOLS.has(t.id));
  const play = tools.filter((t) => !SETUP_TOOLS.has(t.id));
  if (wide) return { ids: [...tools.map((t) => t.id), ...(hidden.play + hidden.setup > 0 ? [HIDDEN_TOOLS_BUTTON] : [])], divider: setupDivider(tools) };
  const back = hidden.play > 0 ? [HIDDEN_TOOLS_BUTTON] : [];
  if (setup.length === 0 || play.length === 0) return { ids: [...tools.map((t) => t.id), ...back], divider: setupDivider(tools) };
  return { ids: [...play.map((t) => t.id), ...back, SETUP_BUTTON], divider: play.length + back.length };
}
