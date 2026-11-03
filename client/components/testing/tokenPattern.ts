/**
 * A token's value as regex source, for a test that finds a style in
 * rendered markup. A palette token is a CSS variable with its dark value as
 * the fallback (lib/theme.ts), and its parentheses would read as a group.
 */
export function tokenPattern(token: string): string {
  return token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
