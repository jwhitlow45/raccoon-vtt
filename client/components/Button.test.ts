import "./testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { theme } from "../lib/theme.ts";
import { buttonLook, choiceLook, type ButtonVariant } from "./looks.ts";

const { createElement } = await import("react");
const { renderToStaticMarkup } = await import("react-dom/server");
const { Button } = await import("./Button.tsx");
const { IconButton } = await import("./IconButton.tsx");
const { ICON_NAMES, Icon } = await import("./Icon.tsx");

const VARIANTS: ButtonVariant[] = ["primary", "secondary", "quiet", "danger"];

function html(element: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(element);
}

describe("Button", () => {
  for (const variant of VARIANTS) {
    test(`a disabled ${variant} button swaps its colors and never fades`, () => {
      const look = buttonLook(variant, { disabled: true });
      assert.equal(look.color, theme.color.textDisabled);
      assert.equal(look.opacity, undefined);
      assert.ok(!String(look.background).includes("accent"), `${variant}: a disabled button drops the accent fill`);
      const markup = html(createElement(Button, { variant, disabled: true }, "Join"));
      assert.doesNotMatch(markup, /opacity/);
      assert.match(markup, / disabled=""/);
    });
  }

  test("a disabled pressed button keeps its place with a dim outline and no tint", () => {
    const look = buttonLook("secondary", { disabled: true, pressed: true });
    assert.equal(look.background, "transparent");
    assert.match(String(look.border), new RegExp(theme.color.textDisabled));
  });

  test("a disclosure says open in aria-expanded with the chosen look, never in aria-pressed", () => {
    const open = html(createElement(Button, { expanded: true }, "Rolls 0/3"));
    assert.match(open, /aria-expanded="true"/);
    assert.doesNotMatch(open, /aria-pressed/);
    assert.match(open, new RegExp(`border:1px solid ${theme.color.accent.replace(/[()]/g, "\\$&")}`), "it looks chosen while open");
    const shut = html(createElement(Button, { expanded: false }, "Rolls 0/3"));
    assert.match(shut, /aria-expanded="false"/);
    assert.doesNotMatch(shut, /aria-pressed/);
  });

  test("pressed sets aria-pressed and the chosen look, and unpressed says false", () => {
    assert.match(html(createElement(Button, { pressed: true }, "Snap")), /aria-pressed="true"/);
    assert.match(html(createElement(Button, { pressed: false }, "Snap")), /aria-pressed="false"/);
    assert.doesNotMatch(html(createElement(Button, {}, "Save")), /aria-pressed/);
    assert.equal(buttonLook("secondary", { pressed: true }).color, theme.color.accent);
    assert.equal(buttonLook("quiet", { pressed: true }).background, theme.color.accentTint);
  });

  test("busy keeps the caller's label, adds a spinner and aria-busy, and stays at full color", () => {
    const markup = html(createElement(Button, { variant: "primary", busy: true }, "Saving…"));
    assert.match(markup, /Saving…/);
    assert.match(markup, /aria-busy="true"/);
    assert.match(markup, /<svg class="rvtt-spin"/);
    assert.doesNotMatch(markup, / disabled=""/);
    assert.match(markup, new RegExp(`color:${escape(theme.color.onAccent)}`));
  });

  test("armed only changes a danger button", () => {
    assert.equal(buttonLook("danger", { armed: true }).background, theme.color.dangerTint);
    assert.equal(buttonLook("danger").color, theme.color.dangerText);
  });

  test("a caller's alignment wins over the centered default", () => {
    const markup = html(createElement(Button, { block: true, style: { justifyContent: "flex-start" } }, "Continue as Pat"));
    assert.match(markup, /justify-content:flex-start/);
    assert.doesNotMatch(markup, /justify-content:center/);
  });

  test("both sizes keep a 44 px target", () => {
    for (const size of ["md", "sm"] as const) {
      const markup = html(createElement(Button, { size }, "Go"));
      assert.match(markup, /min-height:44px/);
      assert.match(markup, /min-width:44px/);
    }
  });
});

describe("choices and icon buttons", () => {
  test("a choice is never faded, chosen or not", () => {
    for (const chosen of [true, false]) {
      for (const disabled of [true, false]) assert.equal(choiceLook(chosen, disabled).opacity, undefined);
    }
    assert.equal(choiceLook(false, true).color, theme.color.textDisabled);
    assert.equal(choiceLook(true, true).background, "transparent");
  });

  test("an icon button is 44 px, named by its label, and dims its icon when disabled", () => {
    const markup = html(createElement(IconButton, { icon: "close", label: "Close Journal", disabled: true }));
    assert.match(markup, /aria-label="Close Journal"/);
    assert.match(markup, /min-width:44px/);
    assert.match(markup, new RegExp(`color:${escape(theme.color.textDisabled)}`));
    assert.doesNotMatch(markup, /opacity/);
  });

  test("every icon draws and hides itself from screen readers", () => {
    for (const name of ICON_NAMES) {
      const markup = html(createElement(Icon, { name }));
      assert.match(markup, /^<svg aria-hidden="true"/, name);
      assert.match(markup, /<(path|circle|rect)/, name);
    }
  });
});

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
