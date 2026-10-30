import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { LogEntry, RoomState } from "#shared/model.ts";
import { LIMITS } from "#shared/limits.ts";
import { DM_LINE_BASE, MAX_LOG } from "#shared/logRings.ts";
import { hpUndoRestore } from "#shared/reducer/hpUndo.ts";
import { projectArchivedLog, projectState } from "#shared/project.ts";
import { actor, apply, customMonster, DM, P1, room, token } from "#shared/testutil.ts";
import { canTakeBack, canUndoLogLine, fightHpLines } from "./hpLog.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { HpLog } = await import("./HpLog.tsx");
const { default: LogPanel } = await import("../../panels/LogPanel.tsx");

function hurtGoblin(): RoomState {
  let state = room();
  state.tokens.gob = token("gob", { name: "Goblin", actor: { inline: actor({ hp: { cur: 7, max: 7, temp: 0 } }) } });
  state = apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 1 } }, DM, 1);
  state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob", value: 10 }] }, DM, 2);
  state = apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 2 } }, DM, 3);
  return apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "heal", amount: 1 } }, DM, 4);
}

describe("the combat log of HP changes", () => {
  test("FU39-ASTRA-02: the general log renders Undo from the current server retention", () => {
    const view = projectState(hurtGoblin(), DM, { sceneId: "s1" });
    const render = (hpUndoLogIds: string[] | undefined) => {
      const store = createStore(() => ({ roomId: "room", view: { ...view, meta: { ...view.meta, hpUndoLogIds } }, you: DM, sceneId: "s1" }));
      return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(LogPanel, { selectedTokenId: null, shown: true, close() {} }) }));
    };
    assert.match(render(view.meta.hpUndoLogIds), /Undo this change/);
    assert.doesNotMatch(render([]), /Undo this change/, "cached revert data cannot override an empty live retention list");
    assert.match(render(undefined), /Undo this change/, "an older server still supports Undo on its live lines");
  });

  test("FU39-ASTRA-02: one loaded archive page loses Undo as the live room drops the retained HP line", () => {
    let state = hurtGoblin();
    const heal = state.log.at(-1)!;
    state.log = [...state.log, ...Array.from({ length: LIMITS.dmLogLines }, (_, i): LogEntry => ({ id: `${10 + i}:${DM_LINE_BASE}`, at: heal.at, kind: "event", data: { type: "teleport", tokenId: "gob", past: "wall" } }))];
    const older = projectArchivedLog(state, [heal], DM, { sceneId: "s1" });
    let view = projectState(state, DM, { sceneId: "s1" });
    assert.ok(!view.log.some((line) => line.id === heal.id), "the retained line is outside the live tail");
    assert.equal(canUndoLogLine(view as RoomState, [...older, ...view.log], older[0]!, view.meta.hpUndoLogIds ?? []), true);
    assert.ok(hpUndoRestore(state, heal.id).ok);
    for (let i = 0; i < MAX_LOG; i++) state = apply(state, { t: "log.chat", text: `next ${i}` }, DM, 1_000 + i);
    view = projectState(state, DM, { sceneId: "s1" });
    assert.equal(hpUndoRestore(state, heal.id).ok, false, "server retention expired");
    assert.equal(canUndoLogLine(view as RoomState, [...older, ...view.log], older[0]!, view.meta.hpUndoLogIds ?? []), false, "the same cached page loses Undo without another fetch");
    assert.equal(older[0]!.id, heal.id, "the old line remains readable");
  });

  test("FU23A-OPUS-9b: an archived HP line still held by the server offers Undo after the DM ring cuts the live view", () => {
    const state = hurtGoblin();
    const heal = state.log.at(-1)!;
    state.log = [...state.log, ...Array.from({ length: LIMITS.dmLogLines }, (_, i): LogEntry => ({ id: `${10 + i}:${DM_LINE_BASE}`, at: heal.at, kind: "event", data: { type: "teleport", tokenId: "gob", past: "wall" } }))];
    const view = projectState(state, DM, { sceneId: "s1" });
    assert.ok(!view.log.some((e) => e.id === heal.id), "the ring cut the HP line from the DM's live log");
    const archived = projectArchivedLog(state, [heal], DM, { sceneId: "s1" })[0]!;
    assert.ok(hpUndoRestore(state, archived.id).ok, "the server can still take it back");
    assert.equal(canUndoLogLine(view as RoomState, view.log, archived, view.meta.hpUndoLogIds ?? []), true);
    const dropped = { ...state, log: state.log.filter((e) => e.id !== heal.id) };
    const gone = projectArchivedLog(dropped, [heal], DM, { sceneId: "s1" })[0]!;
    assert.equal(canUndoLogLine(view as RoomState, view.log, gone, view.meta.hpUndoLogIds ?? []), false, "an archive-only line offers no Undo");
    const taken: LogEntry = { id: "1000:0", at: heal.at, kind: "event", data: { type: "hp", change: "heal", back: true, of: heal.id } };
    const already = projectArchivedLog({ ...state, log: [...state.log, taken] }, [heal], DM, { sceneId: "s1" })[0]!;
    assert.equal(canUndoLogLine(view as RoomState, [], already, view.meta.hpUndoLogIds ?? []), false, "a take-back outside the loaded page still prevents another");
  });
  test("FL3-ASTRA-01: a defense that stops the hit leaves a line without a take-back", () => {
    let state = room({
      monsters: { immune: customMonster("immune", { immunities: "Fire" }) },
      tokens: { gob: token("gob", { actor: { inline: actor({ monsterId: "immune" }) } }) },
    });
    state = apply(state, { t: "encounter.start", entries: [{ id: "n1", tokenId: "gob", value: 10 }] }, DM, 1);
    state = apply(state, { t: "actor.hp", target: { tokenId: "gob" }, change: { kind: "damage", amount: 10, parts: [{ amount: 10, type: "fire" }] } }, DM, 2);
    const lines = fightHpLines(state.log);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.data.amount, 0);
    assert.equal(canTakeBack(state, state.log, lines[0]!), false);
    assert.equal(hpUndoRestore(state, lines[0]!.entry.id).ok, false);
    for (const you of [DM, P1]) {
      const view = projectState(state, you, { sceneId: "s1" });
      const store = createStore(() => ({ view, you }));
      const markup = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(HpLog) }));
      assert.doesNotMatch(markup, /Undo this change|Immune|Resists/);
      assert.match(markup, you.role === "dm" ? /takes 0 damage, 20\/20 left\./ : /takes damage \(Healthy\)\./);
    }
  });

  test("lists the fight's HP lines, newest first, and none from before it began", () => {
    const lines = fightHpLines(hurtGoblin().log);
    assert.deepEqual(lines.map((l) => [l.data.change, l.data.amount]), [["heal", 1], ["damage", 2]]);
  });

  test("offers the DM an undo only where it would apply", () => {
    let state = hurtGoblin();
    const [heal, hit] = fightHpLines(state.log);
    assert.equal(canTakeBack(state, state.log, heal!), true);
    assert.equal(canTakeBack(state, state.log, hit!), false, "the heal since changed the goblin");
    const built = hpUndoRestore(state, heal!.entry.id);
    assert.ok(built.ok);
    state = apply(state, { t: "sys.restore", entries: built.entries, from: "undo", deps: true, undid: heal!.entry.id }, DM, 5);
    const [back, ...rest] = fightHpLines(state.log);
    assert.equal(back!.data.back, true);
    assert.equal(canTakeBack(state, state.log, back!), false, "a take-back is not taken back from the log");
    assert.equal(canTakeBack(state, state.log, rest[0]!), false, "the heal was already taken back");
    assert.equal(canTakeBack(state, state.log, rest[1]!), true, "now the hit can go");
    // A DM viewing another scene does not hold the token, and the server decides.
    const elsewhere = { ...state, tokens: {} };
    assert.equal(canTakeBack(elsewhere, state.log, rest[1]!), true);
  });
});
