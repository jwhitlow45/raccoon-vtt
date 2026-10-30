import "../../components/testing/register.ts";
import { withoutFrames } from "../../components/testing/proficiencyMarkup.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { ReactNode } from "react";
import type { PcStats, RoomState } from "#shared/model.ts";
import { pendingSaves } from "#shared/rules/saveEnds.ts";
import { actor, character, DM, effect, room } from "#shared/testutil.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { SaveEndsCard } = await import("./SaveEndsCard.tsx");
const { ConcentrationCard } = await import("./InitiativeStrip.tsx");
const { default: LogPanel } = await import("../../panels/LogPanel.tsx");

const STATS: PcStats = {
  abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 10 },
  saves: ["con", "wis"],
  skills: { perception: "expert" },
  adjust: {},
  defenses: {},
  rolls: [],
};

function fixture(): RoomState {
  return room({ characters: { hero: character("hero", {
    name: "Hero",
    level: 5,
    stats: STATS,
    actor: actor({ effects: [effect("fear", { key: "frightened", save: { ability: "wis", dc: 15 }, due: { id: "5:0", state: "pending" } })] }),
  }) } });
}

function render(state: RoomState, child: ReactNode): string {
  const store = createStore(() => ({ view: state, roomId: "r1", connection: "open", you: DM, sceneId: "s1", local: { selectedIds: [], multi: false } }));
  return withoutFrames(renderToStaticMarkup(createElement(RoomProvider, {
    store: store as never,
    actions: { dispatch: () => 1 } as never,
    ui: {} as never,
    children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: child }),
  })));
}

test("fl7: a save-ends card keeps its words and marks the creature's save, never its DC (FL7-R1-13)", () => {
  const state = fixture();
  const pending = pendingSaves(state)[0]!;
  const markup = render(state, createElement(SaveEndsCard, { pending, onResult() {} }));
  assert.match(markup, /aria-label="Proficient"/);
  assert.match(markup, /data-proficiency-level="prof"[^>]*>Wisdom save<span/, "the save alone carries the mark");
  assert.match(markup.replace(/<[^>]*>/g, ""), /Wisdom save, DC 15, ends it\./);
  assert.doesNotMatch(markup, /white-space:nowrap">Wisdom/, "no unit added around the save");
  state.characters.hero!.stats = { ...STATS, saves: ["con"] };
  assert.doesNotMatch(render(state, createElement(SaveEndsCard, { pending, onResult() {} })), /aria-label="Proficient"/);
});

test("fl7: concentration reads Constitution save proficiency, not a skill flag", () => {
  const state = fixture();
  const card = createElement(ConcentrationCard, { prompt: { logId: "1:0", target: { characterId: "hero" }, dc: 12 }, onDone() {}, onResult() {} });
  const markup = render(state, card);
  assert.match(markup, /data-proficiency-level="prof"[^>]*>Concentration save<span/);
  assert.doesNotMatch(markup, /aria-label="Expertise"/);
  assert.match(markup.replace(/<[^>]*>/g, ""), /took damage\. Constitution save, DC 12\./, "the line under it is as before FL-7");
  const noSave = fixture();
  noSave.characters.hero!.stats = { ...STATS, saves: ["wis"] };
  assert.doesNotMatch(render(noSave, card), /aria-label="Proficient"/);
});

test("fl7: Log roll answers retain their words and show the creature's skill expertise", () => {
  const state = fixture();
  state.log = [{ id: "1:0", at: "2026-10-29T12:00:00.000Z", kind: "event", data: {
    type: "roll", test: { kind: "check", choices: [{ ability: "wis", skill: "perception" }] }, characterId: "hero", total: 19,
  } }];
  const markup = render(state, createElement(LogPanel, {} as never));
  assert.match(markup, /aria-label="Expertise"/);
  assert.match(markup, /Perception/);
  assert.match(markup, /19/);
  assert.match(markup, /Hero/);
  delete state.characters.hero;
  assert.doesNotMatch(render(state, createElement(LogPanel, {} as never)), /aria-label="Expertise"/);
});
