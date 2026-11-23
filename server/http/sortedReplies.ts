import type { FastifyInstance } from "fastify";
import { sortedJson } from "#shared/sortedJson.ts";

/**
 * Every JSON reply of `app` and the scopes registered on it after this
 * call is written with every object's keys in sorted order at every depth
 * (shared/sortedJson.ts), as a player's socket frames are, so a reply's text
 * reads only its values: a line from the room's memory and the same line
 * read back from the archive's jsonb rows give the same bytes. Replies sent
 * as text, buffers or streams are left as they are.
 */
export function sortedReplies(app: FastifyInstance): void {
  app.setReplySerializer((payload) => sortedJson(payload));
}
