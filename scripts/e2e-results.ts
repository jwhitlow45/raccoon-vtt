import type { TestEvent } from "node:test/reporters";
import type { TestResult } from "./e2e-shard-plan.ts";

/**
 * A node:test reporter that scripts/e2e-shard.ts adds beside the spec
 * reporter: one JSON line per test that passed or failed, in the order
 * the tests ran, with its full name, its suites' names and its own joined
 * by spaces, as --test-skip-pattern matches it. The shard reads it when a
 * file fails, to leave out of the rerun the tests that passed after the
 * last failure (scripts/e2e-shard-plan.ts, rerunSkips).
 *
 * A file's tests run one after another, so a test's suites are the tests
 * started last at each smaller nesting. A result whose start was not seen,
 * such as a file that failed before any test began, has no full name.
 */
export default async function* results(source: AsyncIterable<TestEvent>): AsyncGenerator<string, void> {
  const started: (string | null)[] = [];
  for await (const event of source) {
    if (event.type === "test:start") {
      const { name, nesting } = event.data;
      started.length = Math.min(started.length, nesting);
      while (started.length < nesting) started.push(null);
      started.push(name);
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const { name, nesting, details } = event.data;
    if (details.type === "suite") continue;
    const ancestry = started.slice(0, nesting + 1);
    const known = ancestry.length === nesting + 1 && ancestry[nesting] === name && !ancestry.includes(null);
    const result: TestResult = { full: known ? ancestry.join(" ") : null, ok: event.type === "test:pass" };
    yield JSON.stringify(result) + "\n";
  }
}
