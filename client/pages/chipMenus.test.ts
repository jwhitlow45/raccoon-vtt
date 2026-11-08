import "../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { ReactElement } from "react";
import type { Handout, HandoutDoc, Member, Scene } from "#shared/model.ts";
import type { ClientOp, EphEvent } from "#shared/protocol.ts";
import type { Playlist, Sound } from "#shared/sound.ts";
import { scene as sceneOf } from "#shared/testutil.ts";
import type { OnAnswer, OpRefusal } from "../state/types.ts";
import type { RecentHandout, RecentShow } from "../features/handouts/recent.ts";
import type { MoveRoom } from "../features/scenes/movePlayers.ts";
import { CHIP_WORDS } from "./chipWords.ts";
import {
  anywayId,
  asDrawn,
  cancelId,
  dmMenuSections,
  itemsOf,
  moveWords,
  SCENE_GONE,
  XCARD_PREVIEW,
  youMenuSections,
  type ChipEnv,
  type ChipItem,
  type ChipOpen,
  type ChipSection,
  type DmMenuView,
} from "./chipMenus.ts";

/*
 * The top bar's menus as data (docs/design/design-v1-qol.md 8): what
 * each holds for a view, and what each item's run sends, through a fake
 * room that keeps every op, event, toast and opening.
 */

const at = (n: number) => new Date(Date.UTC(2026, 10, 6, 12, n)).toISOString();
const member = (id: string, name: string, kind: Member["kind"] = "player"): Member => ({ id, rev: 0, name, color: "#4cc9f0", kind, createdAt: at(0) });
const members: Record<string, Member | undefined> = { dm: member("dm", "Dee", "dm"), pat: member("pat", "Pat"), ana: member("ana", "Ana") };
const hall: Scene = sceneOf("hall", { name: "Citadel gate", fogEnabled: true });
const crypt: Scene = sceneOf("crypt", { name: "Crypt of Belak", fogEnabled: true, phases: [{ id: "day", name: "Day" } as never, { id: "night", name: "Night" } as never], phaseId: "night" });
// Fog off: moving the players here warns (vision/moveWarning.ts).
const open: Scene = sceneOf("open", { name: "Open field" });
const doc: HandoutDoc = { id: "letter", rev: 0, title: "Strange letter", pages: [{ assetId: "p1", width: 10, height: 10 }, { assetId: "p2", width: 10, height: 10 }], createdAt: at(0) };
const showing: Handout = { id: "h1", rev: 0, assetId: "map", title: "The old map", to: "all", shownAt: at(5) };

function viewOf(over: Partial<DmMenuView> = {}): DmMenuView {
  return {
    blackout: false,
    follow: false,
    viewing: hall,
    playerScene: { id: hall.id, name: hall.name },
    focusHere: true,
    handouts: {},
    handoutDocs: { letter: doc },
    members,
    recent: [],
    images: null,
    time: null,
    nowPlaying: false,
    movingTo: null,
    revealing: null,
    outShown: false,
    ...over,
  };
}

type Sent = { op: ClientOp; group?: string; quiet?: boolean; onAnswer?: OnAnswer };

const sounds: Record<string, Sound> = { m1: { id: "m1", rev: 0, name: "Harbor", assetId: "file-m1", ms: 60_000, use: "music" } };
const playlists: Record<string, Playlist> = { night: { id: "night", rev: 0, name: "Night", sounds: ["m1"], repeat: "all", fade: 5 } };
const moveRoom: MoveRoom = { viewingId: "crypt", sight: undefined, serverSound: "on", playlists, sounds, confirmed: () => null };

/** A room that keeps what each run sent, said and opened. `confirmed` is the server's room a lost answer reads. */
function fakeEnv(focusScene: string | null = "hall", confirmed: MoveRoom["confirmed"] = moveRoom.confirmed) {
  const sent: Sent[] = [];
  const eph: EphEvent[] = [];
  const toasts: string[] = [];
  const opened: ChipOpen[] = [];
  const remembered: RecentShow[] = [];
  let ids = 0;
  const env: ChipEnv = {
    actions: {
      newId: () => `id${++ids}`,
      dispatch(op, opts) {
        sent.push({ op: op as ClientOp, ...opts });
        return sent.length;
      },
      sendEph: (e) => void eph.push(e),
    },
    notify: (text, tone) => void toasts.push(`${tone}: ${text}`),
    moveRoom: { ...moveRoom, confirmed },
    open: (what) => void opened.push(what),
    focus: () => (focusScene ? { sceneId: focusScene, x: 3, y: 4, zoom: 2 } : null),
    remember: (show) => void remembered.push(show),
  };
  return { env, sent, eph, toasts, opened, remembered };
}

