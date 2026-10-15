import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { ApiError } from "../lib/api.ts";
import { theme } from "../lib/theme.ts";
import { claimRefusal, dmChoices } from "./claimRefusal.ts";

describe("a refused DM link or invite", () => {
  const removed = new ApiError(409, "That member was removed.", "member_removed", null);

  test("a removed member asks again with the DM link, which still works", () => {
    const refusal = claimRefusal("dm", removed);
    assert.equal(refusal.dropSecret, false);
    assert.equal(refusal.phase.kind, "reask");
  });

  test("a device new to the room is asked who it is, with the DM members to pick from", () => {
    const dmMembers = [{ id: "m1", name: "Dana", color: "#f38400" }];
    const ask = new ApiError(409, "Choose.", "choose_member", null, { error: "choose_member", roomId: "K7QH2MXA", dmMembers });
    for (const kind of ["dm", "invite"] as const) {
      assert.deepEqual(claimRefusal(kind, ask), { phase: { kind: "choose", dmMembers, notice: null }, dropSecret: false });
    }
  });

  test("a refused pick asks again with the same link, even an invite, because nothing was spent", () => {
    for (const code of ["member_removed", "not_a_dm"] as const) {
      const err = new ApiError(code === "not_a_dm" ? 403 : 409, "No.", code, null);
      for (const kind of ["dm", "invite"] as const) {
        const refusal = claimRefusal(kind, err, true);
        assert.equal(refusal.phase.kind, "reask", `${kind} ${code}`);
        assert.equal(refusal.dropSecret, false);
      }
    }
  });

  test("the DM members shown are only well formed ones", () => {
    assert.deepEqual(dmChoices(undefined), []);
    assert.deepEqual(dmChoices("x"), []);
    assert.deepEqual(
      dmChoices([{ id: "a", name: "Ann", color: "#00ff00" }, { id: "b", name: "Bo", color: "red" }, { id: 3, name: "C" }, null, { id: "d" }]),
      [
        { id: "a", name: "Ann", color: "#00ff00" },
        { id: "b", name: "Bo", color: theme.color.textMuted },
      ],
    );
  });

  test("a removed member is told a spent invite needs replacing, with no offer to reuse it", () => {
    const refusal = claimRefusal("invite", removed);
    assert.equal(refusal.dropSecret, true);
    assert.equal(refusal.phase.kind, "error");
    if (refusal.phase.kind === "error") {
      assert.equal(refusal.phase.retry, false);
      assert.match(refusal.phase.message, /new one/);
    }
  });

  test("a network failure keeps the secret for Try again, a refusal drops it", () => {
    const offline = claimRefusal("invite", new ApiError(0, "No connection.", "network", null));
    assert.deepEqual(offline, { phase: { kind: "error", message: "No connection.", retry: true }, dropSecret: false });
    const dead = claimRefusal("dm", new ApiError(403, "Refused.", "bad_key", null));
    assert.equal(dead.dropSecret, true);
    assert.equal(dead.phase.kind === "error" && dead.phase.retry, false);
  });
});
