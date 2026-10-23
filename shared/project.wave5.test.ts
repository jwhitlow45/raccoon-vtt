import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { keys } from "./keys.ts";
import { eventLines } from "./logRings.ts";
import type { JournalPage, Pin, RollRequest, RoomState, Viewer } from "./model.ts";
import { dependents, projectEntity, projectState, visibleAssetIds, type ProjectedToken } from "./project.ts";
import { applyOp } from "./reducer.ts";
import { DM, P1, P2, actor, character, env, imageRef, member, reveal, room, scene, token } from "./testutil.ts";

/**
 * Projection of wave 5's state (docs/design-v1-dm-tools.md 2.1): journal
 * pages with secret blocks, map pins, roll requests and their log lines,
 * the room monster a token was placed from, the derived `party` flag, and
 * icons in the visible asset set. A table display is a player who owns
 * nothing (section 3.1).
 */
const DISPLAY: Viewer = { memberId: "display:abcdefghijkl", role: "player" };
const ON_S1 = { sceneId: "s1" };

const BLOCK = (n: number) => `block${String(n).padStart(7, "0")}`;

function page(id: string, access: JournalPage["access"], overrides: Partial<JournalPage> = {}): JournalPage {
  return {
    id,
    rev: 4,
    title: `Page ${id}`,
    access,
    blocks: [
      { id: BLOCK(1), text: "Public text." },
      { id: BLOCK(2), text: "Hidden truth.", secret: { revealed: false } },
      { id: BLOCK(3), text: "Revealed truth.", secret: { revealed: true } },
    ],
    ...overrides,
  };
}

function pin(id: string, overrides: Partial<Pin> = {}): Pin {
  return { id, rev: 2, sceneId: "s1", x: 2.5, y: 2.5, color: "#ff8800", visibility: "all", ...overrides };
}

function journalRoom(): RoomState {
  return room({ journal: { all: page("all", "all"), dm: page("dm", "dm"), mine: page("mine", { member: "p1" }), theirs: page("theirs", { member: "p2" }) } });
}

describe("journal pages", () => {
  test("the DM gets every page, a player only those shared with all or with them, without unrevealed secrets or flags, at rev 0", () => {
    const state = journalRoom();
    assert.deepEqual(Object.keys(projectState(state, DM, ON_S1).journal).sort(), ["all", "dm", "mine", "theirs"]);
    assert.equal(projectState(state, DM, ON_S1).journal.dm, state.journal.dm);
    const p1 = projectState(state, P1, ON_S1).journal;
    assert.deepEqual(Object.keys(p1).sort(), ["all", "mine"]);
    assert.deepEqual(p1.mine, {
      id: "mine",
      rev: 0,
      title: "Page mine",
      access: { member: "p1" },
      blocks: [
        { id: BLOCK(1), text: "Public text." },
        { id: BLOCK(3), text: "Revealed truth." },
      ],
    });
    assert.ok(!JSON.stringify(projectState(state, P1, ON_S1)).includes("Hidden truth"));
  });

  test("a table display gets the pages shared with all, as a player who owns nothing", () => {
    assert.deepEqual(Object.keys(projectState(journalRoom(), DISPLAY, ON_S1).journal), ["all"]);
  });

  test("no page reaches a player during a blackout", () => {
    const state = journalRoom();
    state.meta.view = { follow: false, blackout: true };
    assert.deepEqual(projectState(state, P1, ON_S1).journal, {});
  });

  test("an edit inside a block players cannot see sends them nothing, and a reveal sends the block", () => {
    const state = journalRoom();
    const before = projectEntity(keys.journal("all"), state, P1, ON_S1);
    const edited = applyOp(state, { t: "journal.update", pageId: "all", patch: { blocks: [{ id: BLOCK(1), text: "Public text." }, { id: BLOCK(2), text: "A darker truth.", secret: true }, { id: BLOCK(3), text: "Revealed truth.", secret: true }] } }, DM, env(1));
    assert.ok(edited.ok);
    assert.deepEqual(projectEntity(keys.journal("all"), edited.state, P1, ON_S1), before);
    const shown = applyOp(edited.state, { t: "journal.reveal", pageId: "all", blockId: BLOCK(2), revealed: true }, DM, env(2));
    assert.ok(shown.ok);
    assert.deepEqual((projectEntity(keys.journal("all"), shown.state, P1, ON_S1) as JournalPage).blocks.map((b) => b.text), ["Public text.", "A darker truth.", "Revealed truth."]);
  });
});

