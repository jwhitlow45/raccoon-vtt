import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { uuidv7 } from "#shared/ids.ts";
import type { LogEntry } from "#shared/model.ts";
import type { ProjectedState } from "#shared/project.ts";
import type { Op, ServerMessage } from "#shared/protocol.ts";
import { Socket, startEngine, type Engine, type TestClient } from "./testing.ts";

/**
 * View as a player's socket (docs/design-v1-per-player-vision.md 7.4,
 * security rule 8, lane PV3): `/ws?as=<memberId>` opens only for a DM grant
 * and a player of the roster, is read only, never takes its DM's
 * acknowledgments, is in no presence list, and never carries a whisper its
 * DM is not party to, live or in an older log page.
 */

type Table = { roomId: string; dm: TestClient; dmId: string; pip: TestClient; pipId: string; quin: TestClient; quinId: string; dmSocket: Socket };

async function sitDown(t: Engine, name: string): Promise<Table> {
  const dm = t.client();
  const { roomId } = await dm.createRoom(name);
  const pip = t.client();
  const pipId = await pip.join(roomId, "Pip");
  const quin = t.client();
  const quinId = await quin.join(roomId, "Quin");
  const dmSocket = await t.connect(roomId, dm);
  const snap = await dmSocket.snapshot("dm-device");
  return { roomId, dm, dmId: snap.you.memberId, pip, pipId, quin, quinId, dmSocket };
}

/** A socket viewing as `memberId`, opened with `client`'s room cookie. */
function preview(t: Engine, client: TestClient, roomId: string, memberId: string): Promise<Socket> {
  return Socket.open(`${t.url}/ws?room=${roomId}&as=${encodeURIComponent(memberId)}`, {
    origin: t.config.publicOrigin,
    cookie: client.token ? `rvtt=${client.token}` : "",
    "cf-connecting-ip": client.ip,
    "user-agent": "preview-itest",
  });
}

const texts = (lines: readonly LogEntry[]) => lines.map((l) => l.text ?? "");
/** A roll's words or dice: players learn only that the DM rolled to themselves, as every player does. */
const hiddenRoll = (l: LogEntry) => l.data?.type === "dice" && (l.data.rolls.length > 0 || JSON.stringify(l.data).includes("Secret check"));
const lineTexts = (m: Extract<ServerMessage, { t: "ev" }>) => m.changes.flatMap((c) => ("value" in c && c.key.startsWith("log:") ? [(c.value as LogEntry).text ?? ""] : []));

