import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

const { Chip } = await import("./Chip.tsx");

/*
 * An unavailable chip keeps its focus and says why to a reader. A caller
 * that also says why on a tap hears that tap through `onUnavailable`, and
 * nothing is sent (review CCB-OPUS-9, the Dice panel's X/Day Use at 0 left).
 * The button Chip draws is read as an element, so its click runs as a tap
 * would run it.
 */

type Drawn = { props: { onClick(): void; "aria-disabled"?: boolean; "aria-describedby"?: string; disabled?: boolean } };

function tap(props: Parameters<typeof Chip>[0]): void {
  (Chip(props) as unknown as Drawn).props.onClick();
}

describe("a tap on an unavailable chip (CCB-OPUS-9)", () => {
  test("reaches onUnavailable alone, keeping aria-disabled and the reason it names", () => {
    const heard: string[] = [];
    const props = { children: "Use", unavailable: true, describedBy: "none", onClick: () => heard.push("click"), onUnavailable: () => heard.push("why") };
    tap(props);
    assert.deepEqual(heard, ["why"]);
    const drawn = Chip(props) as unknown as Drawn;
    assert.equal(drawn.props["aria-disabled"], true);
    assert.equal(drawn.props["aria-describedby"], "none");
    assert.equal(drawn.props.disabled, undefined, "it keeps its focus");
  });

  test("an available chip runs onClick alone, and a disabled one neither", () => {
    const heard: string[] = [];
    tap({ children: "Use", onClick: () => heard.push("click"), onUnavailable: () => heard.push("why") });
    assert.deepEqual(heard, ["click"]);
    tap({ children: "Use", disabled: true, unavailable: true, onClick: () => heard.push("click"), onUnavailable: () => heard.push("why") });
    assert.deepEqual(heard, ["click"]);
  });

  test("an unavailable chip with no onUnavailable still does nothing", () => {
    const heard: string[] = [];
    tap({ children: "Use", unavailable: true, onClick: () => heard.push("click") });
    assert.deepEqual(heard, []);
  });
});