describe("map pins", () => {
  function pinRoom(): RoomState {
    const state = journalRoom();
    state.pins = {
      plain: pin("plain"),
      hidden: pin("hidden", { visibility: "dm" }),
      toAll: pin("toAll", { pageId: "all" }),
      toDm: pin("toDm", { pageId: "dm" }),
      toMine: pin("toMine", { pageId: "mine" }),
      toTheirs: pin("toTheirs", { pageId: "theirs" }),
      elsewhere: pin("elsewhere", { sceneId: "s2" }),
    };
    return state;
  }

  test("the DM gets every pin on the viewed scene, a player those not DM only whose page they may read", () => {
    const state = pinRoom();
    assert.deepEqual(Object.keys(projectState(state, DM, ON_S1).pins).sort(), ["hidden", "plain", "toAll", "toDm", "toMine", "toTheirs"]);
    assert.deepEqual(Object.keys(projectState(state, P1, ON_S1).pins).sort(), ["plain", "toAll", "toMine"]);
    assert.deepEqual(Object.keys(projectState(state, P2, ON_S1).pins).sort(), ["plain", "toAll", "toTheirs"]);
    assert.deepEqual(Object.keys(projectState(state, DISPLAY, ON_S1).pins).sort(), ["plain", "toAll"]);
  });

  test("a pin on a fully fogged cell is withheld, as a label is", () => {
    const state = pinRoom();
    state.scenes.s1 = scene("s1", { fogEnabled: true });
    assert.deepEqual(Object.keys(projectState(state, P1, ON_S1).pins), []);
    reveal(state, "s1", { x: 2, y: 2, w: 1, h: 1 });
    assert.deepEqual(Object.keys(projectState(state, P1, ON_S1).pins).sort(), ["plain", "toAll", "toMine"]);
  });

  test("a page made readable re-projects its pins, with no global change", () => {
    const state = pinRoom();
    const shared = applyOp(state, { t: "journal.update", pageId: "dm", patch: { access: "all" } }, DM, env(1));
    assert.ok(shared.ok && !shared.global);
    assert.ok(dependents(shared.state, shared.touched).includes(keys.pin("toDm")));
    assert.ok(projectEntity(keys.pin("toDm"), shared.state, P1, ON_S1));
  });

  test("a page's deletion keeps its pins from every player", () => {
    const deleted = applyOp(pinRoom(), { t: "journal.delete", pageId: "all" }, DM, env(1));
    assert.ok(deleted.ok);
    for (const viewer of [P1, P2, DISPLAY]) assert.equal(projectEntity(keys.pin("toAll"), deleted.state, viewer, ON_S1), null);
  });

  test("exploring re-projects the pins on the tiles it wrote, beside labels and stamps", () => {
    const state = pinRoom();
    const touched = [keys.explored("s1", 0, 0)];
    const out = dependents(state, touched);
    assert.ok(out.includes(keys.pin("plain")));
    assert.ok(!out.includes(keys.pin("elsewhere")));
  });
});

