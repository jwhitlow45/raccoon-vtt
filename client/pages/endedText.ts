import type { Ended } from "../state/types.ts";

/**
 * What the room says once the server closed it for good (design 7.1: 4001,
 * 4003, 4009). The words depend on the role this device had: a DM device
 * signed out, cut off by a replaced DM link, or stripped of DM comes back
 * with the DM link or an invite, never with the player password (UD-21).
 */
export type EndedText = {
  title: string;
  body: string;
  /** The label of the button back to the room's join page, or null when there is no room left to join. */
  rejoin: string | null;
  /** Offer "Enter a DM link or invite" on the spot. */
  dmLink: boolean;
};

export function endedText(kind: Ended["kind"], role: "dm" | "player"): EndedText {
  if (kind === "deleted") return { title: "This room is gone", body: "The DM closed or deleted this room.", rejoin: null, dmLink: false };
  if (role === "dm") {
    return kind === "revoked"
      ? {
          title: "This device is no longer a DM here",
          body: "A DM signed this device out, removed your DM role, or replaced the DM link. To come back as DM, open your DM link again, or an invite from another DM device. If the link was replaced, ask whoever replaced it for the new one.",
          rejoin: "Join as a player",
          dmLink: true,
        }
      : {
          title: "This device could not connect as DM",
          body: "The server did not accept this device as a DM for the room. Open your DM link again to sign back in.",
          rejoin: "Join as a player",
          dmLink: true,
        };
  }
  return kind === "revoked"
    ? {
        title: "You are no longer in this room",
        body: "The DM removed this device, or the player password changed. Join again with the password or a new player link to come back.",
        rejoin: "Join again",
        dmLink: false,
      }
    : {
        title: "This device could not connect",
        body: "The server did not accept this device for the room. Join again to sign in.",
        rejoin: "Join again",
        dmLink: false,
      };
}
