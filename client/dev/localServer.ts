import { isDiceOp, resolveDiceOp } from "#shared/dice/resolve.ts";
import { serverDraw } from "#shared/dice/roll.ts";
import { allKeys, dependents, diffProjection, hash128, heldOf, projectEntity, projectState } from "#shared/project.ts";
import { canApply } from "#shared/permissions.ts";
import { keys, type EntityKey } from "#shared/keys.ts";
import { linesPastStart } from "#shared/logRings.ts";
import type { LogEntry, RoomState, Viewer } from "#shared/model.ts";
import { clientMessageSchema, clientOpSchema, type Change, type ClientMessage, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { hpUndoRestore } from "#shared/reducer/hpUndo.ts";
import { stampedAt } from "#shared/reducer/tokens.ts";
import type { SocketLike } from "../state/socket.ts";

/**
 * A stand-in for the room actor (design section 7.2), small enough to run in
 * the browser for the dev fixture and in the store's tests. One client, one
 * op per batch, no persistence: it answers `hello` with a projected
 * snapshot, applies ops with the shared reducer after the shared permission
 * check, and fans out each batch as one `ev` per the held-map rules of
 * section 7.3. It follows the sequence rules for `n` exactly, so the
 * client's dedupe and resend paths meet the same answers as in production.
 * A DM's views as a player (LocalPreview) hear each batch beside it.
 *
 * Never imported by production code.
 */
export class LocalServer {
  state: RoomState;
  viewer: Viewer;
  seq = 0;
  /** The scene the DM viewer holds. Players always hold the player scene. */
  dmSceneId: string | null;
  private held = new Map<EntityKey, string>();
  private committed = 0;
  private snapshotScene: string | null = null;
  private readonly previews = new Set<LocalPreview>();

  constructor(state: RoomState, viewer: Viewer, dmSceneId: string | null = null) {
    this.state = state;
    this.viewer = viewer;
    this.dmSceneId = dmSceneId ?? state.meta.playerSceneId;
    // Log ids start with the seq of the op that wrote them, so the fixture's own lines must not be written over by the first ops here.
    this.seq = Math.max(0, ...state.log.map((e) => Number(e.id.split(":")[0]) || 0));
  }

  private sceneId(): string | null {
    return this.viewer.role === "dm" ? this.dmSceneId : this.state.meta.playerSceneId;
  }

  hello(msg: { resumeFrom: number; sceneId?: string }): Extract<ServerMessage, { t: "snapshot" }> {
    if (this.viewer.role === "dm" && msg.sceneId && this.state.scenes[msg.sceneId]) this.dmSceneId = msg.sceneId;
    this.committed = Math.max(this.committed, msg.resumeFrom - 1);
    const sceneId = this.sceneId();
    const projected = projectState(this.state, this.viewer, { sceneId });
    this.held = heldOf(projected);
    this.snapshotScene = sceneId;
    return {
      t: "snapshot",
      seq: this.seq,
      state: projected,
      you: { memberId: this.viewer.memberId, role: this.viewer.role, sceneId },
      watermark: this.committed,
    };
  }

  /**
   * One batch of this client's ops, in order. Returns the `ev` for this
   * client (null when there is nothing to say) and the retries, as the
   * actor would send them.
   */
  batch(ops: { n: number; op: unknown }[]): ServerMessage[] {
    const out: ServerMessage[] = [];
    const acks: number[] = [];
    const rejects: { n: number; code: "invalid" | "forbidden" | "gone" | "quota"; message: string }[] = [];
    const stamped: { n: number; at: string }[] = [];
    const touched: EntityKey[] = [];
    let global = false;
    const before = this.state;
    for (const { n, op } of ops) {
      if (n <= this.committed) {
        acks.push(n);
        continue;
      }
      if (n > this.committed + 1) {
        out.push({ t: "retry", n, code: "gap" });
        continue;
      }
      this.committed = n;
      const parsed = clientOpSchema.safeParse(op);
      if (!parsed.success) {
        rejects.push({ n, code: "invalid", message: "that op is not valid" });
        continue;
      }
      let next: Op = parsed.data;
      // The DM taking an HP change back from the log, built as the room actor builds it. The fixture keeps no undo stacks.
      if (next.t === "undo" && next.log !== undefined && this.viewer.role === "dm") {
        const built = hpUndoRestore(this.state, next.log);
        if (!built.ok) {
          rejects.push({ n, code: built.code, message: `could not undo that change: ${built.message}` });
          continue;
        }
        next = { t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: next.log };
      } else if (next.t === "undo" || next.t === "redo") {
        rejects.push({ n, code: "invalid", message: "nothing to undo here" });
        continue;
      }
      const decision = canApply(next, this.viewer, this.state, { canUseAsset: () => true });
      if (!decision.ok) {
        rejects.push({ n, code: decision.code, message: decision.message });
        continue;
      }
      // The fixture rolls with the server's resolve (docs/design-v1-dice.md 4.2), with a stand-in batch id: it keeps no receipts.
      if (isDiceOp(next)) {
        const resolved = resolveDiceOp(next, this.state, { draw: serverDraw, batch: hash128(`${this.viewer.memberId}\n${next.tag}`).slice(0, 16) });
        if (!resolved.ok) {
          rejects.push({ n, code: resolved.code, message: resolved.message });
          continue;
        }
        next = resolved.op;
      }
      const result = applyOp(this.state, next, this.viewer, { seq: this.seq + 1, at: new Date().toISOString() });
      if (!result.ok) {
        rejects.push({ n, code: result.code, message: result.message });
        continue;
      }
      this.seq++;
      this.state = result.state;
      touched.push(...result.touched);
      global ||= result.global;
      acks.push(n);
      const at = stampedAt(next, this.state);
      if (at !== undefined) stamped.push({ n, at });
    }
    const changes = this.fanOut(before, touched, global);
    if (changes.length > 0 || acks.length > 0 || rejects.length > 0) {
      const ev: Extract<ServerMessage, { t: "ev" }> = { t: "ev", seq: this.seq, changes };
      if (acks.length > 0) ev.acks = acks;
      if (rejects.length > 0) ev.rejects = rejects;
      if (stamped.length > 0) ev.stamped = stamped;
      out.unshift(ev);
    }
    return out;
  }

  /** Someone else's op, applied without permission checks. Returns this client's `ev`, or null when it sees no change. */
  external(op: Op, actor: Viewer): Extract<ServerMessage, { t: "ev" }> | null {
    const result = applyOp(this.state, op, actor, { seq: this.seq + 1, at: new Date().toISOString() });
    if (!result.ok) return null;
    this.seq++;
    const before = this.state;
    this.state = result.state;
    const changes = this.fanOut(before, result.touched, result.global);
    return changes.length > 0 ? { t: "ev", seq: this.seq, changes } : null;
  }

  private fanOut(before: RoomState, touched: EntityKey[], global: boolean): Change[] {
    const { changes, held } = fanOutFor(this.held, this.viewer, this.snapshotScene, before, this.state, touched, global);
    this.held = held;
    for (const preview of this.previews) preview.publish(before, touched, global);
    return changes;
  }

  /**
   * A DM's view as a player (docs/design-v1-per-player-vision.md 7.4), as
   * server/rooms/ws.ts decides `as`: only for a DM and a player of the
   * roster. Anything else is null, the 403 `no_access` a browser sees as
   * a socket that never opens.
   */
  openPreview(memberId: string, out: { send(msg: ServerMessage): void; close(code: number): void }): LocalPreview | null {
    if (this.viewer.role !== "dm" || this.state.members[memberId]?.kind !== "player") return null;
    const preview = new LocalPreview(this, memberId, this.viewer.memberId, out);
    this.previews.add(preview);
    return preview;
  }

  closePreview(preview: LocalPreview): void {
    this.previews.delete(preview);
  }

  /** Whether a player's scene changed under them, which the actor answers with `resync`. */
  playerSceneMoved(): boolean {
    return this.viewer.role === "player" && this.snapshotScene !== this.state.meta.playerSceneId;
  }
}

/**
 * A projection and its held map advanced past one batch, as the actor's
 * fan-out does it (section 7.3). `omit` names lines left out of this view,
 * which a preview's whisper rule sends as deletions.
 */
function fanOutFor(
  held: Map<EntityKey, string>,
  viewer: Viewer,
  sceneId: string | null,
  before: RoomState,
  after: RoomState,
  touched: EntityKey[],
  global: boolean,
  omit?: (line: LogEntry) => boolean,
): { changes: Change[]; held: Map<EntityKey, string> } {
  // The lines a live log's start passed come and go with no key touched (shared/logRings.ts), as the actor's fan-out has them.
  const passed = linesPastStart(before, after, [viewer]).map((id) => keys.log(id));
  if (touched.length === 0 && !global && passed.length === 0) return { changes: [], held };
  // In key order, as the actor's fan-out sends them, never the order the reducer wrote them.
  const candidates = [...new Set<EntityKey>(global ? [...allKeys(after), ...held.keys()] : [...touched, ...dependents(after, touched), ...passed])].sort();
  const projected = new Map<EntityKey, unknown>();
  for (const key of candidates) {
    const value = projectEntity(key, after, viewer, { sceneId });
    projected.set(key, omit && value !== null && key.startsWith("log:") && omit(value as LogEntry) ? null : value);
  }
  return diffProjection(held, projected);
}

/**
 * Whether a DM's view as a player leaves a line out: a whisper the DM is
 * not party to, so the preview never shows whispers between players. The
 * server's rule (server/rooms/fanout.ts previewOmits), restated since the
 * client may not import the server.
 */
export function previewOmits(line: Pick<LogEntry, "kind" | "from" | "to">, by: string): boolean {
  return line.kind === "whisper" && line.from !== by && !(line.to?.includes(by) ?? false);
}

/**
 * One DM's view as a player on a LocalServer, as the actor serves a
 * preview socket (docs/design-v1-per-player-vision.md 7.4): that player's
 * projection less whispers the DM is not party to, in its snapshot and
 * every batch after, read only, never any client's own socket, so it takes
 * no acks, and closed with 4003 once its player is no player of the
 * roster.
 */
export class LocalPreview {
  readonly viewer: Viewer;
  /** The DM whose view it is. */
  readonly by: string;
  private readonly server: LocalServer;
  private readonly out: { send(msg: ServerMessage): void; close(code: number): void };
  private held = new Map<EntityKey, string>();
  private snapshotScene: string | null = null;
  private greeted = false;

  constructor(server: LocalServer, memberId: string, by: string, out: { send(msg: ServerMessage): void; close(code: number): void }) {
    this.server = server;
    this.viewer = { memberId, role: "player" };
    this.by = by;
    this.out = out;
  }

  private stands(): boolean {
    if (this.server.state.members[this.viewer.memberId]?.kind === "player") return true;
    this.server.closePreview(this);
    this.out.close(4003);
    return false;
  }

  /** The player's snapshot, or null once the preview closed. */
  hello(): Extract<ServerMessage, { t: "snapshot" }> | null {
    if (!this.stands()) return null;
    const state = this.server.state;
    const sceneId = state.meta.playerSceneId;
    const viewed = projectState(state, this.viewer, { sceneId });
    const projected = { ...viewed, log: viewed.log.filter((line) => !previewOmits(line, this.by)) };
    this.held = heldOf(projected);
    this.snapshotScene = sceneId;
    this.greeted = true;
    return { t: "snapshot", seq: this.server.seq, state: projected, you: { memberId: this.viewer.memberId, role: "player", sceneId }, watermark: 0 };
  }

  /** Sends what one batch changed for this player, or a resync when their scene moved under them, as for any player. */
  publish(before: RoomState, touched: EntityKey[], global: boolean): void {
    if (!this.greeted || !this.stands()) return;
    const state = this.server.state;
    if (this.snapshotScene !== state.meta.playerSceneId) {
      this.greeted = false;
      this.out.send({ t: "resync", reason: "scene" });
      return;
    }
    const { changes, held } = fanOutFor(this.held, this.viewer, this.snapshotScene, before, state, touched, global, (line) => previewOmits(line, this.by));
    this.held = held;
    if (changes.length > 0) this.out.send({ t: "ev", seq: this.server.seq, changes });
  }
}

export type LocalSocketOptions = {
  server: LocalServer;
  /** Delay before the snapshot, to watch the gate. */
  snapshotDelayMs?: number;
  /** Every attempt fails to connect. */
  down?: () => boolean;
  /** Latency of every answer. */
  latencyMs?: number;
  members: () => string[];
};

/**
 * A WebSocket-shaped wrapper around a LocalServer, so the dev fixture runs
 * the real socket.ts and store.ts end to end. A URL that asks `as` opens a
 * DM's view as that player, by the server's rule. `drop()` closes every
 * open socket as a network loss would.
 */
export function localSocketFactory(options: LocalSocketOptions): {
  create: (url: string) => SocketLike;
  drop(): void;
  push(msg: ServerMessage): void;
} {
  const open = new Set<LocalSocket>();
  const latency = options.latencyMs ?? 30;

  class LocalSocket implements SocketLike {
    readyState = 0;
    onopen: SocketLike["onopen"] = null;
    onmessage: SocketLike["onmessage"] = null;
    onclose: SocketLike["onclose"] = null;
    onerror: SocketLike["onerror"] = null;
    private queue: { n: number; op: unknown }[] = [];
    private batchTimer: ReturnType<typeof setTimeout> | null = null;
    /** A DM's view as a player, for a socket that asked `as` (docs/design-v1-per-player-vision.md 7.4). */
    private preview: LocalPreview | null = null;

    constructor(as: string | null) {
      setTimeout(() => {
        if (options.down?.()) {
          this.closeWith(1006);
          return;
        }
        if (as !== null) {
          this.preview = options.server.openPreview(as, { send: (msg) => this.emit(msg), close: (code) => this.closeWith(code) });
          // Refused before the upgrade, which a browser sees as a socket that never opened.
          if (!this.preview) {
            this.closeWith(1006);
            return;
          }
        }
        this.readyState = 1;
        open.add(this);
        this.onopen?.({});
      }, 60);
    }

    get isPreview(): boolean {
      return this.preview !== null;
    }

    emit(msg: ServerMessage): void {
      if (this.readyState !== 1) return;
      setTimeout(() => this.onmessage?.({ data: JSON.stringify(msg) }), latency);
    }

    send(data: string): void {
      if (this.readyState !== 1) throw new Error("not open");
      const parsed = clientMessageSchema.safeParse(JSON.parse(data));
      if (!parsed.success) {
        this.closeWith(4003);
        return;
      }
      const msg = parsed.data;
      if (this.preview) {
        this.previewSend(this.preview, msg);
        return;
      }
      switch (msg.t) {
        case "hello": {
          const snapshot = options.server.hello(msg);
          setTimeout(() => {
            this.emit(snapshot);
            this.emit({ t: "presence", online: options.members() });
          }, options.snapshotDelayMs ?? 0);
          return;
        }
        case "op":
          // A 20 ms batch window, as the actor's.
          this.queue.push({ n: msg.n, op: msg.op });
          this.batchTimer ??= setTimeout(() => {
            this.batchTimer = null;
            const ops = this.queue;
            this.queue = [];
            for (const out of options.server.batch(ops)) this.emit(out);
            if (options.server.playerSceneMoved()) this.emit({ t: "resync", reason: "scene" });
          }, 20);
          return;
        case "scene":
          this.emit({ t: "resync", reason: "scene" });
          return;
        case "ping":
          this.emit({ t: "pong", k: msg.k });
          return;
        case "eph":
          return;
      }
    }

    /** A preview sends nothing but `hello` and `ping`, and anything else closes it, as server/rooms/ws.ts has it. */
    private previewSend(preview: LocalPreview, msg: ClientMessage): void {
      if (msg.t === "ping") {
        this.emit({ t: "pong", k: msg.k });
        return;
      }
      if (msg.t !== "hello") {
        this.closeWith(4003);
        return;
      }
      const snapshot = preview.hello();
      if (!snapshot) return;
      setTimeout(() => {
        this.emit(snapshot);
        this.emit({ t: "presence", online: options.members() });
      }, options.snapshotDelayMs ?? 0);
    }

    close(code = 1000): void {
      this.closeWith(code);
    }

    closeWith(code: number): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      open.delete(this);
      if (this.preview) options.server.closePreview(this.preview);
      setTimeout(() => this.onclose?.({ code }), 0);
    }
  }

  return {
    create: (url) => new LocalSocket(previewOf(url)),
    drop() {
      for (const socket of [...open]) socket.closeWith(1006);
    },
    // A preview hears only its own player's view, which the server sends it.
    push(msg) {
      for (const socket of open) if (!socket.isPreview) socket.emit(msg);
    },
  };
}

/** The member a socket's URL asks to view as (state/socket.ts previewSocketUrl), or null for the room's own socket. */
function previewOf(url: string): string | null {
  const query = url.indexOf("?");
  return query < 0 ? null : new URLSearchParams(url.slice(query + 1)).get("as");
}