const titles = (sections: readonly ChipSection[]) => sections.map((s) => [s.heading ?? `(${s.key})`, s.items.map((i) => i.title)]);
const item = (sections: readonly ChipSection[], id: string): ChipItem => {
  const found = itemsOf(sections).find((i) => i.id === id);
  assert.ok(found, `no item ${id}`);
  return found;
};

describe("the DM menu (design-v1-qol.md 4, C1)", () => {
  test("at rest: Handouts, Players' screens, Preview, and no Map phase or Time where nothing holds them", () => {
    assert.deepEqual(titles(dmMenuSections(viewOf())), [
      ["Handouts", ["Show a handout…"]],
      ["Players' screens", ["Black out players' screens", "Follow me", "Bring everyone here"]],
      ["Preview", ["View as Ana", "View as Pat"]],
    ]);
  });

  test("Map phase on a scene with two phases, the one showing checked, and the other switches it", () => {
    const view = viewOf({ viewing: crypt, playerScene: { id: crypt.id, name: crypt.name } });
    const sections = dmMenuSections(view);
    const phase = sections.find((s) => s.key === "phase");
    assert.equal(phase?.heading, "Map phase");
    assert.deepEqual(phase?.items.map((i) => [i.title, i.role, i.checked]), [["Day", "radio", false], ["Night", "radio", true]]);
    const room = fakeEnv();
    item(sections, "phase:night").run(room.env);
    assert.equal(room.sent.length, 0, "the phase showing sends nothing");
    item(sections, "phase:day").run(room.env);
    assert.deepEqual(room.sent.map((s) => s.op), [{ t: "scene.setPhase", sceneId: "crypt", phaseId: "day" }]);
  });

  test("Time and Now playing only once their chips gave way from the bar", () => {
    const sections = dmMenuSections(viewOf({ time: { text: "Day 4, 8:00 PM", name: "Time: Day 4, 8:00 PM, Night" }, nowPlaying: true }));
    assert.deepEqual(titles(sections).slice(-2), [["Time", ["Day 4, 8:00 PM"]], ["Now playing", ["Now playing"]]]);
    const room = fakeEnv();
    assert.deepEqual(item(sections, "time").run(room.env), { t: "opened" });
    item(sections, "nowPlaying").run(room.env);
    assert.deepEqual(room.opened, [{ t: "time" }, { t: "nowPlaying" }]);
  });

  test("Black out, Follow me and Bring everyone here send what the DM panel sends", () => {
    const sections = dmMenuSections(viewOf({ follow: true }));
    const room = fakeEnv();
    assert.equal(item(sections, "follow").checked, true);
    for (const id of ["blackout", "follow", "bringEveryone"]) assert.deepEqual(item(sections, id).run(room.env), { t: "done" });
    assert.deepEqual(room.sent.map((s) => s.op), [{ t: "view.blackout", blackout: true }, { t: "view.follow", follow: false }]);
    assert.deepEqual(room.eph, [{ k: "focus", x: 3, y: 4, zoom: 2 }]);
    assert.deepEqual(room.toasts, [`info: ${CHIP_WORDS.bringEveryoneDone}`]);
  });

  test("Bring everyone here is off while the camera is not on the scene, and sends nothing then", () => {
    const sections = dmMenuSections(viewOf({ focusHere: false }));
    assert.equal(item(sections, "bringEveryone").disabled, true);
    const room = fakeEnv("crypt");
    item(sections, "bringEveryone").run(room.env);
    assert.deepEqual([room.eph, room.toasts], [[], []]);
  });

  test("Preview views as each player by name, and the DM is none", () => {
    const sections = dmMenuSections(viewOf());
    const room = fakeEnv();
    assert.deepEqual(item(sections, "viewAs:pat").run(room.env), { t: "opened" });
    assert.deepEqual(room.opened, [{ t: "viewAs", memberId: "pat", name: "Pat" }]);
    assert.ok(!itemsOf(sections).some((i) => i.id === "viewAs:dm"));
  });

  test("on another scene: Move players here on that scene, and Follow me still on with its limit said", () => {
    const sections = dmMenuSections(viewOf({ viewing: crypt }));
    const screens = sections.find((s) => s.key === "screens")!;
    assert.deepEqual(screens.items.map((i) => [i.title, i.note]), [
      ["Black out players' screens", undefined],
      ["Follow me", "only on Citadel gate"],
      ["Move players here", "on Crypt of Belak"],
    ]);
    const follow = item(sections, "follow");
    assert.equal(follow.disabled, undefined);
    assert.equal(follow.description, "Players' maps follow yours only while you look at their scene, Citadel gate.");
  });
});

