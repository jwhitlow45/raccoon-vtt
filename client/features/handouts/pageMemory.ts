import { scopeSlot } from "../../state/scope.ts";

/**
 * The page a reader was on, per showing (docs/design-v1-pdf-handouts.md
 * 5.1): the popup's `showingKey`, or the Library's `doc:<id>` or
 * `image:<id>`. The viewer writes it whenever its current page changes and
 * reads it every time a showing starts in it, so a handout closed on page 2
 * and opened again from the Library opens on page 2, and the popup moving
 * to another handout and back finds each one's page.
 *
 * It lives in the room's scope, so it lasts while the room is open on this
 * device and is never stored: a reload starts every handout at page 1, and
 * "view as a player" keeps a memory of its own.
 */
export type PageMemory = Map<string, number>;

export const pageMemorySlot = scopeSlot<PageMemory>(() => new Map());

/** A session shows a few dozen handouts at most. Past this the oldest are forgotten. */
const MAX_REMEMBERED = 200;

/** The page to open a showing at, from 0. */
export function rememberedPage(memory: PageMemory, showing: string): number {
  return memory.get(showing) ?? 0;
}

export function rememberPage(memory: PageMemory, showing: string, page: number): void {
  // Written again as the newest, so the oldest is the one forgotten.
  memory.delete(showing);
  memory.set(showing, page);
  if (memory.size > MAX_REMEMBERED) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
}
