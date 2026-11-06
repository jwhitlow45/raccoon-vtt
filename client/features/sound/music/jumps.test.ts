import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { OpOf } from "#shared/protocol.ts";
import { RoomScope } from "../../../state/scope.ts";
import type { OnAnswer } from "../../../state/types.ts";
import { jumpsOf, jumpsSlot, type Jumps } from "./jumps.ts";

/*
 * One count of pending jumps for the Room page
 * (docs/design/design-v1-sound-layout.md 5.3): the panel's player and the
 * chip's count together, and no player sends through a count of its own.
 */

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { RoomProvider } = await import("../../../state/view.ts");
const { RoomScopeProvider } = await import("../../../state/scope.ts");
const { useJumps } = await import("./jumps.ts");

const jump = (run: string): OpOf<"music.jump"> => ({ t: "music.jump", run, from: "r0", soundId: "s1" });

/** A room's dispatch that keeps each op's answer for the test to give. */
function dispatcher() {
  const sent: string[] = [];
  const answers: OnAnswer[] = [];
  return {
    sent,
    answer: (i: number) => answers[i]!("taken"),
    actions: {
      dispatch(op: { t: string }, opts?: { onAnswer?: OnAnswer }): number | null {
        sent.push(op.t);
        if (opts?.onAnswer) answers.push(opts.onAnswer);
        return sent.length;
      },
    },
  };
}

describe("pending jumps", () => {
  test("a jump from the panel counts in the chip's player and back, through one Room slot", () => {
    const scope = new RoomScope();
    assert.equal(scope.get(jumpsSlot), scope.get(jumpsSlot));
    assert.notEqual(scope.get(jumpsSlot), new RoomScope().get(jumpsSlot), "a preview's page counts its own");
    const room = dispatcher();
    const panel = jumpsOf(scope.get(jumpsSlot), room.actions);
    const chip = jumpsOf(scope.get(jumpsSlot), room.actions);
    panel.send(jump("r1"));
    assert.deepEqual(room.sent, ["music.jump"]);
    assert.equal(chip.pending(), true, "Previous in the chip's player now counts the track as at 0 s");
    chip.send(jump("r1"));
    room.answer(0);
    assert.equal(panel.pending(), true, "one still waits");
    room.answer(1);
    assert.equal(panel.pending(), false);
    assert.equal(chip.pending(), false);
  });

  test("an answer heard twice, after a resend, counts down once", () => {
    const scope = new RoomScope();
    const room = dispatcher();
    const jumps = jumpsOf(scope.get(jumpsSlot), room.actions);
    jumps.send(jump("r1"));
    jumps.send(jump("r1"));
    room.answer(0);
    room.answer(0);
    assert.equal(jumps.pending(), true, "the second jump still waits");
    room.answer(1);
    assert.equal(jumps.pending(), false);
    room.answer(1);
    assert.equal(scope.get(jumpsSlot).n, 0, "never below none");
  });

  test("a player in a Room sends through the Room's count, and one outside any Room fails loudly, never a dead button", () => {
    const room = dispatcher();
    const scope = new RoomScope();
    let seen: Jumps | null = null;
    const Probe = () => {
      seen = useJumps();
      return null;
    };
    const provider = (child: unknown) => createElement(RoomProvider, { store: {} as never, actions: room.actions as never, ui: {} as never, children: child as never });
    renderToStaticMarkup(provider(createElement(RoomScopeProvider, { scope, children: createElement(Probe) })));
    (seen as unknown as Jumps).send(jump("r1"));
    assert.deepEqual(room.sent, ["music.jump"]);
    assert.equal(scope.get(jumpsSlot).n, 1, "counted in the Room's slot");
    assert.throws(() => renderToStaticMarkup(provider(createElement(Probe))), /RoomScopeProvider/);
  });
});