describe("roll requests", () => {
  function rollRoom(request: Partial<RollRequest> = {}): RoomState {
    const state = room();
    state.characters.thorn = character("thorn", { name: "Thorn", ownerIds: ["p1"] });
    state.characters.vex = character("vex", { name: "Vex", ownerIds: ["p2"] });
    state.rolls.r1 = {
      id: "r1",
      rev: 3,
      test: { kind: "save", choices: [{ ability: "dex" }] },
      dc: 15,
      dcShown: true,
      resultShown: true,
      note: "against the trap",
      at: "2026-10-14T20:00:00.000Z",
      targets: [
        { characterId: "thorn", total: 12, result: "fail", by: "p1", previous: { total: 18, result: "pass" } },
        { characterId: "vex", total: 17, result: "pass", by: "dm1" },
      ],
      ...request,
    };
    return state;
  }

  test("a player gets only their own targets, with no by or previous, at rev 0", () => {
    assert.deepEqual(projectState(rollRoom(), P1, ON_S1).rolls.r1, {
      id: "r1",
      rev: 0,
      test: { kind: "save", choices: [{ ability: "dex" }] },
      dc: 15,
      dcShown: true,
      resultShown: true,
      note: "against the trap",
      at: "2026-10-14T20:00:00.000Z",
      targets: [{ characterId: "thorn", total: 12, result: "fail" }],
    });
    assert.deepEqual(projectState(rollRoom(), DM, ON_S1).rolls.r1, rollRoom().rolls.r1);
  });

  test("a hidden DC arrives as dcHidden with no number, and a hidden result not at all", () => {
    const hidden = projectState(rollRoom({ dcShown: false, resultShown: false }), P1, ON_S1).rolls.r1!;
    assert.equal(hidden.dc, undefined);
    assert.equal(hidden.dcHidden, true);
    assert.deepEqual(hidden.targets, [{ characterId: "thorn", total: 12 }]);
    assert.ok(!JSON.stringify(hidden).includes("15"));
    // A request with no DC carries neither, so a player tells the two apart only by dcHidden.
    const none = projectState(rollRoom({ dc: undefined, dcShown: false }), P1, ON_S1).rolls.r1!;
    assert.equal(none.dc, undefined);
    assert.equal(none.dcHidden, undefined);
  });

  test("a player's own fail without rolling reaches them with pass or fail hidden, and no one else's answer or the DM's mark does", () => {
    const state = rollRoom({ resultShown: false, dc: 12, dcShown: false });
    state.rolls.r1!.targets = [
      { characterId: "thorn", result: "fail", noRoll: true, by: "p1" },
      { characterId: "vex", result: "fail", by: "dm1" },
    ];
    // Thorn's player knows they answered, so another device or a reload does not ask again.
    assert.deepEqual(projectState(state, P1, ON_S1).rolls.r1!.targets, [{ characterId: "thorn", noRoll: true }]);
    // The DM's bare mark on Vex stays the DM's while pass or fail is hidden, and Thorn's answer never reaches Vex's player.
    assert.deepEqual(projectState(state, P2, ON_S1).rolls.r1!.targets, [{ characterId: "vex" }]);
    assert.equal(projectState(state, DISPLAY, ON_S1).rolls.r1, undefined);
    // A DM's reopen clears it, which the player now sees.
    state.rolls.r1!.targets[0] = { characterId: "thorn", previous: { result: "fail", noRoll: true } };
    assert.deepEqual(projectState(state, P1, ON_S1).rolls.r1!.targets, [{ characterId: "thorn" }]);
    // The log line keeps the choice for its creature's players too, and its text says so.
    const test_ = { kind: "save" as const, choices: [{ ability: "dex" as const }] };
    state.log = [{ id: "0:0", at: "x", kind: "event", data: { type: "roll", test: test_, characterId: "thorn", result: "fail", noRoll: true, dc: 12 } }];
    assert.deepEqual(projectState(state, P1, ON_S1).log[0]!.data, { type: "roll", test: test_, characterId: "thorn", noRoll: true });
    assert.deepEqual(projectState(state, P2, ON_S1).log, []);
  });

  test("another player's answer sends a player nothing", () => {
    const state = rollRoom();
    const before = projectEntity(keys.roll("r1"), state, P1, ON_S1);
    const answered = applyOp(state, { t: "roll.answer", rollId: "r1", target: { characterId: "vex" }, total: 3 }, P2, env(1));
    assert.ok(answered.ok);
    assert.deepEqual(projectEntity(keys.roll("r1"), answered.state, P1, ON_S1), before);
  });

  test("a display, a player asked about nothing, and anyone behind a blackout get no request", () => {
    const state = rollRoom();
    state.members.p3 = member("p3");
    assert.deepEqual(projectState(state, DISPLAY, ON_S1).rolls, {});
    assert.deepEqual(projectState(state, { memberId: "p3", role: "player" }, ON_S1).rolls, {});
    state.meta.view = { follow: false, blackout: true };
    assert.deepEqual(projectState(state, P1, ON_S1).rolls, {});
  });

  test("a target's creature changing hands re-projects the request through the global change", () => {
    const state = rollRoom();
    const moved = applyOp(state, { t: "character.update", characterId: "thorn", patch: { ownerIds: ["p2"] } }, DM, env(1));
    assert.ok(moved.ok && moved.global);
    assert.equal(projectEntity(keys.roll("r1"), moved.state, P1, ON_S1), null);
    assert.equal((projectEntity(keys.roll("r1"), moved.state, P2, ON_S1) as RollRequest).targets.length, 2);
  });

  test("a roll line reaches the DM and the creature's players now, under the same two switches", () => {
    const state = rollRoom();
    const test_ = { kind: "save" as const, choices: [{ ability: "dex" as const }] };
    state.log = [{ id: "0:0", at: "x", kind: "event", data: { type: "roll", test: test_, characterId: "thorn", total: 12, result: "fail", dc: 15, resultShown: true } }];
    assert.deepEqual(projectState(state, DM, ON_S1).log[0]!.data, state.log[0]!.data);
    assert.deepEqual(projectState(state, P1, ON_S1).log[0]!.data, { type: "roll", test: test_, characterId: "thorn", total: 12, resultShown: true, result: "fail" });
    assert.deepEqual(projectState(state, P2, ON_S1).log, []);
    assert.deepEqual(projectState(state, DISPLAY, ON_S1).log, []);
    state.log[0]!.data = { type: "roll", test: test_, characterId: "thorn", total: 12, result: "fail", dc: 15, dcShown: true };
    assert.deepEqual(projectState(state, P1, ON_S1).log[0]!.data, { type: "roll", test: test_, characterId: "thorn", total: 12, dc: 15, dcShown: true });
  });

  test("with pass or fail hidden a DM's mark adds no line for the player, while the DM keeps it and the stored rows stay whole (LP5-ROLLS-4)", () => {
    const asked = (request: Partial<RollRequest>) => {
      const state = rollRoom({ resultShown: false, ...request });
      state.rolls.r1!.targets = [{ characterId: "thorn" }, { characterId: "vex" }];
      return state;
    };
    const play = (start: RoomState, ops: [Parameters<typeof applyOp>[1], Viewer][]) =>
      ops.reduce((state, [op, who], i) => {
        const r = applyOp(state, op, who, env(i + 1));
        assert.ok(r.ok, op.t);
        return r.state;
      }, start);
    const answer = (total: number) => ({ t: "roll.answer" as const, rollId: "r1", target: { characterId: "thorn" }, total });
    const mark = (result: "pass" | "fail", characterId = "thorn") => ({ t: "roll.answer" as const, rollId: "r1", target: { characterId }, result });
    const failNoRoll = { t: "roll.answer" as const, rollId: "r1", target: { characterId: "thorn" }, result: "fail" as const };
    const lines = (state: RoomState, who: Viewer) => projectState(state, who, ON_S1).log.map((e) => e.data);

    // A hidden DC: the player's 12 fails, the DM overrules it to a pass, and marks Vex, who never answered.
    const ops: [Parameters<typeof applyOp>[1], Viewer][] = [[answer(12), P1], [mark("pass"), DM], [mark("fail", "vex"), DM]];
    const hiddenDc = play(asked({ dcShown: false }), ops);
    assert.deepEqual(
      eventLines(hiddenDc.log).map((e) => e.data),
      [
        { type: "roll", test: hiddenDc.rolls.r1!.test, characterId: "thorn", total: 12, result: "fail", dc: 15 },
        { type: "roll", test: hiddenDc.rolls.r1!.test, characterId: "thorn", total: 12, result: "pass", dc: 15 },
        { type: "roll", test: hiddenDc.rolls.r1!.test, characterId: "vex", result: "fail", dc: 15 },
      ],
      "the stored rows keep every mark",
    );
    assert.deepEqual(play(asked({ dcShown: false }), ops).log, hiddenDc.log, "and replay writes them the same");
    assert.equal(lines(hiddenDc, DM).length, 3);
    assert.deepEqual(lines(hiddenDc, P1), [{ type: "roll", test: hiddenDc.rolls.r1!.test, characterId: "thorn", total: 12 }], "Thorn's player reads their own answer once");
    assert.deepEqual(lines(hiddenDc, P2), [], "Vex's player learns nothing of the DM's mark");
    for (const e of hiddenDc.log) {
      const one = projectEntity(keys.log(e.id), hiddenDc, P1, ON_S1);
      assert.deepEqual(one, projectState(hiddenDc, P1, ON_S1).log.find((x) => x.id === e.id) ?? null, `entry ${e.id} agrees with the whole projection`);
    }

    // No DC: a player's total carries no result, so a mark beside it is the DM's. A save failed without rolling and overruled is too.
    const noDc = play(asked({ dc: undefined }), [[answer(11), P1], [mark("pass"), DM]]);
    assert.deepEqual(lines(noDc, P1), [{ type: "roll", test: noDc.rolls.r1!.test, characterId: "thorn", total: 11 }]);
    const overruled = play(asked({ dc: undefined }), [[failNoRoll, P1], [mark("pass"), DM]]);
    assert.deepEqual(lines(overruled, P1), [{ type: "roll", test: overruled.rolls.r1!.test, characterId: "thorn", noRoll: true }]);

    // With pass or fail shown every mark reaches the creature's player, as before.
    const shown = play(asked({ dcShown: false, resultShown: true }), ops);
    assert.equal(lines(shown, P1).length, 2);
    assert.equal(lines(shown, P2).length, 1);
  });
});