describe("the blackout's items (design-v1-qol.md 4, C2)", () => {
  test("lead the DM menu above a line, End the blackout first, with no Black out item", () => {
    const sections = dmMenuSections(viewOf({ blackout: true }));
    assert.deepEqual(titles(sections)[0], ["(blackout)", ["End the blackout"]]);
    assert.equal(sections[1]?.separator, true);
    assert.ok(!itemsOf(sections).some((i) => i.id === "blackout"));
    const room = fakeEnv();
    item(sections, "endBlackout").run(room.env);
    assert.deepEqual(room.sent.map((s) => s.op), [{ t: "view.blackout", blackout: false }]);
  });

  test("on another scene, Show players <scene> moves the players and lifts the blackout guarded by that scene, as one undo group and quiet", async () => {
    const sections = dmMenuSections(viewOf({ blackout: true, viewing: crypt }));
    assert.deepEqual(titles(sections)[0], ["(blackout)", ["End the blackout", "Show players Crypt of Belak"]]);
    const room = fakeEnv();
    const result = item(sections, "showPlayers").run(room.env);
    assert.equal(result.t, "wait");
    assert.deepEqual(room.sent.map((s) => s.op), [
      { t: "room.setPlayerScene", sceneId: "crypt" },
      { t: "view.blackout", blackout: false, whilePlayersOn: "crypt" },
    ]);
    assert.ok(room.sent.every((s) => s.group === "id1" && s.quiet === true));
    room.sent[0]!.onAnswer!("taken");
    room.sent[1]!.onAnswer!("taken");
    if (result.t === "wait") assert.deepEqual(await result.answer, { t: "taken" });
  });

  test("a scene with sound sends its sound once, outside the undo group, with onMove", () => {
    const withSound: Scene = { ...crypt, sound: { music: { playlistId: "night", repeat: "all", fade: 5 }, loops: [] } };
    const room = fakeEnv();
    item(dmMenuSections(viewOf({ blackout: true, viewing: withSound })), "showPlayers").run(room.env);
    const sound = room.sent.filter((s) => s.op.t === "sound.scene");
    assert.equal(sound.length, 1);
    assert.deepEqual(sound[0], { op: { t: "sound.scene", sceneId: "crypt", run: "id2", order: ["m1"], onMove: true } });
  });

  test("while the reveal is out the items stay, busy, though the view already shows it done, and say Moving players… past the delay", () => {
    const out = viewOf({ blackout: false, viewing: crypt, playerScene: { id: crypt.id, name: crypt.name }, movingTo: "crypt", revealing: "crypt" });
    const reveal = item(dmMenuSections(out), "showPlayers");
    assert.equal(reveal.busy, true);
    assert.equal(reveal.under, undefined, "nothing said before the delay");
    assert.deepEqual(item(dmMenuSections({ ...out, outShown: true }), "showPlayers").under, { text: "Moving players…", tone: "busy" });
    // The move answered, the lift not yet: still busy, still there.
    assert.equal(item(dmMenuSections({ ...out, movingTo: null }), "showPlayers").busy, true);
    assert.ok(!itemsOf(dmMenuSections(out)).some((i) => i.id === "blackout"), "no Black out while players still see black");
  });
});

