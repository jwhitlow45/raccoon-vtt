import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, isCounted, mergeLcov, sumByArea } from "../scripts/coverage.ts";

/**
 * `pnpm coverage` measures desktop/ as an area of its own, beside scripts/
 * and apart from the shipped figure, and leaves the supervisor's test
 * fakes out. It lives here, beside what it measures, so a change to
 * desktop/'s helpers meets it.
 */
const record = (file: string, lines: Record<number, number>) =>
  `SF:/repo/${file}\n${Object.entries(lines)
    .map(([no, hits]) => `DA:${no},${hits}`)
    .join("\n")}\nend_of_record\n`;

test("desktop/ is a coverage area of its own, outside the shipped figure", () => {
  const lcov = record("server/a.ts", { 1: 1 }) + record("desktop/runtime/settings.ts", { 1: 1, 2: 0 });
  const report = formatReport(sumByArea(mergeLcov([lcov], "/repo")));
  assert.match(report, /desktop\s+50\.0%\s+\(1\/2 lines\)/);
  assert.match(report, /Shipped code \(server, shared, client\): 100\.0%\s+\(1\/1 lines\)/);
});

test("the supervisor's fakes and the shell's fixtures are test support, and the code they test counts", () => {
  for (const file of ["desktop/runtime/testing/fakeWorld.ts", "desktop/shell/fixture.ts", "desktop/e2e/shellFakeSupervisor.ts", "desktop/runtime/lock.itest.ts", "desktop/shell/shell.test.ts"]) {
    assert.equal(isCounted(file), false, file);
  }
  for (const file of ["desktop/runtime/supervisor.ts", "desktop/shell/supervisor.ts", "desktop/scripts/fetch-runtime.ts", "desktop/contract.ts"]) {
    assert.equal(isCounted(file), true, file);
  }
});
