import { randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { z } from "zod";
import type { Platform } from "../contract.ts";
import { writeDurable } from "./durable.ts";

/**
 * secrets.json (docs/design/design-v1-local-app.md 6.5): the room secret key,
 * which keeps each room's player password readable for its DM, and the
 * database password. Both are made once. Losing the key would hide every
 * DM's player links and a new password would lock the app out of its own
 * database, so a damaged file stops the start instead of being replaced.
 * Neither value reaches a log, the window or a backup.
 */

const SecretsFile = z.object({
  roomSecretKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "32 bytes in base64"),
  databasePassword: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Secrets = z.infer<typeof SecretsFile>;

export class SecretsDamaged extends Error {}

/**
 * `clusterExists` says the data folder already holds a database. Its
 * password is in secrets.json alone, so a missing file there stops the start
 * as a damaged one does, and nothing new is written: a new password could
 * never log in, and a new key would hide every player link.
 */
export async function loadSecrets(file: string, platform: Platform, clusterExists = false): Promise<Secrets> {
  let text: string | null = null;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (text === null && clusterExists) throw new SecretsDamaged("secrets.json can't be read");
  if (text === null) {
    const made: Secrets = { roomSecretKey: randomBytes(32).toString("base64"), databasePassword: randomBytes(32).toString("hex") };
    await writeDurable(file, `${JSON.stringify(made)}\n`, { mode: 0o600 });
    return made;
  }
  let parsed: Secrets;
  try {
    parsed = SecretsFile.parse(JSON.parse(text));
  } catch {
    throw new SecretsDamaged("secrets.json can't be read");
  }
  // A copy restored by hand may come back readable by others.
  if (platform !== "win32") await chmod(file, 0o600);
  return parsed;
}
