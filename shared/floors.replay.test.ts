import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { RoomState, Viewer } from "./model.ts";
import { hash128, projectState, stableStringify } from "./project.ts";
import { opSchema, type Op } from "./protocol.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, character, room, scene, token } from "./testutil.ts";

/*
 * Several floors replay nothing differently (docs/design/design-v1-floors.md 9,
 * 14): ops stored before floors, on rooms that have none, give the states
 * and the copies players get that the build before floors gave. Each
 * sequence's hashes were recorded on that build (floors-base 7f23997c, op
 * version 55) by running this file there with FLOORS_RECORD=1, and every op
 * is replayed twice: at its stored version 55, and live, as the same op
 * sent today on a room without floors.
 */

const STORED = 55;
const at = (i: number) => new Date(Date.UTC(2026, 5, 1, 20, 0, i)).toISOString();
const hashOf = (value: unknown) => hash128(stableStringify(value));
const pc = (id: string, sceneId: string, owner: string) => token(id, { sceneId, kind: "pc", name: id, ownerIds: [owner], actor: { ref: `c-${id}` }, hpVisibility: "exact" });

type Sequence = { name: string; start: () => RoomState; ops: Op[]; viewers: { viewer: Viewer; sceneId: string | null }[]; steps: string[]; copies: string[] };

const three = () => ({ s1: scene("s1", { name: "Gate" }), s2: scene("s2", { name: "Hall", order: 1 }), s3: scene("s3", { name: "Crypt", order: 2 }) });

const SEQUENCES: Sequence[] = [
  {
    name: "a blackout with a guarded reveal, twice",
    start: () => room({ scenes: three(), characters: { "c-thorn": character("c-thorn", { ownerIds: ["p1"] }) } }),
    ops: [
      { t: "view.blackout", blackout: true },
      { t: "room.setPlayerScene", sceneId: "s2" },
      { t: "view.blackout", blackout: false, whilePlayersOn: "s2" },
      { t: "token.create", token: { id: "thorn", sceneId: "s2", kind: "pc", name: "Thorn", size: "medium", x: 2, y: 2, actor: { ref: "c-thorn" } } },
      { t: "view.blackout", blackout: true },
      { t: "room.setPlayerScene", sceneId: "s3" },
      { t: "view.blackout", blackout: false, whilePlayersOn: "s3" },
    ],
    viewers: [
      { viewer: P1, sceneId: null },
      { viewer: P2, sceneId: null },
      { viewer: DM, sceneId: "s2" },
    ],
    steps: ["8ed930d5e9d351889e07a91c3ee9a7c6", "dec89ee78c871271bec0abf49c566f83", "2a77ec69e56c91eea13dd33e9f5cabea", "043ae0b868eacb75f1731d80455b6ff9", "cb078538a28d61dcf62696f27d39f999", "f69c6e2f4c5fb53360801d9036625414", "f5ee9436fe3028249781c9275a08ccb0"],
    copies: ["e85df93ab0d7728965ea4e981b2e4b6c", "d7fdf32e3db267fa8311429d030d7f0f", "fb5ada90e60da202b8b553aa49f136ed"],
  },
  {
    name: "a scene sound started by a move and a daylight pass over three scenes",
    start: () =>
      room({
        scenes: three(),
        sounds: { wind: { id: "wind", rev: 0, name: "Wind", assetId: "a-wind", ms: 60_000, use: "loop" } },
      }),
    ops: [
      { t: "scene.update", sceneId: "s2", patch: { sound: { music: null, loops: [{ soundId: "wind", volume: 70 }] } } },
      { t: "room.setPlayerScene", sceneId: "s2" },
      { t: "sound.scene", sceneId: "s2", onMove: true, order: [], run: "r1" },
      { t: "clock.start", id: "clock1", at: 6 * 3600, shown: true, calendar: { kind: "days" } },
      { t: "scene.update", sceneId: "s1", patch: { vision: { on: true, light: "dark", byClock: true } } },
      { t: "scene.update", sceneId: "s2", patch: { vision: { on: true, light: "dark", byClock: true } } },
      { t: "scene.update", sceneId: "s3", patch: { vision: { on: false, light: "bright", byClock: true } } },
      { t: "clock.advance", by: 13 * 3600 },
      { t: "clock.set", at: 30 * 3600 },
    ],
    viewers: [
      { viewer: P1, sceneId: null },
      { viewer: DM, sceneId: "s3" },
    ],
    steps: ["6b36bb055543ce00c083b71372cc7141", "f3896174616fcb21b911c10b14e66570", "23c7a6d904f838be8362048f9df4ea27", "a4a154b68174a5d3563ca5d367c5387b", "2167d74d96ba4dc14d4162feee1b8b83", "bf2e6d699361485bfe0372806a73a1c9", "d9f3576ed1bfc448e0f1ee0484d632a4", "295102a4b844a7c92334d50f7b0ed98e", "970d94a32e6aa57ab6768b60ba754923"],
    copies: ["b2c334217c828a1c6aeff69a5af5558f", "390990180e4febde821f04c600476642"],
  },
  {
    name: "two ordinary scenes, blackout off, and a fight moving on the scene the players are not on",
    start: () =>
      room({
        characters: { "c-thorn": character("c-thorn", { ownerIds: ["p1"] }) },
        tokens: {
          thorn: pc("thorn", "s1", "p1"),
          gob1: token("gob1", { sceneId: "s2", x: 4, y: 4, actor: { inline: actor() } }),
          gob2: token("gob2", { sceneId: "s2", x: 8, y: 4, name: "Goblin", actor: { inline: actor() } }),
        },
      }),
    ops: [
      {
        t: "encounter.start",
        entries: [
          { id: "e1", tokenId: "gob1", value: 15 },
          { id: "e2", tokenId: "gob2", value: 9 },
          { id: "e3", tokenId: "thorn", value: 12 },
        ],
      },
      { t: "encounter.next" },
      { t: "token.move", tokenId: "gob1", x: 6, y: 5 },
      { t: "encounter.next" },
      { t: "token.move", tokenId: "thorn", x: 5, y: 5 },
      { t: "encounter.next" },
      { t: "token.move", tokenId: "gob2", x: 9, y: 9 },
      { t: "encounter.end" },
    ],
    viewers: [
      { viewer: P1, sceneId: null },
      { viewer: P2, sceneId: null },
      { viewer: DM, sceneId: "s2" },
    ],
    steps: ["9d2de72fcf2cdb5756afe5de4e9a8b07", "179781c4dec72efc3db17df8a562a415", "3d4b03654936ec100c64f46ddabfc386", "762a0c35094565b095d947bdbcec2c56", "82d00e63def2854136551c9bccd1e083", "5a060229706c7c8eaf45c61e84fee585", "b1f6c14157b794fbd0700ea8d1c03bfe", "03924e19450b63ad8b5527cc02d6c297"],
    copies: ["ecca28346456f4affa1aefb7525a104e", "f98a2a3091c1868cfca23643ce5a91c0", "0ed3c50624402f56e6bbed36fcc0dabe"],
  },
];

