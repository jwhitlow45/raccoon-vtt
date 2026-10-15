import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { AssetService } from "../server/assets/service.ts";
import { revokeGrants } from "../server/auth/grants.ts";
import { DM_COLOR, HttpError, Name } from "../server/auth/http.ts";
import { PasswordHasher, passwordProblem } from "../server/auth/passwords.ts";
import { storePlayerPassword } from "../server/auth/playerSecret.ts";
import { dmLink, formatRoomId, parseRoomId } from "../server/auth/roomId.ts";
import { createRoomRecord, replaceDmKey } from "../server/auth/roomRecords.ts";
import { loadConfig } from "../server/config.ts";
import { listRoomsForAdmin } from "../server/http/admin.ts";
import { printable } from "../server/printable.ts";
import { applySchema, closePool, getPool } from "../server/db.ts";
import { DirectGateway, RoomNotFoundError } from "../server/rooms/gateway.ts";
import { importRoom } from "../server/rooms/importRoom.ts";
import { playerLink } from "../shared/playerLink.ts";

/**
 * Server admin commands (design section 10.2). In production:
 *
 *   docker compose -f docker-compose.server.yml exec raccoon node scripts/admin.ts <command>
 *
 * `hash-password` needs no database, so it also runs in a container of its
 * own before the admin page exists:
 *
 *   docker compose -f docker-compose.server.yml run --rm --no-deps raccoon node scripts/admin.ts hash-password
 *
 * Reads DATABASE_URL, and PUBLIC_ORIGIN to print full links when it is set.
 *
 * This process has no room actor and no sockets, so it writes room state
 * through DirectGateway. Open sockets learn of a removed grant at their next
 * recheck instead (within 60 s, design section 10.2).
 */
const USAGE = `Usage: node scripts/admin.ts <command>

  dm-link <roomId>                 replace the DM link and print the new one
  list-rooms                       every room with last activity and size
  create-room <name> <dmName>      create a room, bypassing the creation limits
  pin <roomId>                     never unload this room to make space
  unpin <roomId>                   undo pin
  import <file.zip> [dmName]       restore a room export too big for the site's upload limit
  hash-password                    make the ADMIN_PASSWORD_HASH line for .env, which turns on /admin`;

// Crockford base32 again, for a generated password a person can read aloud.
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function generatedPassword(): string {
  // 15 characters of base32 are 75 bits, far past any guessing the join
  // limits allow, in three groups so it can be typed on a phone.
  const chars = Array.from(randomBytes(15), (b) => ALPHABET[b % 32]).join("");
  return `${chars.slice(0, 5)}-${chars.slice(5, 10)}-${chars.slice(10)}`;
}

/** The admin page's password (docs/design-v1-dm-tools.md 3.18): longer than a player password, since it guards the whole server. */
const ADMIN_PASSWORD_MIN = 16;

/**
 * Asks twice without echoing, or makes one when the first answer is empty,
 * and prints the hash as a line for .env. Single quotes, because the hash
 * is full of `$` signs, which Compose would otherwise read as variables.
 */
async function hashPassword(): Promise<void> {
  const ask = await quietPrompt();
  try {
    let password = await ask(`Admin password (${ADMIN_PASSWORD_MIN} or more characters, or press Enter to make one): `);
    if (password === "") {
      password = generatedAdminPassword();
      console.log(`Your admin password is: ${password}`);
      console.log("Keep it in a password manager. It is not shown again.");
    } else {
      const problem = adminPasswordProblem(password);
      if (problem) throw new UsageError(problem);
      if ((await ask("Again: ")) !== password) throw new UsageError("The two passwords differ. Nothing was made.");
    }
    const hash = await new PasswordHasher().hash(password);
    console.log("");
    console.log("Add this line to .env, then run docker compose -f docker-compose.server.yml up -d:");
    console.log(`ADMIN_PASSWORD_HASH='${hash}'`);
  } finally {
    ask.close();
  }
}

