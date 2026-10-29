import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { actor, character, customMonster, DM, room, token } from "#shared/testutil.ts";
import { clientOpSchema, type ClientOp } from "#shared/protocol.ts";
import { projectState } from "#shared/project.ts";
import { applyOp } from "#shared/reducer.ts";
import type { RoomState } from "#shared/model.ts";
import { hpTargets, sendHpEntry } from "./groupHp.ts";
import { parseHpInput } from "./hpInput.ts";
import { hpDraftKey, hpDraftSlot } from "./hpDraft.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { GroupHpEntry } = await import("./GroupHpEntry.tsx");
const P1 = { memberId: "p1", role: "player" as const };

function fixture() {
  const state = room({
    monsters: {
      resist: customMonster("resist", { resistances: "Cold" }),
      immune: customMonster("immune", { immunities: "Cold" }),
      vulnerable: customMonster("vulnerable", { vulnerabilities: "Cold" }),
    },
    characters: { own: character("own", { ownerIds: ["p1"] }), friend: character("friend", { ownerIds: ["p2"] }) },
    tokens: {
      resist: token("resist", { name: "Resistant", hpVisibility: "label", actor: { inline: actor({ monsterId: "resist", hp: { cur: 50, max: 50, temp: 2 } }) } }),
      immune: token("immune", { name: "Immune", hpVisibility: "label", actor: { inline: actor({ monsterId: "immune", hp: { cur: 50, max: 50, temp: 2 } }) } }),
      vulnerable: token("vulnerable", { name: "Vulnerable", hpVisibility: "label", actor: { inline: actor({ monsterId: "vulnerable", hp: { cur: 50, max: 50, temp: 2 } }) } }),
      own1: token("own1", { kind: "pc", name: "Own", ownerIds: ["p1"], actor: { ref: "own" } }),
      own2: token("own2", { kind: "pc", name: "Own again", ownerIds: ["p1"], actor: { ref: "own" } }),
      friend: token("friend", { kind: "pc", name: "Friend", ownerIds: ["p2"], actor: { ref: "friend" } }),
    },
  });
  state.meta.settings.playersApplyDamage = true;
  return state;
}

test("FL-3: group HP sends typed parts for each permitted holder and the server applies each target's defenses", () => {
  let state = fixture();
  const view = projectState(state, P1, { sceneId: "s1" }) as RoomState;
  const targets = hpTargets(Object.values(view.tokens), { ...P1, characters: view.characters, playersApplyDamage: true });
  const parsed = parseHpInput("11 cold", "damage");
  assert.ok(parsed.ok);
  const restricted = fixture();
  restricted.meta.settings.playersApplyDamage = false;
  const restrictedView = projectState(restricted, P1, { sceneId: "s1" }) as RoomState;
  const ownOnly = hpTargets(Object.values(restrictedView.tokens), { ...P1, characters: restrictedView.characters, playersApplyDamage: false });
  const ownSent: ClientOp[] = [];
  sendHpEntry({ dispatch: (op) => { ownSent.push(op); return ownSent.length; }, newId: () => "own" }, ownOnly, parsed.change, false);
  assert.deepEqual(ownSent.map((op) => op.t === "actor.hp" ? op.target : null), [{ tokenId: "own1" }]);
  const sent: { op: ClientOp; group?: string }[] = [];
  sendHpEntry({ dispatch: (op, opts) => { sent.push({ op, group: opts?.group }); return sent.length; }, newId: () => "gesture" }, targets, parsed.change, false);
  assert.equal(sent.length, 5, "three monsters and two PCs, with the shared PC counted once");
  assert.ok(sent.every(({ op, group }) => group === "gesture" && op.t === "actor.hp" && op.change.kind === "damage" && op.change.parts?.[0]?.type === "cold"));
  let seq = 1;
  for (const { op } of sent) {
    const result = applyOp(state, clientOpSchema.parse(op), P1, { seq: seq++, at: "2026-10-29T00:00:00Z" });
    assert.ok(result.ok);
    state = result.state;
  }
  const hp = (id: string) => {
    const target = state.tokens[id]!.actor;
    assert.ok("inline" in target);
    return target.inline.hp;
  };
  assert.deepEqual([hp("resist"), hp("immune"), hp("vulnerable")], [{ cur: 47, max: 50, temp: 0 }, { cur: 50, max: 50, temp: 2 }, { cur: 30, max: 50, temp: 0 }]);
  assert.equal(state.characters.own!.actor.hp.cur, fixture().characters.own!.actor.hp.cur - 11);
  assert.equal(state.characters.friend!.actor.hp.cur, fixture().characters.friend!.actor.hp.cur - 11);
  const player = projectState(state, P1, { sceneId: "s1" });
  for (const line of player.log) if (line.data?.type === "hp" && line.data.tokenId && ["resist", "immune", "vulnerable"].includes(line.data.tokenId)) {
    assert.equal(line.data.amount, undefined);
    assert.doesNotMatch(JSON.stringify(line), /Resists|Immune to|Vulnerable to/);
  }
});

test("FL-3: map and tracker group entries share typed previews without disclosing hidden defenses", () => {
  for (const place of ["bar", "panel"] as const) for (const you of [DM, P1]) {
    const view = projectState(fixture(), you, { sceneId: "s1" }) as RoomState;
    const tokens = Object.values(view.tokens);
    const targets = hpTargets(tokens, { ...you, characters: view.characters, playersApplyDamage: true });
    const scope = new RoomScope();
    scope.get(hpDraftSlot).set(hpDraftKey(place, targets), { mode: "damage", text: "11 cold", crit: false });
    const store = createStore(() => ({ view, you }));
    const el = createElement(GroupHpEntry, { tokens, place });
    const markup = renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: {} as never, ui: {} as never, children: createElement(RoomScopeProvider, { scope, children: el }) }));
    assert.match(markup, /11 Cold damage/);
    assert.match(markup, /to each of 5/);
    assert.match(markup, /inputMode="text"/);
    if (you.role === "dm") {
      assert.match(markup, /Resists Cold: 5/);
      assert.match(markup, /Immune to Cold: 0/);
      assert.match(markup, /Vulnerable to Cold: 22/);
    } else {
      assert.doesNotMatch(markup, /Resists Cold|Immune to Cold|Vulnerable to Cold/);
    }
  }
});
