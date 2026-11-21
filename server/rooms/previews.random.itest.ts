import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { EphEvent, Op } from "#shared/protocol.ts";
import { rng } from "#shared/testutil.ts";
import { PREVIEW_STALE_MS } from "./ephemeral.ts";
import { previewRoom, previewTwin, VAULT, type PreviewTwin } from "./previewsTesting.ts";

/*
 * Held previews under random play (D-261121-068, D-261121-122): P1 drags
 * their creature and shows rulers on it while the DM locks it, hides it,
 * takes it from P1, turns fog on the players' scene on and off, and works
 * on the vault, a scene no player holds, in twin A alone. Waits run past
 * PREVIEW_STALE_MS. After every step Bree's and the DM's ephemeral frames
 * are equal in both twins.
 */

const SEEDS = Number(process.env.PREVIEWS_SEEDS ?? 24);
const STEPS = 60;

type Step = { what: string; frame?: EphEvent; dm?: Op; vault?: Op; wait?: number };

function steps(seed: number, pc: string, character: string, p1: string): Step[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const cell = () => 2 + Math.floor(r() * 10);
  const out: Step[] = [];
  for (let i = 0; i < STEPS; i++) {
    const roll = r();
    if (roll < 0.35) {
      const k = pick(["dragStart", "dragMove", "dragMove", "dragEnd"] as const);
      out.push({ what: k, frame: k === "dragEnd" ? { k, tokenId: pc, x: cell(), y: cell() } : { k, tokenId: pc, x: cell(), y: cell() } });
    } else if (roll < 0.5) {
      const id = pick(["r1", "r2"]);
      out.push(r() < 0.25 ? { what: "rulerEnd", frame: { k: "rulerEnd", id } } : { what: "ruler", frame: { k: "ruler", id, points: [{ x: 8.5, y: 3.5, tokenId: pc }, { x: cell() + 0.5, y: cell() + 0.5 }] } });
    } else if (roll < 0.7) {
      out.push(
        pick<Step>([
          { what: "lock", dm: { t: "token.update", tokenId: pc, patch: { locked: true } } as Op },
          { what: "unlock", dm: { t: "token.update", tokenId: pc, patch: { locked: false } } as Op },
          { what: "hide", dm: { t: "token.update", tokenId: pc, patch: { visibility: "dm" } } as Op },
          { what: "show", dm: { t: "token.update", tokenId: pc, patch: { visibility: "all" } } as Op },
          { what: "take from P1", dm: { t: "character.update", characterId: character, patch: { ownerIds: [] } } as Op },
          { what: "give to P1", dm: { t: "character.update", characterId: character, patch: { ownerIds: [p1] } } as Op },
          { what: "fog on", dm: { t: "scene.update", sceneId: "", patch: { fogEnabled: true } } as Op },
          { what: "fog off", dm: { t: "scene.update", sceneId: "", patch: { fogEnabled: false } } as Op },
        ]),
      );
    } else if (roll < 0.85) {
      out.push(
        pick<Step>([
          { what: "vault fog", vault: { t: "scene.update", sceneId: VAULT, patch: { fogEnabled: r() < 0.5 } } as Op },
          { what: "vault vision", vault: { t: "scene.update", sceneId: VAULT, patch: { vision: { on: r() < 0.5, light: pick(["bright", "dim", "dark"] as const) } } } as Op },
          { what: "vault name", vault: { t: "scene.update", sceneId: VAULT, patch: { name: `Vault ${i}` } } as Op },
        ]),
      );
    } else {
      out.push({ what: "wait", wait: pick([500, 3_000, PREVIEW_STALE_MS - 1, PREVIEW_STALE_MS + 1, 2 * PREVIEW_STALE_MS]) });
    }
  }
  return out;
}

async function run(twin: PreviewTwin, step: Step, sceneId: string, withVault: boolean): Promise<string> {
  if (step.frame) twin.frame(step.frame);
  if (step.wait) twin.clock.now += step.wait;
  if (step.vault && !withVault) return "skipped";
  const op = step.dm ?? step.vault;
  if (!op) return "framed";
  const ev = await twin.dm.send(op.t === "scene.update" && op.sceneId === "" ? { ...op, sceneId } : op);
  return ev.rejects?.[0]?.code ?? "taken";
}

describe("held previews under random play, twin B skipping every vault batch (D-261121-068)", () => {
  const totals = { cancels: 0, stale: 0, vault: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    test(`seed ${seed}`, async (t) => {
      const f = previewRoom();
      const [a, b] = [await previewTwin(t, f), await previewTwin(t, f)];
      const counts = totals;
      for (const [i, step] of steps(seed, f.pc, f.bree, f.player.id).entries()) {
        const before = a.seen().bree.length;
        const [ra, rb] = [await run(a, step, f.sceneId, true), await run(b, step, f.sceneId, false)];
        if (step.dm) assert.equal(ra, rb, `step ${i} ${step.what}: the DM's op answers alike`);
        if (step.vault && ra === "taken") counts.vault++;
        if (step.wait && step.wait >= PREVIEW_STALE_MS) counts.stale++;
        assert.deepEqual(a.seen(), b.seen(), `step ${i} ${step.what}: the frames Bree and the DM were sent`);
        counts.cancels += a.seen().bree.slice(before).filter((e) => (e as { k: string }).k === "dragCancel" || (e as { k: string }).k === "rulerEnd").length;
      }
    });
  }

  test("the runs changed the vault, waited past stale and ended previews many times", () => {
    assert.ok(totals.vault > SEEDS && totals.stale > SEEDS && totals.cancels > SEEDS, JSON.stringify(totals));
  });
});
