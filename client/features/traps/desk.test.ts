import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { LogEntry, TrapDue } from "#shared/model.ts";
import { DM, P1, room, token, trap } from "#shared/testutil.ts";
import { dmAlerts, linesAfter, metTrap, playerAlerts, watchOf } from "./alerts.ts";
import { deskTraps, didLines, foldedWithTraps, hiddenLine, lineOf, whoLines } from "./desk.ts";

const due = (id: string, over: Partial<TrapDue> = {}): TrapDue => ({ id, at: "2026-10-22T10:00:00.000Z", how: "enter", by: ["thorn"], hits: ["thorn"], ...over });

function world() {
  return room({
    tokens: {
      thorn: token("thorn", { name: "Thorn", kind: "pc", ownerIds: ["p1"] }),
      bree: token("bree", { name: "Bree", kind: "pc", ownerIds: ["p2"] }),
      imp: token("imp", { name: "Imp", visibility: "dm" }),
    },
    traps: {
      pit: trap("pit", { rig: { ...trap("x").rig!, sound: "crash", due: [due("12:0"), due("15:1", { by: ["imp"], hits: ["imp"], hidden: true })], actions: [{ show: { tokenId: "imp" } }, { light: "gone", on: false }] } }),
      net: trap("net", { name: "Falling Net", rig: { ...trap("x").rig!, due: [due("14:0", { how: "hand", by: ["thorn", "bree"], more: 2, hits: [] })] } }),
    },
  });
}

describe("the DM's trap cards (docs/design-v1-traps.md 4.3)", () => {
  test("every waiting springing, newest first", () => {
    assert.deepEqual(
      deskTraps(world().traps).map((d) => `${d.trap.id} ${d.due.id}`),
      ["pit 15:1", "net 14:0", "pit 12:0"],
    );
  });

  test("who set it off and who it hits, a hidden springing in words of its own, and what it did", () => {
    const s = world();
    assert.deepEqual(whoLines(s, due("1:0")), { by: "Thorn set it off.", hits: "It hits Thorn." });
    assert.deepEqual(whoLines(s, s.traps.net!.rig!.due![0]!), { by: "You set it off for Thorn, Bree and 2 more.", hits: "It hits no one." });
    assert.equal(hiddenLine(s, due("1:0", { by: ["imp"] })), "Imp set it off, out of the players' sight. The trap is still armed for them.");
    assert.deepEqual(didLines(s.traps.pit!, [{ action: 0, ok: true }, { action: 1, ok: false }, { action: -1, ok: false }], s), ["Showed Imp.", "Could not put out a light: it was deleted.", "Could not open the pit: the scene is at its wall limit."]);
    const shrunk = { ...s, scenes: { ...s.scenes, s1: { ...s.scenes.s1!, bounds: { w: 2, h: 2 } } } };
    const wide = { ...s.traps.pit!, zone: { cells: [{ x: 1, y: 1, w: 2, h: 2 }] } };
    assert.deepEqual(didLines(wide, [{ action: -1, ok: false }], shrunk), ["Could not open the pit: some of its squares lie outside the scene."], "a scene made smaller since");
    const log: LogEntry[] = [{ id: "12:0", at: "", kind: "event", data: { type: "trap", trapId: "pit", name: "Hidden Pit", how: "enter", by: ["thorn"], hits: 1, did: [{ action: 0, ok: true }] } }];
    assert.deepEqual(lineOf(log, "12:0")?.did, [{ action: 0, ok: true }]);
    assert.equal(lineOf(log, "13:0"), null, "a line the DM's log no longer holds");
  });

  test("the folded button counts the trap cards it folds, first", () => {
    assert.equal(foldedWithTraps(null, 0, "more"), null);
    assert.deepEqual(foldedWithTraps(null, 2, "sheet"), { text: "2 traps", label: "2 traps: 2 traps went off. Close the sheet to see them." });
    assert.deepEqual(foldedWithTraps({ text: "Rolls 1/3", label: "Rolls 1/3: 1 of 3 answered" }, 1, "more"), { text: "1 trap, Rolls 1/3", label: "1 trap, Rolls 1/3: 1 more trap went off, 1 of 3 answered" });
  });
});

describe("what a trap going off tells each device", () => {
  const line = (id: string, data: LogEntry["data"]): LogEntry => ({ id, at: "", kind: "event", data });
  const dmLog = [
    line("12:0", { type: "trap", trapId: "pit", name: "Hidden Pit", how: "enter", by: ["thorn"], hits: 1, did: [] }),
    line("14:0", { type: "trap", trapId: "net", name: "Falling Net", how: "hand", by: ["thorn"], hits: 1, did: [] }),
    line("15:1", { type: "trap", trapId: "pit", name: "Hidden Pit", how: "enter", by: ["imp"], hits: 1, did: [], hidden: true }),
  ];
  const seen = [line("12:1", { type: "trapSeen", by: ["thorn"], message: "The floor gives way!", sound: "crash" }), line("16:0", { type: "trapSeen", by: ["bree"], message: "Click." })];

  test("the DM hears every trap that went off but their own Set it off, with its sound", () => {
    assert.deepEqual(dmAlerts(dmLog, world()), [
      { text: "Hidden Pit went off: Thorn.", sound: "crash", trapId: "pit", due: "12:0" },
      { text: "Hidden Pit went off: Imp (hidden from players). The players saw nothing.", sound: "crash", trapId: "pit", due: "15:1" },
    ]);
    assert.deepEqual(linesAfter(dmLog, "12:0").map((e) => e.id), ["14:0", "15:1"]);
  });

  test("the Passive Perception hint is a toast of its own, which offers Mark found", () => {
    const s = world();
    s.traps.pit = { ...s.traps.pit!, rig: { ...s.traps.pit!.rig!, find: [{ ability: "wis", skill: "perception", dc: 15, what: "the pressure plate" }] } };
    assert.deepEqual(dmAlerts([line("17:0", { type: "trapNotice", trapId: "pit", tokenId: "thorn", passive: 16, dc: 15 })], s), [
      { text: "Thorn's Passive Perception (16) would notice the pressure plate of Hidden Pit (DC 15).", trapId: "pit", notice: true },
    ]);
  });

  test("a player hears a line that names a creature they play, and reads the rest in the log", () => {
    assert.deepEqual(playerAlerts(seen, world(), P1), [{ text: "Thorn: The floor gives way!", sound: "crash" }]);
    assert.deepEqual(playerAlerts(seen, world(), { memberId: "p2", role: "player" }), [{ text: "Bree: Click." }]);
    assert.deepEqual(playerAlerts(seen, world(), DM).length, 0, "the DM owns no party creature here");
  });

  test("a move met a trap when its token stands short of where it asked, or a players' line since names it", () => {
    const w = watchOf({ t: "token.move", tokenId: "thorn", x: 6, y: 2 }, 7, "12:1")!;
    assert.equal(metTrap(w, { tokens: { thorn: { x: 6, y: 2 } } }, seen), false, "landed, and Bree's line is not Thorn's");
    assert.equal(metTrap(w, { tokens: { thorn: { x: 4, y: 2 } } }, seen), true, "stopped on the way");
    assert.equal(metTrap({ ...w, since: "11:0" }, { tokens: { thorn: { x: 6, y: 2 } } }, seen), true, "its players were told");
    const lift = watchOf({ t: "token.update", tokenId: "thorn", patch: { elevation: 5 } }, 8, null)!;
    assert.deepEqual(lift.to, []);
    assert.equal(watchOf({ t: "chat.send", text: "hi" } as never, 9, null), null);
  });
});
