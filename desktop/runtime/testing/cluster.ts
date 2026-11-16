import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { Platform, RESOURCES, RUNTIME_DIR } from "../../contract.ts";
import { Cluster } from "../postgres.ts";

/**
 * A throwaway cluster from the fetched PostgreSQL, for the desktop's
 * integration tests (`pnpm test:desktop`). They need the real programs, so
 * a missing runtime fails them with the command that fetches it, never
 * skips them.
 */

export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function postgresDir(): string {
  const dir = process.env.RACCOONVTT_TEST_POSTGRES ?? join(ROOT, RUNTIME_DIR, RESOURCES.postgres);
  if (!existsSync(join(dir, "bin"))) throw new Error(`No PostgreSQL at ${dir}. Run pnpm desktop:fetch first.`);
  return dir;
}

/**
 * Removes a stopped cluster's folder, and fails, naming them, when it can't
 * or when the listing still shows a process of the folder. On Windows a
 * postgres.exe that has just removed postmaster.pid, its last act on the
 * data folder after it let go of its shared memory, still holds
 * postgres.log as its output for the moment its process takes to end, and
 * so does the cmd.exe it ran under, as an antivirus scan may hold a file
 * just written. So the removal takes Node's own retries, and the listing
 * after it tells a real leftover from such a moment.
 */
export async function removeStopped(cluster: Cluster, dir: string): Promise<void> {
  let failed: Error | null = null;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    failed = err as Error;
  }
  let left: string[];
  try {
    left = (await cluster.postmasters()).map((p) => `${p.pid} ${p.commandLine}`);
  } catch (err) {
    left = [`the listing failed: ${(err as Error).message}`];
  }
  if (failed === null && left.length === 0) return;
  const removal = failed === null ? "was removed" : `could not be removed (${failed.message})`;
  throw new Error(`the test cluster in ${dir} ${removal}${left.length > 0 ? `, and the listing still shows: ${left.join("; ")}` : ""}`);
}

export type TestCluster = {
  cluster: Cluster;
  dir: string;
  /** Each path the cluster was asked for PostgreSQL's spelling of, as pgPaths.ts gives one on Windows. */
  given: string[];
  pool(database?: string): pg.Pool;
  stop(): Promise<void>;
};

export async function startTestCluster(prefix = "rvtt-cluster-"): Promise<TestCluster> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const given: string[] = [];
  const cluster = new Cluster({
    binDir: join(postgresDir(), "bin"),
    pgData: join(dir, "postgres"),
    logFile: join(dir, "postgres.log"),
    password: "test-password-0123456789abcdef",
    platform: Platform.parse(process.platform),
    pgPath: (path) => {
      given.push(path);
      return path;
    },
  });
  await cluster.init();
  await cluster.start();
  const pools: pg.Pool[] = [];
  return {
    cluster,
    dir,
    given,
    pool(database = "postgres") {
      const p = new pg.Pool({ connectionString: cluster.url(database), max: 4 });
      p.on("error", () => undefined);
      pools.push(p);
      return p;
    },
    async stop() {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      await cluster.stop().catch(() => undefined);
      await removeStopped(cluster, dir);
    },
  };
}
