import assert from "node:assert/strict";
import { test } from "node:test";
import { SAVE_DRAFT_BYTES } from "#shared/saveOutcomeContract.ts";
import { readSaveDraft, writeSaveDraft } from "./draftStorage.ts";
import { newPage } from "./chain.ts";
import type { SaveChoices, SaveDraft } from "./reopenContract.ts";

const key = "rvtt.groupSave.room";
const fresh = (): SaveDraft => ({ version: 2, page: newPage({ id: "page", sceneId: "scene", source: { kind: "selection", tokenIds: [] }, test: { kind: "none" }, dc: null, secret: true, spell: false, switches: { dcShown: false, resultShown: false } }) });
function withStorage(run: (stored: Map<string, string>) => void, options: { full?: boolean; blocked?: boolean; missing?: boolean } = {}) {
  const before = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", options.blocked ? { configurable: true, get() { throw new Error("blocked"); } } : { configurable: true, value: options.missing ? undefined : {
    getItem: (name: string) => stored.get(name) ?? null,
    setItem(name: string, value: string) { if (options.full) throw new Error("full"); stored.set(name, value); },
    removeItem(name: string) { if (options.full) throw new Error("full"); stored.delete(name); },
  } });
  try { run(stored); } finally {
    if (before) Object.defineProperty(globalThis, "sessionStorage", before);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
}

test("version 2 storage round trips damage holes without mutating the memory draft and clears only its room", () => withStorage(stored => {
  const draft = fresh();
  draft.page.damage = { tag: "damage", state: "committed", amounts: [undefined, 7] };
  stored.set("rvtt.groupSave.other", "other");
  assert.equal(writeSaveDraft("room", draft), true);
  assert.deepEqual(JSON.parse(stored.get(key)!).page.damage.amounts, [null, 7]);
  assert.deepEqual(draft.page.damage.amounts, [undefined, 7]);
  assert.deepEqual(readSaveDraft("room"), draft);
  assert.equal(writeSaveDraft("room", null), true);
  assert.equal(readSaveDraft("room"), null);
  assert.equal(stored.get("rvtt.groupSave.other"), "other");
}));

test("legacy applied and unknown pages migrate without inventing tracking or an undo checkpoint", () => withStorage(stored => {
  for (const apply of ["taken", "unknown"] as const) {
    const page = { ...fresh().page, phase: apply === "taken" ? "applied" as const : "applying" as const, apply };
    stored.set(key, JSON.stringify(page));
    const draft = readSaveDraft("room");
    assert.deepEqual(draft, { version: 2, page });
    assert.equal(draft!.tracking, undefined);
    assert.equal(draft!.beforeApply, undefined);
    assert.equal(writeSaveDraft("room", draft), true);
    assert.equal(JSON.parse(stored.get(key)!).version, 2);
  }
}));

test("malformed nested data and unknown versions cannot bypass strict draft validation", () => withStorage(stored => {
  for (const invalid of [
    { ...fresh(), version: 3 },
    { ...fresh(), page: { ...fresh().page, outcome: { ...fresh().page.outcome, lasts: { mode: "none", rounds: 10, anchor: "own", send: [] } } } },
    { ...fresh().page, states: { "token:bad": { way: "ask", answer: { tokenId: "bad", dice: { formula: "1d20", total: 20, faces: ["20"] } } } } },
  ]) {
    stored.set(key, JSON.stringify(invalid));
    assert.equal(readSaveDraft("room"), null);
  }
  stored.set(key, "{incomplete");
  assert.equal(readSaveDraft("room"), null);
  const original = JSON.stringify(fresh());
  stored.set(key, original);
  assert.equal(writeSaveDraft("room", { ...fresh(), version: 3 } as unknown as SaveDraft), false);
  assert.equal(stored.get(key), original);
}));

test("the full raw UTF-8 cap rejects whitespace and multibyte padding before parsing", () => withStorage(stored => {
  const valid = JSON.stringify(fresh());
  stored.set(key, " ".repeat(SAVE_DRAFT_BYTES - valid.length + 1) + valid);
  assert.equal(readSaveDraft("room"), null);
  const draft = fresh();
  draft.page.outcome.damage = "界".repeat(180000);
  stored.set(key, JSON.stringify(draft));
  assert.equal(readSaveDraft("room"), null);
  assert.equal(writeSaveDraft("room", draft), false);
}));

test("aggregate overflow preserves memory and the prior stored draft without truncation", () => withStorage(stored => {
  const previous = fresh();
  assert.equal(writeSaveDraft("room", previous), true);
  const raw = stored.get(key);
  const draft = fresh();
  draft.page.outcome.damage = "x".repeat(180000);
  const { id: _id, plan: _plan, apply: _apply, ...fields } = draft.page;
  const choices = { ...fields, phase: "setup", damage: null } as SaveChoices;
  draft.beforeApply = { version: 1, pageId: draft.page.id, plan: "019a3df0-1000-7000-8000-000000000001", choices };
  draft.redoHeld = choices;
  const memory = structuredClone(draft);
  assert.equal(writeSaveDraft("room", draft), false);
  assert.deepEqual(draft, memory);
  assert.equal(stored.get(key), raw);
}));

test("blocked, full, and unavailable storage report failure and leave the memory draft intact", () => {
  for (const options of [{ blocked: true }, { full: true }, { missing: true }]) withStorage(() => {
    const draft = fresh();
    const memory = structuredClone(draft);
    assert.equal(writeSaveDraft("room", draft), false);
    assert.equal(writeSaveDraft("room", null), false);
    assert.equal(readSaveDraft("room"), null);
    assert.deepEqual(draft, memory);
  }, options);
});
