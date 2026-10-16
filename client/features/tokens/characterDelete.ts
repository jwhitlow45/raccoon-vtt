import type { Character, RoomState } from "#shared/model.ts";

/**
 * What a player reads before deleting a character they play alone
 * (shared/permissions.ts playsAlone). The delete takes every token and
 * companion of the character on every scene and its rows in the fight,
 * as the DM's does. Only what this player's own view holds is counted.
 * Tokens on other scenes and rows the DM hid get general words, so the
 * sentence never tells them something their view does not.
 */
export function deleteWarning(view: Pick<RoomState, "tokens" | "encounter">, character: Pick<Character, "id" | "name">): string {
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
  const what = parts.length === 0 ? "every token of it on any map" : `${listed(parts)}, and any token of it on another map`;
  return `Deleting ${character.name} also removes ${what}. This cannot be undone.`;
}

/** "a", "a and b", "a, b and c". */
function listed(parts: readonly string[]): string {
  if (parts.length < 2) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
