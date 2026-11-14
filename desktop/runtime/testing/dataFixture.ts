import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import pg from "pg";
import { variantPath } from "../../../server/assets/store.ts";
import { ROOT } from "./cluster.ts";

/**
 * Rooms with images for the backup and restore tests. Rooms come from
 * scripts/admin.ts create-room, as an operator makes them, and images are
 * asset rows with random bytes under their real paths: the backup and the
 * restore copy by name and length and never look inside.
 */

const run = promisify(execFile);

export async function createRoom(databaseUrl: string, name: string): Promise<string> {
  const { stdout } = await run(process.execPath, [join(ROOT, "scripts", "admin.ts"), "create-room", name, "DM"], {
    cwd: ROOT,
    env: { PATH: process.env.PATH ?? "", DATABASE_URL: databaseUrl },
  });
  const id = /Room (\w{4})-(\w{4})/.exec(stdout);
  if (!id) throw new Error(`create-room said: ${stdout}`);
  return `${id[1]}${id[2]}`;
}

/** One map image with two variants, its row and its files. Answers the files' paths below assets/. */
export async function addImage(databaseUrl: string, assetsDir: string, roomId: string, hex = randomBytes(32).toString("hex")): Promise<string[]> {
  const variants = ["full", "thumb"] as const;
  const paths: string[] = [];
  for (const variant of variants) {
    const file = variantPath(assetsDir, hex, "map", variant, 1);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, randomBytes(1000 + Math.floor(Math.random() * 1000)));
    paths.push(file.slice(assetsDir.length + 1).split("\\").join("/"));
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query(
      "insert into assets (id, room_id, sha256, kind, pipeline, width, height, bytes, variants) values ($1, $2, $3, 'map', 1, 100, 100, 2000, $4)",
      [randomUUID(), roomId, Buffer.from(hex, "hex"), [...variants]],
    );
  } finally {
    await client.end();
  }
  return paths;
}

/** The URL of a supervisor's own database, from its data folder: the password in secrets.json, the port in postmaster.pid. */
export async function supervisorDbUrl(dataDir: string, database = "raccoon"): Promise<string> {
  const secrets = JSON.parse(await readFile(join(dataDir, "secrets.json"), "utf8")) as { databasePassword: string };
  const port = (await readFile(join(dataDir, "postgres", "postmaster.pid"), "utf8")).split(/\r?\n/)[3];
  return `postgres://raccoon:${secrets.databasePassword}@127.0.0.1:${port}/${database}`;
}

export async function query<T extends pg.QueryResultRow>(url: string, sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: url });
  client.on("error", () => undefined);
  await client.connect();
  try {
    return (await client.query<T>(sql, params)).rows;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function roomNames(url: string): Promise<string[]> {
  return (await query<{ name: string }>(url, "select name from rooms order by name")).map((r) => r.name);
}

/** The three databases a restore names, and the comment each carries. */
export async function restoreDatabases(url: string): Promise<Record<string, string | null>> {
  const rows = await query<{ datname: string; comment: string | null }>(
    url,
    "select datname, shobj_description(oid, 'pg_database') as comment from pg_database where datname in ('raccoon', 'raccoon_before_restore', 'raccoon_restoring') order by datname",
  );
  return Object.fromEntries(rows.map((r) => [r.datname, r.comment]));
}

/** Every image file the asset rows of `raccoon` name that is not in assets/. */
export async function missingImages(url: string, assetsDir: string): Promise<string[]> {
  const rows = await query<{ sha256: Buffer; variants: string[] }>(url, "select sha256, variants from assets");
  const missing: string[] = [];
  for (const row of rows) {
    for (const variant of row.variants) {
      const file = variantPath(assetsDir, row.sha256.toString("hex"), "map", variant as "full", 1);
      try {
        await stat(file);
      } catch {
        missing.push(file);
      }
    }
  }
  return missing;
}
