import { readPlayerFragment } from "#shared/playerLink.ts";
import { roomPath } from "../../lib/roomId.ts";

/**
 * Which join link a device hands out (design 10.2). A DM who can see the
 * player link shares it, so a player taps one link and is in. Everyone else
 * shares the plain room link, which still needs the password: a player has
 * no copy of the password to put in a link, and a DM whose room predates the
 * stored password has none either until the password is changed once.
 *
 * Plain functions, so the tests run without a DOM.
 */
export type ShareLink = { url: string; label: string; withPassword: boolean };

export function joinLinkToShare(input: { roomId: string; origin: string; playerLink: string | null }): ShareLink {
  if (input.playerLink) return { url: new URL(input.playerLink, input.origin).href, label: "Copy player link", withPassword: true };
  return { url: new URL(roomPath(input.roomId), input.origin).href, label: "Copy join link", withPassword: false };
}

/** The password inside a player link the server sent, or null when there is none to read. */
export function passwordOfLink(link: string): string | null {
  const at = link.indexOf("#");
  return at === -1 ? null : (readPlayerFragment(link.slice(at))?.password ?? null);
}