/** Each op's state hash, then each viewer's copy of the end, applying every op at `opVersion`. */
function replay(seq: Sequence, opVersion: number | undefined): { steps: string[]; copies: string[] } {
  let state = seq.start();
  const steps: string[] = [];
  seq.ops.forEach((raw, i) => {
    const op = opSchema.parse(raw);
    const r = applyOp(state, op, DM, { seq: i + 1, at: at(i), ...(opVersion === undefined ? {} : { opVersion }) });
    assert.ok(r.ok, `${seq.name}, op ${i} (${op.t}): ${r.ok ? "" : r.message}`);
    state = r.state;
    steps.push(hashOf(state));
  });
  const copies = seq.viewers.map(({ viewer, sceneId }) => hashOf(projectState(state, viewer, { sceneId })));
  return { steps, copies };
}

if (process.env.FLOORS_RECORD === "1") {
  for (const seq of SEQUENCES) console.log(JSON.stringify({ name: seq.name, ...replay(seq, STORED) }));
}

describe("rooms without floors replay as the build before floors left them (9)", () => {
  for (const seq of SEQUENCES) {
    for (const [how, version] of [
      ["at their stored version", STORED],
      ["live", undefined],
    ] as const) {
      test(`${seq.name}, ${how}`, () => {
        const got = replay(seq, version);
        assert.deepEqual(got.steps, seq.steps, "each op's state");
        assert.deepEqual(got.copies, seq.copies, "each viewer's copy of the end");
      });
    }
  }
});
