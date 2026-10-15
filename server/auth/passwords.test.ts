import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { BusyError, PasswordHasher, passwordProblem, Semaphore } from "./passwords.ts";

describe("password policy", () => {
  test("needs at least 8 characters, counted as code points", () => {
    assert.equal(passwordProblem("short12"), "too_short");
    assert.equal(passwordProblem("🐉🐉🐉🐉🐉🐉🐉"), "too_short");
    assert.equal(passwordProblem("owlbear-druid-wand"), null);
  });

  test("refuses the common list in any case", () => {
    assert.equal(passwordProblem("password"), "too_common");
    assert.equal(passwordProblem("12345678"), "too_common");
    assert.equal(passwordProblem("Baseball1"), "too_common");
    assert.equal(passwordProblem("QWERTYUIOP"), "too_common");
  });

  test("the list header is not itself a password", () => {
    assert.equal(passwordProblem("# The 10,000 most common passwords, from SecLists by Daniel Miessler."), null);
  });

  test("refuses absurd lengths", () => {
    assert.equal(passwordProblem("a".repeat(129)), "too_long");
  });
});

describe("Semaphore", () => {
  test("runs at most `concurrency` tasks and queues at most `maxQueue`", async () => {
    const sem = new Semaphore(2, 3);
    const gates: Array<() => void> = [];
    let running = 0;
    let peak = 0;
    const task = () =>
      sem.run(async () => {
        running++;
        peak = Math.max(peak, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running--;
      });
    const accepted = Array.from({ length: 5 }, task);
    await assert.rejects(task(), BusyError);
    assert.equal(sem.active, 2);
    assert.equal(sem.waiting, 3);
    while (gates.length > 0 || sem.active > 0) {
      gates.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await Promise.all(accepted);
    assert.equal(peak, 2);
    assert.equal(sem.active, 0);
  });

  test("a failing task releases its slot", async () => {
    const sem = new Semaphore(1, 0);
    await assert.rejects(sem.run(async () => Promise.reject(new Error("boom"))));
    assert.equal(await sem.run(async () => 7), 7);
  });
});

describe("PasswordHasher", () => {
  test("hashes with argon2id at OWASP's parameters and verifies", async () => {
    const hasher = new PasswordHasher();
    const phc = await hasher.hash("owlbear-druid-wand");
    assert.match(phc, /^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    assert.equal(await hasher.verify(phc, "owlbear-druid-wand"), true);
    assert.equal(await hasher.verify(phc, "owlbear-druid-want"), false);
  });

  test("a malformed stored hash reads as a failed check", async () => {
    assert.equal(await new PasswordHasher().verify("not a hash", "whatever1"), false);
  });
});
