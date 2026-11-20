import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stopsStepApartInReach } from "../migrate.ts";
import type { RoomState, Token, Viewer } from "../model.ts";
import { canApply } from "../permissions.ts";
import { applyOp } from "../reducer.ts";
import { caseOf, insideCaseOf, withImpAhead, withStop, type Case } from "../reducer/hexFile.testkit.ts";
import { DM, env, P1 } from "../testutil.ts";
import { linkHolds, onHolder } from "./attach.ts";
import { occupiedHexes } from "./footprint.ts";
import { hexKey, type HexGrid } from "./hex.ts";
import { COLUMNS, ROWS } from "./hexWalls.testkit.ts";
import { planWalks } from "./moveLeg.ts";
import { planTrapMove, trapLandings } from "./traps.ts";

/**
 * A trap's stop keeps each creature in single file off its holder where it
 * can (traps.ts fileApart, HEXFILE-OPUS-6, migrate.ts stopsStepApartInReach).
 * At a stop between a walk's ends each in the file steps back off those
 * ahead of it, but where a step back left a drag out of reach the whole
 * class went back to the stop's spots, and at a corner of the holder's walk
 * those lie on the holder's own hex. From op version 63 each that still
 * shares a hex then steps back to the latest spot it may stop at clear of
 * the rest, in reach, holders first.
 */

const deps = { canUseAsset: () => true };

/** The hexes a token stands on after the move. */
function hexesOf(g: HexGrid, state: RoomState, id: string): string[] {
  return occupiedHexes(g, state.tokens[id]!).map(hexKey);
}

/**
 * The move applied at `opVersion` (none for a live op), every token where the trap step landed it but a passenger on a holder a
 * cut lands short of its walk, which sits on the stand where the trap step read it at its walk's spot there (a gap older than op
 * 51, hexFile.random.test.ts).
 */
function moved(made: Case, actor: Viewer, opVersion?: number): RoomState {
  const version = opVersion === undefined ? {} : { opVersion };
  const r = applyOp(made.state, made.op, actor, { ...env(1), ...version });
  assert.ok(r.ok);
  for (const [id, pose] of trapLandings(made.op, made.state, actor, version)) {
    const link = made.state.tokens[id]!.attached;
    if (link && onHolder(link.kind)) continue;
    const t: Token = r.state.tokens[id]!;
    assert.deepEqual([t.x, t.y, t.elevation], [pose.x, pose.y, pose.elevation], `${id} where the trap step landed it`);
  }
  return r.state;
}

describe("a stop steps each creature in single file off its holder where a clear spot in reach is left (HEXFILE-OPUS-6)", () => {
  test("hex columns, inside a corridor: the warhorse stopped squeezed on the stop trap's hex, the Tiny goblin steps back beside it, where op 62 left both goblins under it", () => {
    const g = COLUMNS;
    const made = insideCaseOf(875, g)!;
    assert.ok(made, "the room");
    assert.ok(canApply(made.op, P1, made.state, deps).ok);
    assert.notEqual(planTrapMove(made.op, made.state, P1, {}).op, made.op, "the trap cuts the move");
    const old = moved(made, P1, 62);
    const horse = hexesOf(g, old, "horse");
    assert.deepEqual([hexesOf(g, old, "tow0"), hexesOf(g, old, "tow1")], [horse, horse], "op 62: both goblins under the warhorse, as it ran");
    const after = moved(made, P1);
    assert.deepEqual(hexesOf(g, after, "horse"), horse, "the warhorse stops where it did");
    assert.ok(!hexesOf(g, after, "tow0").some((h) => horse.includes(h)), `the Tiny goblin off the warhorse, on ${hexesOf(g, after, "tow0")}`);
    assert.ok(linkHolds(g, after.meta.settings, "drag", after.tokens.tow0!, after.tokens.horse!), "and still dragged");
    // Only the one hex behind the warhorse is in its reach, so the other keeps the stop's spot, as before.
    assert.deepEqual(hexesOf(g, after, "tow1"), horse, "the other keeps its spot");
  });

  test("hex columns, a full-size warhorse stopped at the corridor's mouth: the goblin it drags steps back beside it, where op 62 left three under it", () => {
    const g = COLUMNS;
    const made = withStop(caseOf(44, g)!, 44);
    assert.ok(canApply(made.op, P1, made.state, deps).ok);
    const old = moved(made, P1, 62);
    const horse = hexesOf(g, old, "horse");
    assert.ok(hexesOf(g, old, "tow0").every((h) => horse.includes(h)), "op 62: the goblin under the warhorse, as it ran");
    const after = moved(made, P1);
    assert.ok(!hexesOf(g, after, "tow0").some((h) => horse.includes(h)), `the goblin off the warhorse, on ${hexesOf(g, after, "tow0")}`);
    assert.ok(linkHolds(g, after.meta.settings, "drag", after.tokens.tow0!, after.tokens.horse!), "and still dragged");
  });

  test("over the random rooms, Pat's and the DM's moves a trap cuts: no creature of the public class in the file shares a hex at op 63 that it did not at op 62, and some share none they did", () => {
    let cuts = 0;
    let fewer = 0;
    for (const [name, g] of [
      ["hex rows", ROWS],
      ["hex columns", COLUMNS],
    ] as const) {
      for (const [kind, make] of [
        ["", caseOf],
        ["inside ", insideCaseOf],
      ] as const) {
        for (let seed = 1; seed <= 400; seed++) {
          const room = make(seed, g);
          if (!room) continue;
          for (const [variant, made] of [
            ["", room],
            ["stop, ", withStop(room, seed)],
            ["imp, ", withImpAhead(room, seed)],
          ] as const) {
            if (!made) continue;
            for (const [who, actor] of [
              ["Pat", P1],
              ["the DM", DM],
            ] as const) {
              if (!canApply(made.op, actor, made.state, deps).ok || planTrapMove(made.op, made.state, actor, {}).op === made.op) continue;
              cuts++;
              const at = `${name} ${kind}seed ${seed}, ${variant}${who}`;
              // Each pair of the walk's lead and those of the file's public class (seen with their links) that share a hex where the
              // move leaves them. That class decides before the rest and reads none of it, so a creature it moves off the warhorse
              // may take the spot a hidden one, or one seen on a hidden holder, had stepped back to.
              const shared = (opVersion?: number): Set<string> => {
                const state = moved(made, actor, opVersion);
                const filed = planWalks(made.op, made.state, actor, opVersion === undefined ? {} : { opVersion }).filter((m) => m.file === true && m.pass === "public");
                const ids = [made.op.tokenId, ...filed.map((m) => m.tokenId)];
                const out = new Set<string>();
                for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) if (hexesOf(g, state, a).some((h) => hexesOf(g, state, b).includes(h))) out.add(`${a}+${b}`);
                return out;
              };
              const [old, now] = [shared(62), shared()];
              for (const pair of now) assert.ok(old.has(pair), `${at}: ${pair} share a hex only at op 63`);
              if (now.size < old.size) fewer++;
            }
          }
        }
      }
    }
    assert.ok(cuts >= 700 && fewer >= 40, `cuts ${cuts}, with fewer shared hexes ${fewer}`);
  });

  test("the rule is gated at 63", () => {
    assert.deepEqual([stopsStepApartInReach(1), stopsStepApartInReach(62), stopsStepApartInReach(63), stopsStepApartInReach(undefined)], [false, false, true, true]);
  });
});
