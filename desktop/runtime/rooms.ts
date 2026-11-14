import { execFile } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { RoomSummary, WINDOWS_KEPT_ENV, type Platform } from "../contract.ts";

/**
 * Rooms on this computer (docs/design/design-v1-local-app.md 8.6,
 * D-261113-068), through scripts/admin.ts as a child, with `--no-schema`, so
 * no `alter table` takes a lock during play, and `--json`. PUBLIC_ORIGIN is
 * this computer's own address, so a new DM link comes back whole for the
 * browser to open.
 */

export type AdminOptions = { node: string; appRoot: string; databaseUrl: string; port: number; platform: Platform };

const ListOutput = z.object({ rooms: z.array(RoomSummary) });
const LinkOutput = z.object({ link: z.string().startsWith("http://localhost:") });

function admin(opts: AdminOptions, args: string[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { DATABASE_URL: opts.databaseUrl, PUBLIC_ORIGIN: `http://localhost:${opts.port}` };
  if (opts.platform === "win32") for (const name of WINDOWS_KEPT_ENV) if (process.env[name] !== undefined) env[name] = process.env[name];
  return new Promise((resolve, reject) => {
    execFile(
      opts.node,
      [join(opts.appRoot, "scripts", "admin.ts"), "--no-schema", "--json", ...args],
      { cwd: opts.appRoot, env, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(stderr.trim().split(/\r?\n/).at(-1) || err.message));
        else resolve(stdout);
      },
    );
  });
}

export async function listRooms(opts: AdminOptions): Promise<RoomSummary[]> {
  return ListOutput.parse(JSON.parse(await admin(opts, ["list-rooms"]))).rooms;
}

export async function newDmLink(opts: AdminOptions, roomId: string): Promise<string> {
  return LinkOutput.parse(JSON.parse(await admin(opts, ["dm-link", roomId]))).link;
}
