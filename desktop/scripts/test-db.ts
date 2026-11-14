import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Platform, RESOURCES, RUNTIME_DIR } from "../contract.ts";
import { Cluster } from "../runtime/postgres.ts";

/**
 * A throwaway PostgreSQL from the fetched runtime, for the server's
 * integration tests where no database runs as a service, as on CI's Windows
 * runner (docs/design/design-v1-local-app.md 11.1):
 *
 *   node desktop/scripts/test-db.ts pnpm test:int
 *
 * It makes a cluster in a temp folder with the desktop app's own settings,
 * a `raccoon` database, runs the command with DATABASE_URL pointing at it,
 * then stops the cluster, removes the folder, and exits with the command's
 * code. The cluster is the bundled one, so the tests run against the
 * PostgreSQL the desktop app ships.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

const command = process.argv.slice(2);
if (command.length === 0) {
  console.error("Usage: node desktop/scripts/test-db.ts <command> [args...]");
  process.exit(2);
}

const dir = await mkdtemp(join(tmpdir(), "rvtt-test-db-"));
const cluster = new Cluster({
  binDir: join(process.env.RACCOONVTT_TEST_POSTGRES ?? join(ROOT, RUNTIME_DIR, RESOURCES.postgres), "bin"),
  pgData: join(dir, "postgres"),
  logFile: join(dir, "postgres.log"),
  // A throwaway cluster on loopback, gone when the command ends.
  password: "raccoon",
  platform: Platform.parse(process.platform),
});

let code = 1;
try {
  await cluster.init();
  await cluster.start();
  const admin = new pg.Client({ connectionString: cluster.url("postgres") });
  await admin.connect();
  await admin.query("create database raccoon template template0");
  await admin.end();
  console.log(`test-db: PostgreSQL on 127.0.0.1:${cluster.port}`);
  code = await new Promise<number>((resolve) => {
    // Windows runs pnpm through its .cmd shim, which only a shell starts.
    const child = spawn(command[0] as string, command.slice(1), {
      stdio: "inherit",
      env: { ...process.env, DATABASE_URL: cluster.url() },
      shell: process.platform === "win32",
    });
    child.on("error", (err) => {
      console.error(err.message);
      resolve(1);
    });
    child.on("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
  });
} catch (err) {
  console.error(`test-db: ${(err as Error).message}`);
} finally {
  await cluster.stop().catch((err: unknown) => console.error(`test-db: stopping PostgreSQL failed: ${(err as Error).message}`));
  await rm(dir, { recursive: true, force: true });
}
process.exit(code);