function adminPasswordProblem(password: string): string | null {
  if ([...password].length < ADMIN_PASSWORD_MIN) return `The admin password needs ${ADMIN_PASSWORD_MIN} or more characters.`;
  if (passwordProblem(password) === "too_common") return "That password is on the list of common passwords. Choose another.";
  if (passwordProblem(password) === "too_long") return "That password is too long. 128 characters at most.";
  return null;
}

function generatedAdminPassword(): string {
  // 30 characters of base32 are 150 bits, in groups of five so it can be typed.
  const chars = Array.from(randomBytes(30), (b) => ALPHABET[b % 32]).join("");
  return chars.match(/.{5}/g)!.join("-");
}

/**
 * Reads answers from the terminal with nothing echoed back. A piped stdin
 * (a script or a test) has no echo to hide, and is read line by line.
 */
async function quietPrompt(): Promise<((question: string) => Promise<string>) & { close(): void }> {
  const tty = Boolean(process.stdin.isTTY);
  const silent = new Writable({ write: (_chunk, _encoding, done) => done() });
  const rl = createInterface({ input: process.stdin, output: tty ? silent : undefined, terminal: tty });
  const lines = tty ? null : rl[Symbol.asyncIterator]();
  const ask = async (question: string): Promise<string> => {
    process.stdout.write(question);
    let answer: string;
    if (lines) {
      const next = await lines.next();
      answer = next.done ? "" : String(next.value);
    } else {
      answer = await rl.question("");
    }
    process.stdout.write("\n");
    return answer;
  };
  return Object.assign(ask, { close: () => rl.close() });
}

function fullLink(path: string): string {
  const origin = process.env.PUBLIC_ORIGIN;
  return origin ? `${origin}${path}` : path;
}

function roomArg(value: string | undefined): string {
  const id = parseRoomId(value);
  if (!id) throw new UsageError(`Not a room ID: ${value ?? "(missing)"}`);
  return id;
}

class UsageError extends Error {}

const NAME_RULE = "Names are 1 to 80 characters, with no control or text direction characters.";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

