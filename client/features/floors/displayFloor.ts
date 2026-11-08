import type { Scene, SceneId } from "#shared/model.ts";

/**
 * The floor a table display shows (docs/design/design-v1-floors.md 7.3,
 * D-261102-491). Following the DM, the DM's floor while the display holds
 * it. Else the party's: `partyFloors`, the held floors with the most
 * unhidden party members, which the server works out since a display's
 * copy cannot tell a creature that lends sight from one that does not. It
 * keeps the floor it showed last while that is one of them, so a tie never
 * flips the screen, else the lowest of them, and with none the start floor.
 * `held` is bottom first.
 */
export function displayFloor(input: { held: readonly Scene[]; partyFloors: readonly SceneId[]; last: SceneId | null; start: SceneId | null; dm: SceneId | null }): SceneId | null {
  const held = new Set(input.held.map((s) => s.id));
  if (input.dm !== null && held.has(input.dm)) return input.dm;
  const party = new Set(input.partyFloors.filter((id) => held.has(id)));
  if (input.last !== null && party.has(input.last)) return input.last;
  const lowest = input.held.find((s) => party.has(s.id));
  if (lowest) return lowest.id;
  return input.start !== null && held.has(input.start) ? input.start : (input.held[0]?.id ?? input.start);
}
