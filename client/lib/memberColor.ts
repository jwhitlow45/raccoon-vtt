import { accentFor, luminance } from "./accent.ts";
import { MEMBER_COLOR_NAMES, MEMBER_COLORS, theme } from "./theme.ts";

/**
 * Who uses which member color, for the swatches on the join page and in the
 * Members color picker (docs/design-v1-visual.md 4.4). Both read real
 * colors: the picker reads the whole roster, and the join page the players
 * it lists plus the DMs' current colors from the join step, which names no
 * DM. Neither assumes the DM is yellow, since a DM can change color.
 */

type Named = { name: string; color: string };

function same(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * The color a new player starts with on the join page (features section
 * 12: each player draws in their own color by default): the first in the
 * palette nobody uses yet, or, with every one taken, the one used least.
 */
export function freeColor(taken: readonly string[], dmColors: readonly string[] = [], palette: readonly string[] = MEMBER_COLORS): string {
  const uses = new Map(palette.map((c) => [c.toLowerCase(), 0]));
  for (const color of [...taken, ...dmColors]) {
    const key = color.toLowerCase();
    const n = uses.get(key);
    if (n !== undefined) uses.set(key, n + 1);
  }
  // A DM's color goes last, so a tie never hands it to a player.
  const dms = (c: string) => dmColors.some((d) => same(d, c));
  const order = [...palette.filter((c) => !dms(c)), ...palette.filter(dms)];
  let best = order[0]!;
  let fewest = Infinity;
  for (const c of order) {
    const n = uses.get(c.toLowerCase())!;
    if (n < fewest) {
      best = c;
      fewest = n;
    }
  }
  return best;
}

/**
 * Who already uses a color, for the swatch's name ("Dana and Lee", "Pat and
 * a DM", "2 DMs"), or null when nobody does. `dmColors` are DMs known only
 * by their color, as on the join page.
 */
export function colorUsers(color: string, players: readonly Named[], dmColors: readonly string[] = []): string | null {
  const names = players.filter((p) => same(p.color, color)).map((p) => p.name);
  const dms = dmColors.filter((c) => same(c, color)).length;
  if (dms === 1) names.push("a DM");
  else if (dms > 1) names.push(`${dms} DMs`);
  return names.length > 0 ? listOf(names) : null;
}

/**
 * The few letters on a swatch someone uses: one player's initial, "DM" for
 * DMs alone, or how many share it once a single initial would leave
 * someone out. The swatch's name always lists them all.
 */
export function colorBadge(color: string, players: readonly Named[], dmColors: readonly string[] = []): string | undefined {
  const named = players.filter((p) => same(p.color, color));
  const dms = dmColors.filter((c) => same(c, color)).length;
  if (named.length === 0) return dms > 0 ? "DM" : undefined;
  if (named.length === 1 && dms === 0) return initial(named[0]!.name);
  return String(named.length + dms);
}

/**
 * The member palette as swatches (components/Swatches.tsx), each named by
 * its color and who uses it ("Green, used by Pat") and badged. A current
 * color outside the palette, which an older join form or a hand-made op may
 * have stored, comes first as "Current color", so the chosen swatch is
 * always on the row. It goes once a palette color is picked.
 */
export function memberSwatches(users: { players: readonly Named[]; dmColors?: readonly string[]; current?: string | null }): { color: string; name: string; badge?: string }[] {
  const dmColors = users.dmColors ?? [];
  const options: { color: string; name: string; badge?: string }[] = MEMBER_COLORS.map((color) => {
    const usedBy = colorUsers(color, users.players, dmColors);
    const name = MEMBER_COLOR_NAMES[color];
    return { color, name: usedBy ? `${name}, used by ${usedBy}` : name, badge: colorBadge(color, users.players, dmColors) };
  });
  const current = users.current;
  if (current && !MEMBER_COLORS.some((c) => same(c, current))) options.unshift({ color: current, name: "Current color" });
  return options;
}

/**
 * What the color picker's preview says when buttons do not wear the picked
 * color as it is (lib/accent.ts), or null when they do.
 */
export function buttonNote(color: string): string | null {
  const accent = accentFor(color).accent;
  if (accent === color.toLowerCase()) return null;
  // The crest orange (question 1 of the design, docs/design-v1-visual.md 6.3), or a color the accent cannot use.
  if (accent === theme.color.crest) return "Buttons stay yellow.";
  return luminance(accent) > luminance(color) ? "Buttons use a lighter shade so they stay readable." : "Buttons use a darker shade so they stay readable.";
}

function initial(name: string): string {
  return (Array.from(name.trim())[0] ?? "?").toUpperCase();
}

function listOf(names: readonly string[]): string {
  if (names.length < 2) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
