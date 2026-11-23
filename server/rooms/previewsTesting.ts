import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import type { RoomState } from "#shared/model.ts";
import type { EphEvent, Op } from "#shared/protocol.ts";
import { scene } from "#shared/testutil.ts";
import { scopeActor, scopeFixture, type ScopeClient } from "./undoScopeTesting.ts";

/*
 * Twin rooms for held previews (docs/design/design-v1-per-player-vision.md
 * 7.2): P1 drags their creature and Bree watches it, while the DM works
 * in the room and, in one twin only, on a scene no player holds. Each
 * twin's sockets read one fake clock, so a frame goes stale alike in both.
 */

/** The scene no player holds, whose changes one twin alone makes. */
export const VAULT = "vault";

/** The fixture both twins load, with the vault: built once, so both hold the same ids. */
export function previewRoom() {
  const f = scopeFixture();
  f.state.scenes[VAULT] = scene(VAULT, { order: 9, fogEnabled: false });
  return f;
}

export type PreviewFixture = ReturnType<typeof previewRoom>;

export type PreviewTwin = {
  dm: ScopeClient;
  p1: ScopeClient;
  bree: ScopeClient;
  clock: { now: number };
  /** P1's frame, as their device sends it. */
  frame: (e: EphEvent) => void;
  /** The DM's op, answered. */
  dmOp: (op: Op) => Promise<void>;
  state: () => RoomState;
  /** What Bree and the DM were sent through the ephemeral channel so far. */
  seen: () => { bree: unknown[]; dm: unknown[] };
};

export async function previewTwin(t: TestContext, f: PreviewFixture): Promise<PreviewTwin> {
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  // The room reads the sockets' clock too, so a batch's close moment, which judges a held preview's age, is on it.
  const h = await scopeActor(t, structuredClone(f.state), { now });
  const dm = await h.connect(f.dm, "dm", now);
  const p1 = await h.connect(f.player, "player", now);
  const bree = await h.connect(f.unrelated, "player", now);
  const eph = (client: ScopeClient) => client.sent.flatMap((m) => (m.t === "eph" ? [m.e] : []));
  return {
    dm,
    p1,
    bree,
    clock,
    frame: (e) => h.actor.ephemeral(p1.conn, { sceneId: f.sceneId, e }),
    dmOp: async (op) => {
      const ev = await dm.send(op);
      assert.equal(ev.rejects?.length ?? 0, 0, `${op.t}: ${JSON.stringify(ev.rejects)}`);
    },
    state: () => h.actor.committed.state,
    seen: () => ({ bree: eph(bree), dm: eph(dm) }),
  };
}
