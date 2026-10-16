/*
 * The toolbar's order in one table (docs/design-v1-layout-hierarchy.md M1),
 * so the hierarchy reads in one place and runs under node --test, which
 * cannot load the tools' own files. Each tool's definition takes its
 * `order` from here.
 *
 * The DM's play tools come first, Fog fourth: it is the DM's busiest tool
 * after Select while exploring, and was eighth, past a phone's swipe. Then
 * a divider and the setup tools: Add token, Pin, Map builder and Line up
 * grid serve a scene being set up. A player's tools keep their order.
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
  build: 80,
  grid: 90,
} as const;

/** The tools for setting a scene up rather than playing in it, which stand past the divider. */
export const SETUP_TOOLS: ReadonlySet<string> = new Set(["add-token", "pin", "build", "grid"]);

/** The index in a toolbar's tools before which the divider stands: its first setup tool, or null when it has none or only those. */
export function setupDivider(tools: readonly { id: string }[]): number | null {
  const at = tools.findIndex((t) => SETUP_TOOLS.has(t.id));
  return at > 0 ? at : null;
}

/** Setup in the toolbar, which stands for the setup tools on a phone (docs/design-v1-tool-options.md 5.1). */
export const SETUP_BUTTON = "setup";

/**
 * The buttons a toolbar draws for a role's tools, in order, and where its
 * divider stands. On the phone layout a DM's setup tools stand behind one
 * Setup button after the divider, so seven buttons and Panels fit a 390 px
 * phone. From 900 px up every tool shows, as a computer has the room and a
 * DM preparing a scene switches between them often. A player has no setup
 * tools, so nothing changes for them.
 */
export function toolbarButtons(tools: readonly { id: string }[], wide: boolean): { ids: string[]; divider: number | null } {
  const setup = tools.filter((t) => SETUP_TOOLS.has(t.id));
  const play = tools.filter((t) => !SETUP_TOOLS.has(t.id));
  if (wide || setup.length === 0 || play.length === 0) return { ids: tools.map((t) => t.id), divider: setupDivider(tools) };
  return { ids: [...play.map((t) => t.id), SETUP_BUTTON], divider: play.length };
}
