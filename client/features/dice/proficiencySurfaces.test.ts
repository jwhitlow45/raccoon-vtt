import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import { character, DM, room, token } from "#shared/testutil.ts";
import { EMPTY_PC_STATS } from "#shared/rules/pcStats.ts";
import { describeEvent, type LogNames } from "#shared/logText.ts";
import type { LogEvent } from "#shared/model.ts";
import { creatureRolls, type DiceView } from "./creature.ts";
import { DICE_FOLD_KEYS, diceFoldsSlot } from "./diceFolds.ts";
import type { Toast } from "../../state/types.ts";
const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { OptionsList } = await import("./RollOptions.tsx");
const { RecentRolls } = await import("./RecentRolls.tsx");
const { ProficientToast } = await import("./ProficientToast.tsx");
const { ProficientEvent } = await import("./ProficientEvent.tsx");

function fixture(recent: boolean, toast?: Toast, event?: LogEvent, folded = false) {
  const state = room({ characters: { hero: character("hero", { name: "Hero", level: 5, stats: { ...structuredClone(EMPTY_PC_STATS), saves: ["dex"], skills: { stealth: "expert", perception: "prof" } } }) } });
  state.tokens.hero = token("hero", { kind: "pc", actor: { ref: "hero" } });
  state.log = [{ id: "1:0", at: "", kind: "event", data: { type: "dice", by: "dm1", to: "all", rolls: [{ characterId: "hero", label: "Stealth check", formula: "1d20+6", faces: [10], total: 16 }] } }];
  const names: LogNames = { characters: state.characters, tokens: state.tokens, members: state.members, handouts: state.handouts, encounter: state.encounter };
  const dice: DiceView = { you: DM, view: state, srd: { monsters: null, rolls: null } };
  const creature = { characterId: "hero" };
  const scope = new RoomScope();
  for (const key of DICE_FOLD_KEYS) scope.get(diceFoldsSlot).tap(key, true, false);
  if (folded) scope.get(diceFoldsSlot).tap("recent", false, false);
  const store = createStore(() => ({ view: state, you: DM, sceneId: "s1", roomId: "r1", connection: "open", local: { selectedIds: [], multi: false } }));
  const body = event ? createElement(ProficientEvent, { data: event, names, dm: true }) : toast ? createElement(ProficientToast, { toast }) : recent ? createElement(RecentRolls, { names, me: "dm1", open: null, again() {} }) : createElement(OptionsList, { dice, creature, tokenId: undefined, rolls: creatureRolls(dice, creature)!, name: "Hero" });
  return renderToStaticMarkup(createElement(RoomProvider, { store: store as never, actions: { dispatch: () => 1 } as never, ui: {} as never, assets: { url: () => "" } as never, children: createElement(RoomScopeProvider, { scope, children: body }) }));
}

test("fl7: dice options mark saves and skills from the actual creature", () => {
  const html = fixture(false);
  assert.match(html, /data-proficiency-marker="expert"/);
  assert.match(html, /data-proficiency-marker="prof"/);
  assert.match(html, /data-proficiency-marker="none"/);
  assert.match(html, /aria-label="Expertise"/);
  assert.equal(html.match(/data-proficiency-layout="column"/g)?.length, 24, "six saves and eighteen skills keep aligned button columns");
});

test("fl7: recent creature results retain the skill's expertise", () => {
  const html = fixture(true);
  assert.match(html, /data-proficiency-marker="expert"/);
  assert.match(html, /Stealth check/);
  assert.match(html, /16/);
  assert.doesNotMatch(html, /data-proficiency-layout="column"/, "recent results flow without a reserved column");
});

test("fl7: an untrained toast and log label reserve no inline slot", () => {
  const toast: Toast = { id: 1, tone: "info", text: "Rolled 10: Athletics check.", rolls: [{ characterId: "hero", label: "Athletics check", formula: "1d20", faces: [10], total: 10 }] };
  const event: Extract<LogEvent, { type: "roll" }> = { type: "roll", characterId: "hero", test: { kind: "check", choices: [{ ability: "str", skill: "athletics" }] }, result: "pass", total: 10 };
  for (const html of [fixture(false, toast), fixture(false, undefined, event)]) {
    assert.match(html, /data-proficiency-layout="flow"/);
    assert.match(html, /data-proficiency-level="none"/);
    assert.doesNotMatch(html, /data-proficiency-marker=/);
  }
});

test("fl7: a folded recent result keeps its proficiency and whole label", () => {
  const html = fixture(true, undefined, undefined, true);
  assert.match(html, /aria-label="Expertise"/);
  assert.match(html, /white-space:normal/);
  assert.doesNotMatch(html, /<ol/);
});

test("fl7: structured toasts mark a known creature and leave unresolved rolls as their original text", () => {
  const base: Toast = { id: 1, tone: "info", text: "Rolled 16: Stealth check.", rolls: [{ characterId: "hero", label: "Stealth check", formula: "1d20+6", faces: [10], total: 16 }] };
  const marked = fixture(false, base);
  assert.match(marked, /aria-label="Expertise"/);
  for (const rolls of [undefined, [{ ...base.rolls![0]!, characterId: "missing" }], [{ ...base.rolls![0]!, label: "Stealth damage" }]]) {
    assert.equal(fixture(false, { ...base, rolls }), base.text);
  }
  const batch = fixture(false, { ...base, text: "Rolled twice.", rolls: [...base.rolls!, { ...base.rolls![0]!, label: "Dexterity save" }] });
  assert.match(batch, /aria-label="Expertise"/);
  assert.match(batch, /aria-label="Proficient"/);
});

test("fl7: log choices keep both proficiencies until the answered choice is recorded", () => {
  const event: Extract<LogEvent, { type: "roll" }> = { type: "roll", characterId: "hero", test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }, { ability: "dex", skill: "stealth" }] }, result: "pass" };
  const both = fixture(false, undefined, event);
  assert.equal((both.match(/data-proficiency-label=/g) ?? []).length, 2);
  assert.match(both, /aria-label="Proficient"/);
  assert.match(both, /aria-label="Expertise"/);
  const chosen = fixture(false, undefined, { ...event, choice: 1, total: 18 });
  assert.equal((chosen.match(/data-proficiency-label=/g) ?? []).length, 1);
  assert.match(chosen, /aria-label="Expertise"/);
  const names = { ...room(), characters: { hero: character("hero", { name: "Hero" }) } };
  assert.equal(both.replace(/<[^>]*>/g, ""), describeEvent(event, names, true));
});
