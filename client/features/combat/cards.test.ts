import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { createStore } from "zustand/vanilla";
import type { Actor, RoomState, Settled } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { DM, actor, character, room, token } from "#shared/testutil.ts";
import type { PromptCard } from "./alerts.ts";
import type { ClientOp } from "#shared/protocol.ts";
import type { DeathSavePrompt, RegenerationPrompt } from "./logic.ts";

/*
 * The turn-start cards as they render (docs/design/design-v1-combat-controls.md
 * 4.4): what a death save card says before and after it is settled.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../state/view.ts");
const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");
const { DeathSaveCard } = await import("./DeathSaveCard.tsx");
const { RegenerationCard } = await import("./RegenerationCard.tsx");

function render(state: RoomState, child: ReturnType<typeof createElement>, pending: readonly { n: number; op: ClientOp; at: number }[] = []): string {
  const view = projectState(state, DM, { sceneId: "s1" });
  const store = createStore(() => ({ view, confirmed: view, you: { memberId: DM.memberId, role: DM.role }, roomId: "r1", connection: "open", pending, local: { selectedIds: [], multi: false } }));
  return renderToStaticMarkup(
    createElement(RoomProvider, {
      store: store as never,
      actions: { dispatch: () => 1, newId: () => "x" } as never,
      ui: {} as never,
      assets: { url: () => "" } as never,
      children: createElement(RoomScopeProvider, { scope: new RoomScope(), children: child }),
    }),
  );
}

/** Thorn's death save card, his actor as the roll left it and the prompt as settled. */
function deathCard(after: Partial<Actor>, settled: Settled | undefined, pending: readonly { n: number; op: ClientOp; at: number }[] = []): string {
  const state = room({ characters: { thorn: character("thorn", { name: "Thorn", ownerIds: ["p1"], actor: actor({ hp: { cur: 0, max: 30, temp: 0 }, life: "dying", deathSaves: { ok: 2, fail: 1 }, ...after }) }) } });
  state.tokens.thorn = token("thorn", { kind: "pc", name: "Thorn", actor: { ref: "thorn" } });
  const card: PromptCard<DeathSavePrompt> = {
    id: "c:thorn|7|deathSave",
    participant: { target: { tokenId: "thorn" }, holder: "c:thorn", name: "Thorn", record: { id: 7, entryId: "et", round: 2, hp: 0, life: "dying" }, landing: true },
    record: 7,
    prompt: { what: "deathSave", settled },
  };
  return render(state, createElement(DeathSaveCard, { card, waits: false, onDismiss() {} }), pending);
}

/** Each button's words, and whether it says it is busy. */
function buttons(markup: string): [string, boolean][] {
  return [...markup.matchAll(/<button([^>]*)>(.*?)<\/button>/g)].map(([, attrs, inner]) => [inner!.replace(/<[^>]+>/g, ""), /aria-busy="true"/.test(attrs!)]);
}

const NEXT_WAITS = [{ n: 1, op: { t: "encounter.next" } as ClientOp, at: 0 }];

const DYING = /Thorn is dying\./;
const PIPS = /aria-hidden="true"/;

describe("a settled death save card shows its result alone (CCB-OPUS-7)", () => {
  test("open, it says he is dying with his counts and pips, and offers Roll", () => {
    const markup = deathCard({}, undefined);
    assert.match(markup, /Thorn is dying\. Death save: 2 successes, 1 failure\./);
    assert.match(markup, PIPS);
    assert.match(markup, />Roll</);
  });

  for (const [what, after, settled, result] of [
    ["a natural 20 that brought him back", { hp: { cur: 1, max: 30, temp: 0 }, life: "alive", deathSaves: { ok: 0, fail: 0 } }, { state: "done", total: 20, outcome: "regain" }, "Rolled 20: Thorn regains 1 HP."],
    ["a third success that stabilized him", { life: "stable", deathSaves: { ok: 3, fail: 1 } }, { state: "done", total: 14, outcome: "success" }, "Rolled 14: a success."],
    ["a third failure that killed him", { life: "dead", deathSaves: { ok: 2, fail: 3 } }, { state: "done", total: 3, outcome: "failure" }, "Rolled 3: a failure."],
  ] as const) {
    test(`settled by ${what}: its result and Done, no dying line and no pips`, () => {
      const markup = deathCard(after as Partial<Actor>, settled as Settled);
      assert.match(markup, new RegExp(result.replace(/[.]/g, "\\.")));
      assert.match(markup, />Done</);
      assert.doesNotMatch(markup, DYING);
      assert.doesNotMatch(markup, PIPS);
    });
  }
});

describe("while a turn change waits for its answer, the cards' record buttons are busy and Dismiss is not", () => {
  test("the death save card: Roll and Skip busy, Dismiss live, and nothing busy once no turn change waits", () => {
    assert.deepEqual(buttons(deathCard({}, undefined, NEXT_WAITS)), [["Roll", true], ["Skip", true], ["Dismiss", false]]);
    assert.deepEqual(buttons(deathCard({}, undefined)), [["Roll", false], ["Skip", false], ["Dismiss", false]]);
    // A chat waiting is no turn change.
    assert.deepEqual(buttons(deathCard({}, undefined, [{ n: 1, op: { t: "log.chat", text: "hi" }, at: 0 }])), [["Roll", false], ["Skip", false], ["Dismiss", false]]);
  });

  test("the Regeneration card: Apply and Skip busy, Dismiss live", () => {
    const state = room();
    state.tokens.troll = token("troll", { name: "Troll", actor: { inline: actor({ hp: { cur: 10, max: 84, temp: 0 } }) } });
    const card: PromptCard<RegenerationPrompt> = {
      id: "t:troll|7|regeneration",
      participant: { target: { tokenId: "troll" }, holder: "t:troll", name: "Troll", record: { id: 7, entryId: "et", round: 2, hp: 10, life: "alive" }, landing: true },
      record: 7,
      prompt: { what: "regeneration", use: { kind: "regenerate", amount: 10, stops: [] } } as unknown as RegenerationPrompt,
    };
    const markup = (pending: readonly { n: number; op: ClientOp; at: number }[]) => render(state, createElement(RegenerationCard, { card, revives: false, onDismiss() {} }), pending);
    assert.deepEqual(buttons(markup(NEXT_WAITS)), [["Apply", true], ["Skip", true], ["Dismiss", false]]);
    assert.deepEqual(buttons(markup([])), [["Apply", false], ["Skip", false], ["Dismiss", false]]);
  });
});
