import type { Character, Member, RoomState } from "#shared/model.ts";

/**
 * What the Remove section of a character's card says before Delete. The
 * delete takes every token and companion of the character on every scene
 * and its rows in the fight. Only what this viewer's own view holds is
 * counted. The rest, such as tokens on other scenes and rows the DM hid,
 * is named in general words every time, since a view cannot tell whether
 * there is any. So the sentence names every kind of thing that goes, and
 * never tells a player something their view does not. A player's delete
 * cannot be undone, which their sentence says. The DM's can, for a
 * character with few enough tokens (server/rooms/undo.ts), so the DM's
 * does not.
 */
export function deleteWarning(view: Pick<RoomState, "tokens" | "encounter">, character: Pick<Character, "id" | "name">, undoable: boolean): string {
  const tokenIds = new Set<string>();
  let tokens = 0;
  let companions = 0;
  for (const token of Object.values(view.tokens)) {
    if (!token) continue;
    if (token.companion?.of === character.id) companions++;
    else if ("ref" in token.actor && token.actor.ref === character.id) tokens++;
    else continue;
    tokenIds.add(token.id);
  }
  const fighting = (view.encounter?.entries ?? []).some((e) => e.characterId === character.id || (e.tokenId !== undefined && tokenIds.has(e.tokenId)));

  const parts: string[] = [];
  if (tokens > 0) parts.push(tokens === 1 ? "its token here" : `its ${tokens} tokens here`);
  if (companions > 0) {
    const count = companions === 1 ? "1 companion" : `${companions} companions`;
    parts.push(parts.length === 0 ? (companions === 1 ? "its companion" : `its ${count}`) : count);
  }
  if (fighting) parts.push("its place in the fight");
  const what =
    parts.length === 0 ? "every token, companion and place in the fight it has, on every map" : `${listed(parts)}, and any other token, companion or place in the fight it has`;
  return `Deleting ${character.name} also removes ${what}.${undoable ? "" : " This cannot be undone."}`;
}

/**
 * Why a player's card for a character they share has no Delete: only one
 * they play alone is theirs to delete (shared/permissions.ts playsAlone).
 * It names the other players as the roster names them, and says "someone
 * else" when an owner is no longer on the roster.
 */
export function sharedNote(memberId: string, character: Pick<Character, "name" | "ownerIds">, members: Readonly<Record<string, Pick<Member, "name"> | undefined>>): string {
  const others = character.ownerIds.filter((id) => id !== memberId).map((id) => members[id]?.name?.trim() ?? "");
  if (others.length === 0 || others.some((name) => name === "")) return `Someone else plays ${character.name} too, so only the DM can delete it.`;
  if (others.length === 1) return `You and ${others[0]} both play ${character.name}, so only the DM can delete it.`;
  return `You, ${listed(others)} all play ${character.name}, so only the DM can delete it.`;
}

/** "a", "a and b", "a, b and c". */
function listed(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
