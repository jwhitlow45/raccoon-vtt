import { ApiError, MAX_IMPORT_BYTES } from "../../lib/api.ts";
import { weakPasswordText } from "../dm/invite.ts";

/**
 * Room export and import from the client's side (design 16.4). The server
 * checks everything again. These checks only spare a phone a 95 MB upload
 * that was always going to be refused, and turn the server's refusals into
 * sentences.
 */

/** The admin command that restores an export too big for the site, from design 16.4. */
export const ADMIN_IMPORT_COMMAND =
  "docker compose -f docker-compose.server.yml exec raccoon node scripts/admin.ts import /data/assets/import/<file>.zip";

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} bytes`;
}

const TOO_BIG = `The site takes room exports up to ${formatBytes(MAX_IMPORT_BYTES)}. The server owner can restore a bigger one with the admin import command.`;

/** Why a picked file cannot be imported, before any byte is sent. Null when it may go. */
export function importFileProblem(file: { name: string; size: number; type: string }): string | null {
  const zipLike = /\.zip$/i.test(file.name) || file.type === "application/zip" || file.type === "application/x-zip-compressed";
  if (!zipLike) return "Pick the .zip file that a room export downloads.";
  if (file.size === 0) return "That file is empty.";
  if (file.size > MAX_IMPORT_BYTES) return `This file is ${formatBytes(file.size)}. ${TOO_BIG}`;
  return null;
}

/** The server's import refusals (server/http/export.ts and server/rooms/importRoom.ts), in words. */
export function importErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  switch (err.code) {
    case "too_large":
      return `This export is too big for the site. ${TOO_BIG}`;
    case "import_too_large":
      return "This export unpacks to more than 1 GB, more than one room may hold.";
    case "import_entry_too_large":
      return "An image in this export is larger than the app allows, so the export cannot be imported.";
    case "too_many_entries":
      return "This export holds more than 2,000 files, more than one room may hold.";
    case "over_room_limits":
      return "This room is bigger than the room limits allow, so it cannot be imported.";
    case "bad_zip":
    case "missing_room_json":
    case "bad_room_json":
    case "bad_manifest":
      return "This file is not a room export, or it is damaged.";
    case "unsupported_schema_version":
      return "This export comes from a newer version of the app than this server runs.";
    case "weak_password":
      return weakPasswordText(err.detail.reason);
    case "invalid_form":
    case "invalid_body":
      return "Check the room name, your name and the player password.";
    case "rate_limited":
      return "Too many rooms were created from here recently. Try again later.";
    case "disk_full":
      return "The server is out of disk space. Ask the server owner.";
    case "turnstile_failed":
      return "The human check did not pass. Try again.";
    case "turnstile_unavailable":
      return "The human check is not answering. Try again in a minute.";
    case "unsupported_type":
      return "Pick the .zip file that a room export downloads.";
  }
  if (err.status === 413) return `This export is too big to import. ${TOO_BIG}`;
  if (err.status === 503) return "The server is busy with another upload. Try again in a minute.";
  if (err.status === 404) return "This server cannot import rooms yet.";
  return err.message;
}

/** Why the server refused a backup (server/http/export.ts), in words. A HEAD carries no body, so the status decides. */
export function exportErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return "Something went wrong. Try again.";
  if (err.code === "network") return "Could not reach the server. Check your connection and try again.";
  switch (err.status) {
    case 401:
    case 403:
      return "Only a DM device can download a backup. Reload the page if you just became the DM.";
    case 404:
      return "This room no longer exists.";
    case 429: {
      const minutes = err.retryAfterMs === null ? null : Math.max(1, Math.ceil(err.retryAfterMs / 60_000));
      return `This room or this network made 4 backups in the last hour. ${minutes === null ? "Try again later." : `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`}`;
    }
    case 503:
      return "The server is making another backup right now. Try again in a few seconds.";
  }
  return err.message;
}
