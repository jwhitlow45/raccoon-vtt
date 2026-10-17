import { resolveDiceOp } from "#shared/dice/resolve.ts";
import { serverDraw } from "#shared/dice/roll.ts";
import { allKeys, dependents, diffProjection, hash128, heldOf, projectEntity, projectState } from "#shared/project.ts";
import { canApply } from "#shared/permissions.ts";
import type { EntityKey } from "#shared/keys.ts";
import type { RoomState, Viewer } from "#shared/model.ts";
import { clientMessageSchema, clientOpSchema, type Change, type Op, type ServerMessage } from "#shared/protocol.ts";
import { applyOp } from "#shared/reducer.ts";
import { hpUndoRestore } from "#shared/reducer/hpUndo.ts";
import type { SocketLike } from "../state/socket.ts";

/**
 * A stand-in for the room actor (design section 7.2), small enough to run in
 * the browser for the dev fixture and in the store's tests. One client, one
 * op per batch, no persistence: it answers `hello` with a projected
 * snapshot, applies ops with the shared reducer after the shared permission
 * check, and fans out each batch as one `ev` per the held-map rules of
 * section 7.3. It follows the sequence rules for `n` exactly, so the
 * client's dedupe and resend paths meet the same answers as in production.
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
    const touched: EntityKey[] = [];
    let global = false;
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
      if (next.t === "dice.roll") {
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
    }
    const changes = this.fanOut(touched, global);
    if (changes.length > 0 || acks.length > 0 || rejects.length > 0) {
      const ev: Extract<ServerMessage, { t: "ev" }> = { t: "ev", seq: this.seq, changes };
      if (acks.length > 0) ev.acks = acks;
      if (rejects.length > 0) ev.rejects = rejects;
      out.unshift(ev);
    }
    return out;
  }

  /** Someone else's op, applied without permission checks. Returns this client's `ev`, or null when it sees no change. */
  external(op: Op, actor: Viewer): Extract<ServerMessage, { t: "ev" }> | null {
    const result = applyOp(this.state, op, actor, { seq: this.seq + 1, at: new Date().toISOString() });
    if (!result.ok) return null;
    this.seq++;
    this.state = result.state;
    const changes = this.fanOut(result.touched, result.global);
    return changes.length > 0 ? { t: "ev", seq: this.seq, changes } : null;
  }

  private fanOut(touched: EntityKey[], global: boolean): Change[] {
    if (touched.length === 0 && !global) return [];
    const candidates = new Set<EntityKey>(global ? [...allKeys(this.state), ...this.held.keys()] : [...touched, ...dependents(this.state, touched)]);
    const projected = new Map<EntityKey, unknown>();
    for (const key of candidates) projected.set(key, projectEntity(key, this.state, this.viewer, { sceneId: this.snapshotScene }));
    const { changes, held } = diffProjection(this.held, projected);
    this.held = held;
    return changes;
  }

  /** Whether a player's scene changed under them, which the actor answers with `resync`. */
  playerSceneMoved(): boolean {
    return this.viewer.role === "player" && this.snapshotScene !== this.state.meta.playerSceneId;
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
 * the real socket.ts and store.ts end to end. `drop()` closes every open
 * socket as a network loss would.
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

    constructor() {
      setTimeout(() => {
        if (options.down?.()) {
          this.closeWith(1006);
          return;
        }
        this.readyState = 1;
        open.add(this);
        this.onopen?.({});
      }, 60);
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

    close(code = 1000): void {
      this.closeWith(code);
    }

    closeWith(code: number): void {
      if (this.readyState === 3) return;
      this.readyState = 3;
      open.delete(this);
      setTimeout(() => this.onclose?.({ code }), 0);
    }
  }

  return {
    create: () => new LocalSocket(),
    drop() {
      for (const socket of [...open]) socket.closeWith(1006);
    },
    push(msg) {
      for (const socket of open) socket.emit(msg);
    },
  };
}