describe("a move from the menu (design-v1-qol.md 4, C2's move)", () => {
  test("a warned move asks with nothing sent, arms its anyway item and Cancel, and the anyway item moves", () => {
    const view = viewOf({ viewing: open, blackout: true });
    const room = fakeEnv();
    const asked = item(dmMenuSections(view), "showPlayers").run(room.env);
    assert.equal(asked.t, "ask");
    assert.equal(room.sent.length, 0);
    if (asked.t !== "ask") return;
    assert.equal(asked.anyway, CHIP_WORDS.showAnyway);
    assert.match(asked.warning, /^Fog is off here/);
    const drawn = asDrawn(dmMenuSections(view), { ask: { id: "showPlayers", warning: asked.warning, anyway: asked.anyway }, said: new Map() });
    assert.deepEqual(titles(drawn)[0], ["(blackout)", ["End the blackout", "Show players anyway", "Cancel"]]);
    const anyway = item(drawn, anywayId("showPlayers"));
    assert.deepEqual([anyway.description, anyway.under], [asked.warning, { text: asked.warning, tone: "warning" }]);
    assert.equal(item(drawn, cancelId("showPlayers")).kind, "cancel");
    assert.equal(anyway.run(room.env).t, "wait");
    assert.deepEqual(room.sent.map((s) => s.op.t), ["room.setPlayerScene", "view.blackout"]);
  });

  test("Move players here asks with its own anyway words", () => {
    const asked = item(dmMenuSections(viewOf({ viewing: open })), "movePlayers").run(fakeEnv().env);
    assert.equal(asked.t === "ask" && asked.anyway, CHIP_WORDS.moveAnyway);
  });

  test("a refusal reads as the item's words: the move's reason, a deleted scene, or the lift overtaken", () => {
    const refused = (code: OpRefusal["code"], message: string): OpRefusal => ({ code, message, text: `Not saved. ${message}` });
    assert.deepEqual(moveWords({ t: "refused", step: "move", refusal: refused("invalid", "The room is too full for the party to explore that scene.") }), {
      t: "refused",
      words: "Players not moved. The room is too full for the party to explore that scene.",
    });
    assert.deepEqual(moveWords({ t: "refused", step: "move", refusal: refused("gone", "scene is not here") }), { t: "refused", words: `Players not moved. ${SCENE_GONE}` });
    assert.deepEqual(moveWords({ t: "refused", step: "lift", refusal: refused("invalid", "the players are on another scene now") }), { t: "refused", words: CHIP_WORDS.liftRefused });
    assert.deepEqual(moveWords({ t: "unknown" }), { t: "taken" });
    assert.deepEqual(moveWords({ t: "taken" }), { t: "taken" });
  });

  test("a move whose answer was lost, with the players elsewhere in its snapshot, reads as refused: the scene deleted, or where they are", () => {
    assert.deepEqual(moveWords({ t: "notMoved", sceneGone: true, playersOn: "Battle mat" }), { t: "refused", words: `Players not moved. ${SCENE_GONE}` });
    assert.deepEqual(moveWords({ t: "notMoved", sceneGone: false, playersOn: "Battle mat" }), { t: "refused", words: "Players not moved. They are on Battle mat." });
    assert.deepEqual(moveWords({ t: "notMoved", sceneGone: false, playersOn: null }), { t: "refused", words: "Players not moved. That could not be done." });
  });

  test("Show players and Move players here, settled by a snapshot that lost the answer, say the players were not moved", async () => {
    // A co-DM deleted Crypt meanwhile: the snapshot has the players on the hall and no Crypt.
    const gone = () => ({ meta: { playerSceneId: "hall" }, scenes: { hall: { name: "Hall" } } });
    for (const [id, view] of [
      ["showPlayers", viewOf({ blackout: true, viewing: crypt })],
      ["movePlayers", viewOf({ viewing: crypt })],
    ] as const) {
      const room = fakeEnv("hall", gone);
      const result = item(dmMenuSections(view), id).run(room.env);
      if (result.t !== "wait") return assert.fail(`${id} waits`);
      for (const s of room.sent) s.onAnswer?.("unknown", undefined, "snapshot");
      assert.deepEqual(await result.answer, { t: "refused", words: `Players not moved. ${SCENE_GONE}` }, id);
    }
  });

  test("a refusal said in place shows under the item and as its description, and a busy item says only that it waits", () => {
    const view = viewOf({ viewing: crypt });
    const said = new Map([["movePlayers", "Players not moved. That scene was deleted."]]);
    const drawn = item(asDrawn(dmMenuSections(view), { ask: null, said }), "movePlayers");
    assert.deepEqual([drawn.description, drawn.under], [said.get("movePlayers"), { text: said.get("movePlayers"), tone: "danger" }]);
    const busy = item(asDrawn(dmMenuSections({ ...view, movingTo: "crypt" }), { ask: { id: "movePlayers", warning: "w", anyway: "a" }, said }), "movePlayers");
    assert.equal(busy.busy, true);
    assert.equal(busy.under, undefined);
  });

  test("a move that is out keeps Move players here, busy, while the view already shows the players there", () => {
    const view = viewOf({ viewing: crypt, playerScene: { id: crypt.id, name: crypt.name }, movingTo: "crypt", outShown: true });
    const moving = item(dmMenuSections(view), "movePlayers");
    assert.equal(moving.busy, true);
    assert.equal(moving.under?.text, "Moving players…");
    assert.ok(!itemsOf(dmMenuSections(view)).some((i) => i.id === "bringEveryone"));
    assert.ok(itemsOf(dmMenuSections({ ...view, movingTo: null })).some((i) => i.id === "bringEveryone"), "once answered, Bring everyone here");
  });
});

