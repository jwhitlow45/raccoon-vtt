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

export type TestCluster = {
  cluster: Cluster;
  dir: string;
  pool(database?: string): pg.Pool;
  stop(): Promise<void>;
};

export async function startTestCluster(prefix = "rvtt-cluster-"): Promise<TestCluster> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const cluster = new Cluster({
    binDir: join(postgresDir(), "bin"),
    pgData: join(dir, "postgres"),
    logFile: join(dir, "postgres.log"),
    password: "test-password-0123456789abcdef",
    platform: Platform.parse(process.platform),
  });
  await cluster.init();
  await cluster.start();
  const pools: pg.Pool[] = [];
  return {
    cluster,
    dir,
    pool(database = "postgres") {
      const p = new pg.Pool({ connectionString: cluster.url(database), max: 4 });
      p.on("error", () => undefined);
      pools.push(p);
      return p;
    },
    async stop() {
      await Promise.all(pools.map((p) => p.end().catch(() => undefined)));
      await cluster.stop().catch(() => undefined);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
