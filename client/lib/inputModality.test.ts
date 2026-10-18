import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { INPUT_ATTR, modalityAfter, takesTypedText, trackInputModality, type InputEventLike, type ModalityHost, type ModalityRoot } from "./inputModality.ts";

/** A window that fires the events a test sends, and the `<html>` whose attribute it sets. */
class FakePage implements ModalityHost, ModalityRoot {
  readonly attrs = new Map<string, string>();
  /** Every value the attribute took, in order, so a write that changes nothing would show. */
  readonly writes: string[] = [];
  private readonly listeners = new Map<string, Set<(e: InputEventLike) => void>>();

  addEventListener(type: string, listener: (e: InputEventLike) => void, options: AddEventListenerOptions): void {
    assert.equal(options.capture, true, "it listens before any handler can stop the event");
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }
  removeEventListener(type: string, listener: (e: InputEventLike) => void): void {
    this.listeners.get(type)?.delete(listener);
  }
  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }
  setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
    this.writes.push(value);
  }
  fire(e: InputEventLike): string | null {
    for (const l of this.listeners.get(e.type) ?? []) l(e);
    return this.getAttribute(INPUT_ATTR);
  }
  get listening(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }
}

const button = { tagName: "BUTTON" };
const textInput = { tagName: "INPUT", type: "text" };
const key = (k: string, more: Partial<InputEventLike> = {}): InputEventLike => ({ type: "keydown", key: k, target: button, ...more });

describe("input modality", () => {
  test("a pointer, then a key: the rings come back at the key", () => {
    const page = new FakePage();
    trackInputModality(page, page);
    assert.equal(page.fire({ type: "pointerdown" }), "pointer");
    assert.equal(page.fire(key("Tab")), "keys");
  });

  test("a key, then a pointer: a tap, a mouse press or a touch hides them again", () => {
    for (const type of ["pointerdown", "mousedown", "touchstart"]) {
      const page = new FakePage();
      trackInputModality(page, page);
      assert.equal(page.fire(key("ArrowDown")), "keys");
      assert.equal(page.fire({ type }), "pointer", type);
    }
  });

  test("a bare modifier is no key press", () => {
    const page = new FakePage();
    trackInputModality(page, page);
    page.fire({ type: "pointerdown" });
    for (const k of ["Shift", "Control", "Alt", "Meta", "CapsLock"]) assert.equal(page.fire(key(k)), "pointer", k);
    assert.equal(page.fire(key("Tab", { ctrlKey: true })), "keys", "a key held with a modifier counts");
  });

  test("before any input, a modifier or a pointer move leaves it unset", () => {
    const page = new FakePage();
    trackInputModality(page, page);
    assert.equal(page.fire(key("Shift")), null);
    assert.equal(page.fire({ type: "pointermove" }), null);
    assert.equal(page.fire(key("Enter")), "keys");
  });

  test("typing into a text field changes nothing, but leaving it or a shortcut counts", () => {
    const page = new FakePage();
    trackInputModality(page, page);
    page.fire({ type: "touchstart" });
    for (const k of ["a", "Backspace", "Enter", "ArrowLeft", " "]) assert.equal(page.fire(key(k, { target: textInput })), "pointer", k);
    assert.equal(page.fire(key("Tab", { target: textInput })), "keys", "Tab leaves the field");
    page.fire({ type: "touchstart" });
    assert.equal(page.fire(key("Escape", { target: textInput })), "keys", "Escape leaves the field");
    page.fire({ type: "touchstart" });
    assert.equal(page.fire(key("k", { target: textInput, metaKey: true })), "keys", "a shortcut");
  });

  test("the attribute is written only when it changes", () => {
    const page = new FakePage();
    trackInputModality(page, page);
    page.fire({ type: "pointerdown" });
    page.fire({ type: "mousedown" });
    page.fire(key("a"));
    page.fire(key("b"));
    page.fire({ type: "touchstart" });
    assert.deepEqual(page.writes, ["pointer", "keys", "pointer"]);
  });

  test("a value it did not write, such as a phone's start, is read as that modality", () => {
    const page = new FakePage();
    page.setAttribute(INPUT_ATTR, "pointer");
    trackInputModality(page, page);
    assert.equal(page.fire(key("a", { target: textInput })), "pointer");
    assert.equal(page.fire(key("a")), "keys");
  });

  test("the stop removes every listener", () => {
    const page = new FakePage();
    const stop = trackInputModality(page, page);
    assert.equal(page.listening, 4);
    stop();
    assert.equal(page.listening, 0);
    assert.equal(page.fire(key("Tab")), null);
  });

  test("modalityAfter ignores events it does not know", () => {
    assert.equal(modalityAfter("keys", { type: "focus" }), "keys");
    assert.equal(modalityAfter(null, { type: "keyup", key: "Tab" }), null);
  });

  test("a text field is a text-like input, a textarea or an editable element", () => {
    for (const type of ["text", "search", "email", "number", "password", "date", "tel", "url"]) assert.equal(takesTypedText({ tagName: "INPUT", type }), true, type);
    assert.equal(takesTypedText({ tagName: "INPUT" }), true, "no type is text");
    for (const type of ["checkbox", "radio", "range", "button", "submit", "color", "file"]) assert.equal(takesTypedText({ tagName: "INPUT", type }), false, type);
    assert.equal(takesTypedText({ tagName: "TEXTAREA" }), true);
    assert.equal(takesTypedText({ tagName: "DIV", isContentEditable: true }), true);
    assert.equal(takesTypedText({ tagName: "SELECT" }), false, "a select's arrow keys move between options, as a key press");
    assert.equal(takesTypedText(button), false);
    assert.equal(takesTypedText(null), false);
  });
});