describe("Handouts in the DM menu", () => {
  const recent = (over: Partial<RecentHandout> & Pick<RecentHandout, "title">): RecentHandout => ({ kind: "image", assetId: "img", to: "all", at: 1, ...over }) as RecentHandout;

  test("Hide each showing, then up to three recent handouts not showing, each naming whom it goes to, then Show a handout…", () => {
    const view = viewOf({
      handouts: { h1: showing },
      recent: [
        recent({ title: "The old map", assetId: "map", at: 9 }),
        recent({ title: "Belak's letter", assetId: "b", to: ["pat"], at: 8 }),
        recent({ title: "Twin portraits", assetId: "t", to: ["pat", "ana"], at: 7 }),
        { kind: "doc", docId: "letter", title: "Strange letter", to: "all", at: 6 },
        recent({ title: "Fourth", assetId: "f", at: 5 }),
      ],
    });
    const handouts = dmMenuSections(view)[0]!;
    assert.deepEqual(
      handouts.items.map((i) => [i.title, i.note ?? null, i.description ?? null]),
      [
        ["Hide The old map", "Showing", null],
        ["Show Belak's letter", "to Pat", "Shows it to Pat again."],
        ["Show Twin portraits", "to Pat and Ana", "Shows it to Pat and Ana again."],
        ["Show Strange letter", "Document · to everyone", "Shows it to everyone again."],
        ["Show a handout…", null, null],
      ],
    );
    const room = fakeEnv();
    item([handouts], "hide:h1").run(room.env);
    assert.deepEqual(room.sent.map((s) => s.op), [{ t: "handout.close", handoutId: "h1" }]);
    assert.deepEqual(item([handouts], "showHandout").run(room.env), { t: "opened" });
    assert.deepEqual(room.opened, [{ t: "handout" }]);
  });

  test("a recent handout for one player who left, or whose document is gone, is not offered, and one for two keeps who stayed", () => {
    const view = viewOf({
      members: { dm: members.dm, ana: members.ana },
      handoutDocs: {},
      recent: [recent({ title: "Belak's letter", assetId: "b", to: ["pat"], at: 8 }), recent({ title: "Twins", assetId: "t", to: ["pat", "ana"], at: 7 }), { kind: "doc", docId: "letter", title: "Strange letter", to: "all", at: 6 }],
    });
    const items = dmMenuSections(view)[0]!.items;
    assert.deepEqual(items.map((i) => [i.title, i.note ?? null]), [["Show Twins", "to Ana"], ["Show a handout…", null]]);
  });

  test("an image the library no longer lists is not offered, once the library has been listed", () => {
    const view = viewOf({ recent: [recent({ title: "Gone", assetId: "gone" })], images: new Set(["other"]) });
    assert.deepEqual(dmMenuSections(view)[0]!.items.map((i) => i.title), ["Show a handout…"]);
  });

  test("Show <title> shows it at once to the same audience, quiet, remembered once taken, and a refusal is a toast in the Recent list's words (LP32-A-HAND-1)", () => {
    const view = viewOf({ recent: [recent({ title: "Belak's letter", assetId: "b", to: ["pat"], at: 8 }), { kind: "doc", docId: "letter", title: "Strange letter", to: "all", at: 6 }] });
    const room = fakeEnv();
    assert.deepEqual(item(dmMenuSections(view), "recent:image:b").run(room.env), { t: "done" });
    const op = room.sent[0]!.op as Extract<ClientOp, { t: "handout.show" }>;
    assert.equal(room.sent[0]!.quiet, true);
    assert.deepEqual([op.handout.title, op.handout.to, "assetId" in op.handout && op.handout.assetId], ["Belak's letter", ["pat"], "b"]);
    room.sent[0]!.onAnswer!("taken");
    assert.deepEqual(room.remembered, [{ kind: "image", assetId: "b", title: "Belak's letter", to: ["pat"] }]);
    item(dmMenuSections(view), "recent:doc:letter").run(room.env);
    const docOp = room.sent[1]!.op as Extract<ClientOp, { t: "handout.show" }>;
    assert.deepEqual("pages" in docOp.handout && docOp.handout.pages.map((p) => p.assetId), ["p1", "p2"], "a document sends its pages as they are now");
    room.sent[1]!.onAnswer!("refused", { code: "quota", message: "too many handouts", text: "Not saved. Too many handouts." });
    item(dmMenuSections(view), "recent:image:b").run(room.env);
    room.sent[2]!.onAnswer!("refused", { code: "gone", message: "that is not here", text: "Not saved. That is not here." });
    assert.deepEqual(room.toasts, ["error: That handout could not be shown. Too many handouts.", "error: That handout could not be shown."]);
  });
});

