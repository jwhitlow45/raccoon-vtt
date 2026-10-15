/**
 * Text from rooms, made safe to print on a terminal. Anyone can create a room
 * and name it, and the admin CLI prints those names in the server's shell,
 * where an escape sequence could retitle the window, clear the screen or
 * rewrite what was printed before. Every control, format, private-use and
 * unassigned character is shown as a `\u{...}` escape instead. That covers
 * C1 controls such as U+009B, which JSON.stringify leaves alone, and bidi
 * controls, so a name cannot reorder the rest of its line either.
 */
export function printable(text: string): string {
  return text.replace(/\p{C}/gu, (c) => `\\u{${(c.codePointAt(0) ?? 0).toString(16)}}`);
}