describe("tokens", () => {
  test("monsterId never reaches a player, the owner included", () => {
    const state = room();
    state.tokens.wolf = token("wolf", { ownerIds: ["p1"], actor: { inline: actor({ monsterId: "monster-77", srdId: "wolf" }) } });
    state.characters.c1 = character("c1", { ownerIds: ["p1"], actor: actor({ monsterId: "monster-77" }) });
    const own = projectState(state, P1, ON_S1);
    assert.equal(JSON.stringify(own).includes("monster-77"), false);
    // The SRD id stays, so an owner who plays a Wild Shape reads the SRD block.
    assert.equal((own.tokens.wolf!.actor as { inline: { srdId?: string } }).inline.srdId, "wolf");
    assert.equal((projectState(state, DM, ON_S1).tokens.wolf!.actor as { inline: { monsterId?: string } }).inline.monsterId, "monster-77");
  });

  test("party marks a token a member of kind player owns, directly or through its character, on every player-class projection", () => {
    const state = room();
    state.members.dm2 = member("dm2", "dm");
    state.characters.c1 = character("c1", { ownerIds: ["p1"] });
    state.tokens.pc = token("pc", { kind: "pc", actor: { ref: "c1" } });
    state.tokens.familiar = token("familiar", { ownerIds: ["p2"] });
    state.tokens.dmPet = token("dmPet", { ownerIds: ["dm2"] });
    state.tokens.ally = token("ally", { partyVision: true });
    state.tokens.goblin = token("goblin");
    const party = (viewer: Viewer) =>
      Object.values(projectState(state, viewer, ON_S1).tokens)
        .filter((t: ProjectedToken) => t.party)
        .map((t) => t.id)
        .sort();
    assert.deepEqual(party(DISPLAY), ["familiar", "pc"]);
    assert.deepEqual(party(P1), ["familiar", "pc"]);
    assert.deepEqual(party(DM), []);
  });

  test("a shipped icon names no asset, so it adds nothing to the visible set", () => {
    const state = room();
    state.tokens.icon = token("icon", { image: { icon: "lorc/wolf-head", color: "#336699" }, altImages: [imageRef("alt")], ownerIds: ["p1"] });
    state.tokens.upload = token("upload", { image: imageRef("face") });
    assert.deepEqual([...visibleAssetIds(state, P1, ON_S1)].sort(), ["alt", "face"]);
    assert.deepEqual([...visibleAssetIds(state, P2, ON_S1)].sort(), ["face"]);
    assert.ok(projectState(state, P2, ON_S1).tokens.icon?.image);
  });
});