describe("a player's You menu (design-v1-qol.md 4, C7)", () => {
  const characters = {
    thorn: { id: "thorn", name: "Thorn", ownerIds: ["pat"] },
    wren: { id: "wren", name: "Wren", ownerIds: ["ana"] },
    bree: { id: "bree", name: "Bree", ownerIds: ["pat", "ana"] },
  };

  test("headed with their name: the sheet of each character they own, never another's, then X-card…", () => {
    const sections = youMenuSections({ memberId: "pat", member: members.pat, characters, preview: false });
    assert.deepEqual(titles(sections), [["Pat", ["Bree's sheet", "Thorn's sheet", "X-card…"]]]);
    const room = fakeEnv();
    item(sections, "sheet:thorn").run(room.env);
    item(sections, "xcard").run(room.env);
    assert.deepEqual(room.opened, [{ t: "sheet", characterId: "thorn" }, { t: "xcard" }]);
  });

  test("a character whose owners the projection leaves out is not theirs, and draws nothing amiss", () => {
    const projected = { thorn: characters.thorn, wren: { id: "wren", name: "Wren" } };
    assert.deepEqual(titles(youMenuSections({ memberId: "pat", member: members.pat, characters: projected, preview: false })), [["Pat", ["Thorn's sheet", "X-card…"]]]);
  });

  test("viewing as a player, the X-card is off and says why", () => {
    const xcard = item(youMenuSections({ memberId: "ana", member: members.ana, characters, preview: true }), "xcard");
    assert.deepEqual([xcard.disabled, xcard.description], [true, XCARD_PREVIEW]);
  });

  test("nothing before the member is in the view", () => {
    assert.deepEqual(youMenuSections({ memberId: "pat", member: undefined, characters, preview: false }), []);
  });
});