async function main(args: string[]): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "help" || command === "--help") {
    console.log(USAGE);
    return;
  }
  if (command === "hash-password") {
    await hashPassword();
    return;
  }
  try {
    process.loadEnvFile(".env.local");
  } catch {
    // Production passes the environment directly.
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new UsageError("DATABASE_URL is not set.");
  const pool = getPool(databaseUrl);
  await applySchema(pool);
  const gateway = new DirectGateway(pool);

  try {
    switch (command) {
      case "dm-link": {
        const roomId = roomArg(rest[0]);
        // The same replacement as the site's, with no device kept: every DM
        // grant goes, every DM member becomes a player, every invite dies.
        let key = "";
        await revokeGrants({ pool, gateway }, roomId, { by: "role", role: "dm" }, async (tx) => {
          key = (await replaceDmKey(tx, roomId)).key;
        });
        console.log(`New DM link for ${formatRoomId(roomId)}. Every other DM device is signed out.`);
        console.log(fullLink(dmLink(roomId, key)));
        break;
      }
      case "list-rooms": {
        // Size counts what the quota counts (design section 10.5): asset
        // bytes plus the room's rows. The admin page lists the same numbers.
        const rows = await listRoomsForAdmin(pool);
        if (rows.length === 0) console.log("No rooms.");
        for (const r of rows) {
          const pin = r.pinned ? "  pinned" : "";
          const size = formatBytes(r.bytes).padStart(10);
          // Room names come from strangers, so they are printed escaped.
          console.log(`${formatRoomId(r.id)}  ${r.lastActiveAt}  ${size}  ${printable(r.name)}${pin}`);
        }
        break;
      }
      case "create-room": {
        const [rawName, rawDmName] = rest;
        // The site's own name rule, so a room made here never holds a name its backup could not be imported with.
        const name = Name.safeParse(rawName ?? "");
        const dmName = Name.safeParse(rawDmName ?? "");
        if (!name.success || !dmName.success) throw new UsageError(NAME_RULE);
        // The site's key, so the DM can show this room's player link later.
        const { roomSecretKey } = loadConfig();
        const password = generatedPassword();
        const playerPwHash = await new PasswordHasher().hash(password);
        // No creation limits and no rate rows: this is how the server owner
        // gets a room even when strangers have used up the day's count.
        const room = await createRoomRecord(
          { pool, gateway },
          { name: name.data, playerPwHash, dmName: dmName.data, dmColor: DM_COLOR, createdIp: null },
          (tx, created) => storePlayerPassword(tx, roomSecretKey, created.roomId, password),
        );
        console.log(`Room ${formatRoomId(room.roomId)}`);
        console.log(`Player password: ${password}`);
        console.log(`Player link: ${fullLink(playerLink(room.roomId, password))}`);
        console.log(`DM link: ${fullLink(dmLink(room.roomId, room.dmKey))}`);
        break;
      }
      case "import": {
        const [file, rawDmName = "Dungeon Master"] = rest;
        if (!file) throw new UsageError("import needs the path of a room export zip.");
        const parsedDmName = Name.safeParse(rawDmName);
        if (!parsedDmName.success) throw new UsageError(NAME_RULE);
        const dmName = parsedDmName.data;
        // The same pipeline as the site's import (design 16.4), without the
        // HTTP body cap: the file is already on the volume.
        const config = loadConfig();
        // A temporary folder of its own on the image volume: this runs
        // beside the live server, whose startup would otherwise be repeated
        // here and clear the uploads it has in flight.
        const tmpRoot = join(resolve(config.ASSET_DIR), "tmp");
        await mkdir(tmpRoot, { recursive: true });
        const tmpDir = await mkdtemp(join(tmpRoot, "cli-"));
        const assets = new AssetService({ pool, config, tmpDir });
        await assets.init();
        try {
          const password = generatedPassword();
          const playerPwHash = await new PasswordHasher().hash(password);
          const log = { info: () => undefined, debug: () => undefined, warn: console.warn, error: console.error };
          const room = await importRoom(
            { pool, assets, gateway, log },
            resolve(file),
            { playerPwHash, dmName, dmColor: DM_COLOR, createdIp: null },
            { afterImages: (tx, created) => storePlayerPassword(tx, config.roomSecretKey, created.roomId, password) },
          );
          console.log(`Imported room ${formatRoomId(room.roomId)}`);
          console.log(`Player password: ${password}`);
          console.log(`Player link: ${fullLink(playerLink(room.roomId, password))}`);
          console.log(`DM link: ${fullLink(dmLink(room.roomId, room.dmKey))}`);
        } finally {
          await assets.close();
          await rm(tmpDir, { recursive: true, force: true });
        }
        break;
      }
      case "pin":
      case "unpin": {
        const roomId = roomArg(rest[0]);
        const { rowCount } = await pool.query("update rooms set pinned = $2 where id = $1", [roomId, command === "pin"]);
        if (rowCount !== 1) throw new UsageError(`No room ${formatRoomId(roomId)}.`);
        console.log(`${command === "pin" ? "Pinned" : "Unpinned"} ${formatRoomId(roomId)}.`);
        break;
      }
      default:
        throw new UsageError(`Unknown command: ${command}\n\n${USAGE}`);
    }
  } finally {
    await closePool();
  }
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError || err instanceof RoomNotFoundError) {
    console.error(err.message);
    process.exitCode = 2;
  } else if (err instanceof HttpError) {
    // The detail can quote the file being imported, which nobody vetted.
    console.error(`Import refused: ${err.code}${err.extra ? ` ${printable(JSON.stringify(err.extra))}` : ""}`);
    process.exitCode = 2;
  } else {
    console.error(err);
    process.exitCode = 1;
  }
}
