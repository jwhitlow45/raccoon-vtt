import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { LOG_FILES, Platform, RESOURCES, RUNTIME_DIR } from "../../contract.ts";
import { dataPaths } from "../dataDir.ts";
import { Cluster, type Postmaster } from "../postgres.ts";

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
  await removeListed(dir, `the test cluster in ${dir}`, () => cluster.postmasters());
}

/**
 * Removes a supervisor's data folder once every supervisor on it has
 * stopped, and fails as removeStopped does (LA-35). A supervisor's stop
 * proves nothing about PostgreSQL: a test may have killed the supervisor,
 * and a stop that fails or overruns ends in a SIGKILL. The listing knows a
 * postmaster by the folder its command line names, the path the test gave
 * `--data`, so `given` holds each path a supervisor had for this folder.
 * On Windows, where a folder PostgreSQL can't open by its own path is given
 * through a junction (pgPaths.ts) the listing would miss, a postmaster
 * still running holds its files, and the removal fails instead.
 */
export async function removeSupervisorData(data: string, given: readonly string[] = [data]): Promise<void> {
  const clusters = [...new Set(given)].map((folder) => {
    const paths = dataPaths(folder);
    return new Cluster({ binDir: join(postgresDir(), "bin"), pgData: paths.postgres, logFile: join(paths.logs, LOG_FILES.postgres), password: "", platform: Platform.parse(process.platform) });
  });
  await removeListed(data, `the supervisor data folder ${data}`, async () => (await Promise.all(clusters.map((c) => c.postmasters()))).flat());
}

async function removeListed(dir: string, what: string, list: () => Promise<Postmaster[]>): Promise<void> {
  let failed: Error | null = null;
  try {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (err) {
    failed = err as Error;
  }
  let left: string[];
  try {
    left = (await list()).map((p) => `${p.pid} ${p.commandLine}`);
  } catch (err) {
    left = [`the listing failed: ${(err as Error).message}`];
  }
  if (failed === null && left.length === 0) return;
  const removal = failed === null ? "was removed" : `could not be removed (${failed.message})`;
  throw new Error(`${what} ${removal}${left.length > 0 ? `, and the listing still shows: ${left.join("; ")}` : ""}`);
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
