import { PALETTES, type Palette, type Scheme } from "../../lib/theme.ts";

/**
 * A token's value as regex source, for a test that finds a style in
 * rendered markup. A palette token is a CSS variable with its dark value as
 * the fallback (lib/theme.ts), and its parentheses would read as a group.
 */
export function tokenPattern(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The color a token shows in a scheme, for a test that works out a
 * contrast: a palette token's value in that scheme, a fixed one as it is.
 * Throws for a variable that is no palette color, such as the accent, which
 * a test takes from lib/accent.ts instead.
 */
export function tokenValue(token: string, scheme: Scheme = "dark"): string {
  const name = /^var\(--rvtt-([a-z-]+), .+\)$/.exec(token)?.[1];
  if (name === undefined) {
    if (token.startsWith("var(")) throw new Error(`not a palette color: ${token}`);
    return token;
  }
  const key = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as keyof Palette;
  const value = PALETTES[scheme][key];
  if (value === undefined) throw new Error(`not a palette color: ${token}`);
  return value;
}
