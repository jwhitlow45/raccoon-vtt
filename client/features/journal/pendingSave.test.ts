import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { draftOf, saveAnswer, saveDraft, type PageDraft } from "./draft.ts";
import { closedAnswerText, editDraft, pendingCloseText, saveAnswered, saveSent, saveState } from "./pendingSave.ts";

const draft: PageDraft = { title: "Old map", folder: "", access: "all", blocks: [{ id: "aaaaaaaaaaaa", text: "The crypt lies north.", secret: false }] };

// W5-ASTRA-05: an edit made after Save, before the acknowledgment, was lost when the acknowledgment closed the editor.
describe("a journal save waiting for its answer", () => {
  test("an edit while the save is pending is refused, and the acknowledgment closes with the page as sent", () => {
    let state = saveState(draft);
    const sent = saveDraft(null, state.draft, "pg1");
    assert.ok(sent.kind === "op" && sent.op.t === "journal.create");
    state = saveSent(state);
    const typed = editDraft(state, (d) => ({ ...d, title: "Older map" }));
    assert.equal(typed, state, "the edit is refused while the save is pending");
    const answered = saveAnswered(state, saveAnswer("taken"));
    assert.equal(answered.close, true);
    assert.equal(answered.state.draft.title, sent.op.page.title, "what closes is what was sent: nothing typed was dropped");
  });

  test("a refusal or a lost answer unlocks the same draft with the reason, for another try", () => {
    for (const [answer, refusal] of [
      ["refused", { code: "quota", message: "a journal page is at most 32 KiB", text: "Not saved. A journal page is at most 32 KiB." }],
      ["unknown", undefined],
    ] as const) {
      const pending = saveSent(saveState(draftOf({ id: "pg1", rev: 1, title: "Old map", access: "all", blocks: [] })));
      const answered = saveAnswered(pending, saveAnswer(answer, refusal));
      assert.equal(answered.close, false);
      assert.equal(answered.state.pending, false);
      assert.ok(answered.state.failure);
      assert.equal(editDraft(answered.state, (d) => ({ ...d, title: "Older map" })).draft.title, "Older map", "editable again");
    }
  });

  test("closing while pending discards nothing, and a late failure still says so", () => {
    assert.equal(pendingCloseText("page", true), "The page is still saving.");
    assert.equal(pendingCloseText("page", false), "The page will save when the connection is back.");
    assert.equal(closedAnswerText("page", "taken"), null);
    assert.equal(closedAnswerText("page", "refused", { code: "quota", message: "x", text: "Not saved. A journal page is at most 32 KiB." }), "The page was not saved. A journal page is at most 32 KiB.");
    assert.match(closedAnswerText("pin", "unknown") ?? "", /the pin may not be saved/);
  });
});
