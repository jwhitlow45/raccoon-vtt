import { parseRoomId } from "./roomId.ts";

/**
 * DM links and device invites (design section 10.2).
 *
 * A DM link is `/r/<roomId>#dm=<key>` and an invite link is
 * `/r/<roomId>#invite=<token>`. The secret travels in the fragment because a
 * fragment never reaches the server in a request line, a Referer or a log.
 * Both secrets are 32 random bytes as base64url, 43 characters.
 */
export type FragmentSecret = { kind: "dm" | "invite"; secret: string };

export type ClaimInput =
  | { kind: "dm" | "invite"; roomId: string; secret: string }
  /** An invite token typed without its link. The server finds the room from the token. */
  | { kind: "bareInvite"; secret: string };

/** Lenient on length so a future key size still parses. Only the server decides validity. */
const SECRET = /^[A-Za-z0-9_-]{16,128}$/;

function cleanSecret(raw: string): string | null {
  const secret = raw.trim().replace(/=+$/, "");
  return SECRET.test(secret) ? secret : null;
}

/** Reads `#dm=` or `#invite=` from a location hash. */
export function parseFragment(hash: string): FragmentSecret | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  for (const kind of ["dm", "invite"] as const) {
    const raw = params.get(kind);
    if (raw === null) continue;
    const secret = cleanSecret(raw);
    return secret ? { kind, secret } : null;
  }
  return null;
}

/**
 * What a DM pastes into "Enter a DM link or invite": a full link (from any
 * origin, since only its path and fragment matter), a path with a fragment,
 * or a bare invite token. A bare DM key is not accepted, because the server
 * stores keys per room and needs the room from the link.
 */
export function parseClaimInput(input: string): ClaimInput | null {
  const text = input.trim();
  if (text === "") return null;
  if (!text.includes("#") && !text.includes("/")) {
    const secret = cleanSecret(text.replace(/^invite=/, ""));
    return secret ? { kind: "bareInvite", secret } : null;
  }
  let url: URL;
  try {
    url = new URL(text, "https://link.invalid");
  } catch {
    return null;
  }
  const fragment = parseFragment(url.hash);
  if (!fragment) return null;
  const match = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
  const roomId = match ? parseRoomId(decodeURIComponent(match[1]!)) : null;
  if (roomId) return { kind: fragment.kind, roomId, secret: fragment.secret };
  return fragment.kind === "invite" ? { kind: "bareInvite", secret: fragment.secret } : null;
}
