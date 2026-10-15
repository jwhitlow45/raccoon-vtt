import { ApiError, type MemberSummary } from "../lib/api.ts";
import type { FragmentSecret } from "../lib/links.ts";
import { theme } from "../lib/theme.ts";

/**
 * What the claim page shows once a DM link or a device invite was refused,
 * and whether the secret leaves the address bar. Kept apart from the page,
 * so the choice can be tested without a browser.
 */
export type ClaimRefusal = {
  phase:
    /**
     * This device has no member in the room: pick one of the room's DM
     * members ("This is me") or become someone new (design 10.2). Not a
     * failure, only the server's question.
     */
    | { kind: "choose"; dmMembers: MemberSummary[]; notice: string | null }
    /** Ask the server for the DM members again, then show `notice` with them. */
    | { kind: "reask"; notice: string }
    /** `retry` is set when the request never reached the server, so the same link can be tried again. */
    | { kind: "error"; message: string; retry: boolean };
  dropSecret: boolean;
};

/**
 * `picked` says the claim named a DM member. The server refuses a pick
 * before it spends anything, an invite included, so the same link can
 * simply ask again.
 */
export function claimRefusal(kind: FragmentSecret["kind"], err: unknown, picked = false): ClaimRefusal {
  if (err instanceof ApiError && err.code === "choose_member") {
    return { phase: { kind: "choose", dmMembers: dmChoices(err.detail.dmMembers), notice: null }, dropSecret: false };
  }
  if (picked && err instanceof ApiError && (err.code === "member_removed" || err.code === "not_a_dm")) {
    const notice =
      err.code === "member_removed" ? "That member was just removed from the room. Pick again." : "That member is no longer a DM here. Pick again.";
    return { phase: { kind: "reask", notice }, dropSecret: false };
  }
  if (err instanceof ApiError && err.code === "member_removed") {
    // This device's own member was removed while it claimed. A DM link
    // still works, so it stays in the address bar and asks again. An invite
    // was spent by the claim that found the member gone (server/http/dm.ts),
    // so only a fresh one can help.
    if (kind === "dm") {
      return { phase: { kind: "reask", notice: "Your member was just removed from the room. Pick again, or join as someone new." }, dropSecret: false };
    }
    return {
      phase: {
        kind: "error",
        message: "That member was just removed from the room, and this invite is used up. Ask a DM device for a new one.",
        retry: false,
      },
      dropSecret: true,
    };
  }
  // A refused secret is useless, so it leaves the address bar now. A
  // network failure keeps it, so Retry can send it again.
  const network = err instanceof ApiError && err.status === 0;
  return {
    phase: { kind: "error", message: network ? (err as Error).message : refusalMessage(kind, err), retry: network },
    dropSecret: !network,
  };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * The DM members from a `choose_member` answer. Anything malformed is left
 * out rather than shown, and a member whose color cannot be read gets a
 * muted dot rather than none.
 */
export function dmChoices(raw: unknown): MemberSummary[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).flatMap((m: unknown) => {
    if (!m || typeof m !== "object") return [];
    const { id, name, color } = m as Record<string, unknown>;
    if (typeof id !== "string" || typeof name !== "string" || id === "" || name === "") return [];
    return [{ id, name, color: typeof color === "string" && COLOR.test(color) ? color : theme.color.textMuted }];
  });
}

function refusalMessage(kind: FragmentSecret["kind"], err: unknown): string {
  if (err instanceof ApiError && err.status === 429) return "Too many tries from here. Wait a few minutes and open the link again.";
  if (err instanceof ApiError && err.status === 503) return err.message;
  return kind === "dm"
    ? "This DM link does not work anymore. The DM may have replaced it."
    : "This invite has expired or was already used. Ask a DM device for a new one.";
}
