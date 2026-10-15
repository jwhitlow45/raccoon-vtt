/**
 * Every code the HTTP API answers in `{error: code}`. The server's error
 * classes take their code from this list and the client's ApiError carries
 * one, so a client that checks for a code the server never sends fails the
 * typecheck instead of quietly never matching. Refusal codes on the socket
 * are a separate list, in protocol.ts.
 */
export const API_ERROR_CODES = [
  "already_dm",
  "asset_in_use",
  "bad_code",
  "bad_fallback",
  "bad_image",
  "bad_invite",
  "bad_key",
  "bad_manifest",
  "bad_password",
  "bad_query",
  "bad_request",
  "bad_room_json",
  "bad_ticket",
  "bad_url",
  "bad_zip",
  "busy",
  "cannot_kick_self",
  "cannot_remove_self",
  "choose_member",
  "confirm_mismatch",
  "cross_origin",
  "disk_full",
  "displays_full",
  "dm_only",
  "fetch_failed",
  "forbidden",
  "import_entry_too_large",
  "import_too_large",
  "internal",
  "invalid_body",
  "invalid_form",
  "invalid_query",
  "member_not_found",
  "member_removed",
  "missing_room_json",
  "name_mismatch",
  "name_required",
  "no_access",
  "no_session",
  "not_a_dm",
  "not_a_player",
  "not_found",
  "over_room_limits",
  "quota_exceeded",
  "quota_global",
  "quota_ip",
  "quota_member",
  "quota_room",
  "rate_limited",
  "read_only",
  "room_full",
  "room_not_found",
  "search_failed",
  "search_unavailable",
  "stale_ticket",
  "state_unknown",
  "storage_full",
  "too_large",
  "too_many_codes",
  "too_many_entries",
  "too_many_invites",
  "too_many_sockets",
  "too_slow",
  "turnstile_failed",
  "turnstile_required",
  "turnstile_unavailable",
  "unsupported_schema_version",
  "unsupported_type",
  "upload_aborted",
  "upload_failed",
  "weak_password",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

const KNOWN: ReadonlySet<string> = new Set(API_ERROR_CODES);

export function isApiErrorCode(value: unknown): value is ApiErrorCode {
  return typeof value === "string" && KNOWN.has(value);
}