describe("view as a player's socket", () => {
  let t: Engine;
  before(async () => {
    t = await startEngine();
  });
  after(() => t.close());

  test("only a DM grant opens one, and only for a player of the roster", async () => {
    const { roomId, dm, dmId, pip, pipId, quinId } = await sitDown(t, "Preview grants");
    await assert.rejects(preview(t, pip, roomId, quinId), /upgrade refused: 403/, "a player grant");
    await assert.rejects(preview(t, dm, roomId, dmId), /upgrade refused: 403/, "a DM member");
    await assert.rejects(preview(t, dm, roomId, "display:abcdefghijkl"), /upgrade refused: 403/, "a display's id");
    await assert.rejects(preview(t, dm, roomId, uuidv7()), /upgrade refused: 403/, "an unknown id");
    await assert.rejects(preview(t, t.client(), roomId, pipId), /upgrade refused: 403/, "no grant at all");
    const s = await preview(t, dm, roomId, pipId);
    const snap = await s.snapshot("preview-device");
    assert.deepEqual(snap.you, { memberId: pipId, role: "player", sceneId: (snap.state as ProjectedState).meta.playerSceneId });
    assert.equal(snap.watermark, 0);
    s.close();
  });

  test("a hello that names `as` closes any socket with 4003", async () => {
    const { roomId, dm } = await sitDown(t, "Hello as");
    const s = await t.connect(roomId, dm);
    s.send({ t: "hello", clientId: "c1", resumeFrom: 1, as: "anyone" });
    assert.equal((await s.waitClosed()).code, 4003);
  });

  for (const [what, msg] of [
    ["an op", { t: "op", n: 1, op: { t: "log.chat", text: "from the preview" } }],
    ["a drag frame", { t: "eph", sceneId: "nowhere", e: { k: "ping", x: 1, y: 1 } }],
    ["a malformed frame", { t: "eph", sceneId: "nowhere", e: { k: "nonsense" } }],
    ["a scene request", { t: "scene", sceneId: "nowhere" }],
  ] as const) {
    test(`${what} from a preview closes it with 4003`, async () => {
      const { roomId, dm, pipId } = await sitDown(t, `Read only ${what}`);
      const s = await preview(t, dm, roomId, pipId);
      await s.snapshot("preview-device");
      s.send(msg);
      assert.equal((await s.waitClosed()).code, 4003);
    });
  }

  test("a preview with its DM device's own client id never takes that device's answers, and is in no presence list", async () => {
    const { roomId, dm, pipId, quin, dmSocket } = await sitDown(t, "Preview acks");
    const quinSocket = await t.connect(roomId, quin);
    await quinSocket.snapshot("quin-device");
    await quinSocket.next("presence");
    const s = await preview(t, dm, roomId, pipId);
    // The DM's device asked with this client id, from the same session.
    await s.snapshot("dm-device");
    // The roster as the preview's arrival left it, sent to every other socket.
    const presence = await quinSocket.next("presence");
    assert.ok(presence.online.includes(quin ? (await quin.me(roomId)).memberId! : ""), "Quin is online");
    assert.ok(!presence.online.includes(pipId), "Pip is not online: the DM viewing as Pip is no socket of Pip's");
    for (let i = 0; i < 3; i++) {
      const n = dmSocket.op({ t: "log.chat", text: `line ${i}` });
      const answered = await dmSocket.next("ev", (m) => m.acks?.includes(n) ?? false);
      assert.ok(answered.acks?.includes(n), `op ${i} answered on the DM's device`);
      const seen = await s.next("ev", (m) => lineTexts(m).includes(`line ${i}`));
      assert.equal(seen.acks, undefined, `the preview takes no answer for op ${i}`);
    }
    s.close();
    quinSocket.close();
  });

  test("no whisper between players reaches a preview, live or in an older page, nor a DM-only line or a hidden roll", async () => {
    const { roomId, dm, pip, pipId, quinId, dmSocket } = await sitDown(t, "Preview whispers");
    const pipSocket = await t.connect(roomId, pip);
    const pipState = (await pipSocket.snapshot("pip-device")).state as ProjectedState;
    const sceneId = pipState.meta.playerSceneId!;
    await pipSocket.apply({ t: "log.whisper", to: [quinId], text: "between players" });
    await dmSocket.apply({ t: "log.whisper", to: [pipId], text: "from the DM" });
    await pipSocket.apply({ t: "log.whisper", to: [(await dm.me(roomId)).memberId!], text: "to the DM" });
    await dmSocket.apply({ t: "dice.roll", tag: uuidv7(), to: "dm", rolls: [{ formula: "1d20", label: "Secret check" }] } as Op);
    const lurker = uuidv7();
    await dmSocket.apply({ t: "token.create", token: { id: lurker, sceneId, kind: "monster", name: "Lurker", size: "medium", x: 2, y: 2, visibility: "dm", actor: { inline: { hp: { cur: 9, max: 9, temp: 0 }, life: "alive", ac: 12, speeds: { walk: 30 }, initBonus: 0, passivePerception: 10, senses: "", effects: [], deathSaves: { ok: 0, fail: 0 }, notes: "", dmNotes: "" } } } } as Op);
    await dmSocket.apply({ t: "actor.hp", target: { tokenId: lurker }, change: { kind: "damage", amount: 3 } } as Op);
    const s = await preview(t, dm, roomId, pipId);
    const snap = (await s.snapshot("preview-device")).state as ProjectedState;
    const seen = texts(snap.log);
    assert.ok(seen.includes("from the DM") && seen.includes("to the DM"), "whispers with the DM stay");
    assert.ok(!seen.includes("between players"), "the snapshot leaves out the whisper between players");
    assert.ok(!snap.log.some(hiddenRoll) && !snap.log.some((l) => l.data?.type === "hp"), "no hidden roll or DM-only line");
    // Live: Pip whispers to Quin again, and only Pip's own device hears it.
    await pipSocket.apply({ t: "log.whisper", to: [quinId], text: "again between players" });
    assert.equal(await s.maybe("ev", (m) => lineTexts(m).includes("again between players")), null, "the live whisper stays out");
    await dmSocket.apply({ t: "log.chat", text: "after" });
    await s.next("ev", (m) => lineTexts(m).includes("after"));
    // Older pages asked as Pip: Pip's page less the whispers between players, naming Pip.
    const page = await dm.get(`/api/rooms/${roomId}/log?limit=50&as=${pipId}`);
    assert.equal(page.statusCode, 200, page.body);
    const body = page.json<{ entries: LogEntry[]; as?: string }>();
    assert.equal(body.as, pipId);
    assert.ok(texts(body.entries).includes("from the DM") && texts(body.entries).includes("to the DM"));
    assert.ok(!texts(body.entries).some((x) => x.includes("between players")), "no whisper between players in an older page");
    assert.ok(!body.entries.some(hiddenRoll) && !body.entries.some((l) => l.data?.type === "hp"), "no hidden roll or DM-only line in an older page");
    const own = (await dm.get(`/api/rooms/${roomId}/log?limit=50`)).json<{ entries: LogEntry[]; as?: string }>();
    assert.equal(own.as, undefined, "the DM's own page names no one");
    assert.ok(own.entries.some(hiddenRoll) && own.entries.some((l) => l.data?.type === "hp"), "the DM's own page has both");
    assert.equal((await pip.get(`/api/rooms/${roomId}/log?as=${pipId}`)).statusCode, 403, "a player may not ask as anyone");
    assert.equal((await dm.get(`/api/rooms/${roomId}/log?as=${(await dm.me(roomId)).memberId}`)).statusCode, 403, "nor a DM as a DM");
    assert.equal((await dm.get(`/api/rooms/${roomId}/log?as=${uuidv7()}`)).statusCode, 403, "nor as no one on the roster");
    s.close();
    pipSocket.close();
  });
});
