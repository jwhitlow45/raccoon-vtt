/**
 * Pure helpers for the DM's access tools (design section 10.2): device
 * invites, the devices list and the player password. Kept apart from the
 * components so they run under plain Node in the tests.
 */

/** Device invites live 10 minutes on the server. */
export const INVITE_MINUTES = 10;

export type InviteCountdown = { expired: boolean; msLeft: number; text: string };

/**
 * What an invite card says about its expiry, such as "Expires in 9:42".
 * The server's `expiresAt` is the truth, so a device whose clock runs fast
 * shows the invite as expired early rather than offering a dead link.
 */
export function inviteCountdown(expiresAt: string, now: number): InviteCountdown {
  const at = Date.parse(expiresAt);
  if (Number.isNaN(at)) return { expired: true, msLeft: 0, text: "Expired" };
  const msLeft = Math.max(0, at - now);
  if (msLeft === 0) return { expired: true, msLeft: 0, text: "Expired" };
  const seconds = Math.ceil(msLeft / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return { expired: false, msLeft, text: `Expires in ${m}:${String(s).padStart(2, "0")}` };
}

/** The server answers with a path (`/r/<id>#invite=...`). A QR code needs the whole URL. */
export function absoluteLink(link: string, origin: string): string {
  return new URL(link, origin).href;
}

/** "Seen 5 minutes ago" for the DM devices list. */
export function lastSeenText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "Last seen: unknown";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 2) return "Seen just now";
  if (minutes < 60) return `Seen ${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `Seen ${hours} ${hours === 1 ? "hour" : "hours"} ago`;
  return `Seen ${Math.floor(hours / 24)} days ago`;
}

/**
 * What the devices list says about when a device was last around. A device
 * with a socket open is in use now, so its stored time, which only moves on
 * HTTP requests and when a socket closes, is not the answer.
 */
export function deviceSeenText(device: { lastSeenAt: string; online?: boolean; current?: boolean }, now: number): string {
  if (device.current) return "In use on this device";
  if (device.online) return "Online now";
  return lastSeenText(device.lastSeenAt, now);
}

/** Whether the invite on screen was used, from the server's list of this device's invites. Found by its expiry time. */
export function inviteUsed(invites: readonly { expiresAt: string; used: boolean }[] | undefined, expiresAt: string): boolean {
  return invites?.some((i) => i.expiresAt === expiresAt && i.used) ?? false;
}

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

/**
 * The client half of the password rule (design 10.1): length only. The
 * server also refuses the 10,000 most common passwords, and says so when it
 * does. Characters are counted as the server counts them, by code point, so
 * an emoji is one.
 */
export function passwordProblem(password: string): string | null {
  const length = [...password].length;
  if (length < PASSWORD_MIN) return `At least ${PASSWORD_MIN} characters.`;
  if (length > PASSWORD_MAX) return `At most ${PASSWORD_MAX} characters.`;
  return null;
}

/** The server's refusal reasons for a player password, in words. */
export function weakPasswordText(reason: unknown): string {
  switch (reason) {
    case "too_short":
      return `The password needs at least ${PASSWORD_MIN} characters.`;
    case "too_long":
      return `The password can have at most ${PASSWORD_MAX} characters.`;
    case "too_common":
      return "That password is too common. Pick another one, or use the suggestion.";
    default:
      return "The server did not accept that password. Try another one.";
  }
}