/*
 * The chips' look and names (design-v1-qol.md 4, The chips' look and Words),
 * and how a chip menu's item reaches the shared Menu: a line under its words
 * is its description, and its name stays its title. Drawn to markup.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { ChipButton, menuItemOf } = await import("./ChipMenus.tsx");
const { theme } = await import("../lib/theme.ts");

const anchor = { ref() {}, "aria-haspopup": "menu", "aria-expanded": false, "aria-controls": undefined, onClick() {}, onKeyDown() {} } as const;

function chip(props: Record<string, unknown>, children: string): string {
  return renderToStaticMarkup(createElement(ChipButton, { anchor, outline: theme.color.accent, ...props } as never, children));
}

describe("a chip that opens a menu", () => {
  test("is a 44 px tall menu button named for its options, its pill 28 px with the caret after its words", () => {
    const html = chip({ label: "DM options", data: { "data-chip": "dm" } }, "DM");
    assert.match(html, /^<button type="button" data-chip="dm" aria-haspopup="menu" aria-expanded="false"/);
    assert.match(html, /aria-label="DM options"/);
    assert.match(html, new RegExp(`height:${theme.touch}px`));
    assert.match(html, /height:28px/);
    assert.match(html, /DM<svg/, "the caret follows the words inside the pill");
  });

  test("the crossed eye keeps the blackout in its name, and only a chip whose words are cut has a tooltip", () => {
    const eye = chip({ label: "DM options. Players see black", tip: "DM options. Players see black", round: true }, "");
    assert.match(eye, /aria-label="DM options\. Players see black"/);
    assert.match(eye, /padding:0 1px 0 6px/, "the round forms' tight caret");
    const full = chip({ label: "Players see black", color: theme.color.dangerText }, "Players see black");
    assert.match(full, />Players see black<svg/);
    assert.doesNotMatch(full, /aria-describedby/);
    const dot = chip({ label: "DM options", tip: "You are the DM", round: true }, "");
    assert.match(dot, /aria-describedby="[^"]+"/, "the dot's tooltip adds words, so a reader hears them");
  });

  test("the bar's last step slims the crossed eye to the dot's width: the eye alone, centered, still a menu button named for the blackout", () => {
    // The dot's form: 6 px, the 8 px dot, 1 px, the 14 px caret, 1 px and the 1 px borders make 32 (topBarFit.ts eyeSlim).
    const slim = chip({ label: "DM options. Players see black", tip: "DM options. Players see black", round: true, slim: true }, "");
    assert.match(slim, /aria-haspopup="menu"/);
    assert.match(slim, /aria-label="DM options\. Players see black"/);
    assert.match(slim, /padding:0 7px/, "16 px for the eye, 7 px each side and the borders: 32 px, the dot's width");
    assert.doesNotMatch(slim, /<svg/, "no caret");
    assert.match(chip({ label: "DM options", round: true }, ""), /<svg/, "the round forms keep theirs otherwise");
  });
});

describe("a chip menu's item in the shared Menu", () => {
  const base: ChipItem = { id: "showPlayers", kind: "showPlayers", title: "Show players Crypt", role: "action", description: "Moves the players here and ends the blackout in one step.", run: () => ({ t: "done" }) };

  test("a plain item keeps its words, note and description, and only a switch or a choice holds a checked state", () => {
    const item = menuItemOf({ ...base, note: "on Crypt" });
    assert.deepEqual([item.title, item.kind, item.note, item.description, item.label, item.content], ["Show players Crypt", "action", "on Crypt", base.description, undefined, undefined]);
    assert.equal(item.checked, undefined);
    assert.equal(menuItemOf({ ...base, role: "checkbox", checked: false }).checked, false);
    assert.equal(menuItemOf({ ...base, role: "radio", checked: true }).checked, true);
  });

  test("a warning or a refusal under its words is its description, named by its title alone", () => {
    const warned = menuItemOf({ ...base, title: "Show players anyway", description: "Fog is off here.", under: { text: "Fog is off here.", tone: "warning" } });
    assert.deepEqual([warned.label, warned.description], ["Show players anyway", "Fog is off here."]);
    const html = renderToStaticMarkup(warned.content as ReactElement);
    assert.match(html, /<span>Show players anyway<\/span><span style="[^"]*">Fog is off here\.<\/span>/);
    assert.ok(html.includes(`color:${theme.color.warning}`));
    const refused = menuItemOf({ ...base, under: { text: "Players not moved. That scene was deleted.", tone: "danger" } });
    assert.ok(renderToStaticMarkup(refused.content as ReactElement).includes(`color:${theme.color.dangerText}`));
  });

  test("a busy item picks nothing and says it waits in its own words", () => {
    const busy = menuItemOf({ ...base, busy: true, under: { text: "Moving players…", tone: "busy" } });
    assert.deepEqual([busy.busy, busy.label], [true, undefined]);
    assert.match(renderToStaticMarkup(busy.content as ReactElement), /Moving players…/);
  });
});
