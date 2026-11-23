import { createHmac } from "node:crypto";
import { idKeyOf, idKeyText, type IdKey } from "#shared/ids.ts";

/**
 * The keys ids are sealed under (shared/ids.ts sealedId), all derived from
 * ROOM_SECRET_KEY through one root of their own, so they share nothing
 * with the player password's AES-256-GCM key (server/auth/playerSecret.ts):
 *
 * - root = HMAC(ROOM_SECRET_KEY, "raccoon ids root v1")
 * - a member's key = HMAC(root, "member" 0 roomId 0 memberId)
 * - the room's server key = HMAC(root, "server" 0 roomId)
 *
 * A member keeps one key for as long as the secret stays, and nothing
 * rotates it. Each socket that asks (`hello.sealIds`) gets its own member's
 * key with every snapshot (server/rooms/fanout.ts). A new secret takes a
 * restart, and every socket then takes the new key with its next snapshot.
 */

const ROOT_LABEL = "raccoon ids root v1";

const roots = new WeakMap<Buffer, Buffer>();

function idRoot(secret: Buffer): Buffer {
  let root = roots.get(secret);
  if (!root) roots.set(secret, (root = createHmac("sha256", secret).update(ROOT_LABEL).digest()));
  return root;
}

/** HMAC(root, the parts joined by zero bytes). */
function derive(root: Buffer, parts: readonly string[]): Buffer {
  const mac = createHmac("sha256", root);
  parts.forEach((part, i) => {
    if (i > 0) mac.update(Buffer.of(0));
    mac.update(part, "utf8");
  });
  return mac.digest();
}

/** A key with its text, as a snapshot sends it. */
export type HeldIdKey = { readonly key: IdKey; readonly text: string };

/** One room's keys, each derived once and kept while the room is loaded. */
export class RoomIdKeys {
  readonly #root: Buffer;
  readonly #roomId: string;
  readonly #members = new Map<string, HeldIdKey>();
  #server: HeldIdKey | null = null;

  constructor(secret: Buffer, roomId: string) {
    this.#root = idRoot(secret);
    this.#roomId = roomId;
  }

  /** A member's key, K(room, member). */
  member(memberId: string): HeldIdKey {
    let held = this.#members.get(memberId);
    if (!held) {
      const bytes = derive(this.#root, ["member", this.#roomId, memberId]);
      this.#members.set(memberId, (held = { key: idKeyOf(bytes), text: idKeyText(bytes) }));
    }
    return held;
  }

  /** The room's own key, K_server(room), which seals the ids the server makes. */
  get server(): HeldIdKey {
    if (!this.#server) {
      const bytes = derive(this.#root, ["server", this.#roomId]);
      this.#server = { key: idKeyOf(bytes), text: idKeyText(bytes) };
    }
    return this.#server;
  }

  /** Forgets a member's key, once they leave the room. */
  forget(memberId: string): void {
    this.#members.delete(memberId);
  }
}
