import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * Every environment variable the server reads, validated once at boot.
 *
 * A misconfiguration fails here, before the server listens, rather than
 * halfway through a session. Production refuses to start without the values
 * that its security depends on (design section 15.5): an exact public origin
 * for the WebSocket Origin check and CSRF, both egress proxies, so no
 * outbound request can ever go direct, and the key that keeps each room's
 * player password readable for its DM.
 */
/** Compose passes an unset variable as an empty string, which means the same as leaving it out. */
function emptyAsUnset<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === "" ? undefined : v), schema);
}

const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default("127.0.0.1"),
  DATABASE_URL: z.string().min(1),
  PUBLIC_ORIGIN: z.string().url().optional(),
  ASSET_DIR: z.string().default(".data/assets"),
  /**
   * A folder on the disk that holds the database, for the log archive's
   * free-disk floor (server/assets/quota.ts hasFreeDisk). Unset, the archive
   * checks ASSET_DIR's disk, which is right while the two share one.
   */
  DATABASE_DISK_DIR: emptyAsUnset(z.string().optional()),
  TRUST_CF_CONNECTING_IP: z.enum(["0", "1"]).default("0"),
  SERPAPI_KEY: z.string().optional(),
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET: z.string().optional(),
  EGRESS_STRICT_PROXY: z.string().url().optional(),
  EGRESS_PUBLIC_PROXY: z.string().url().optional(),
  ROOMS_PER_IP_PER_DAY: z.coerce.number().int().positive().default(5),
  ROOMS_PER_DAY: z.coerce.number().int().positive().default(20),
  ROOM_QUOTA_MB: z.coerce.number().int().positive().default(1024),
  ROOM_SECRET_KEY: z.string().optional(),
  /**
   * The admin page's password as an argon2id hash (docs/design-v1-dm-tools.md
   * 3.18), made by `node scripts/admin.ts hash-password`. Unset or empty,
   * there is no admin page: /admin is not found and every /api/admin route
   * answers 404.
   */
  ADMIN_PASSWORD_HASH: emptyAsUnset(z.string().regex(/^\$argon2id\$/, "must be an argon2id hash from: node scripts/admin.ts hash-password").optional()),
  /**
   * An Openverse registration (section 3.13), for 40 results a search and a
   * larger daily budget. Unset, searches are anonymous.
   */
  OPENVERSE_CLIENT_ID: emptyAsUnset(z.string().max(200).optional()),
  OPENVERSE_CLIENT_SECRET: emptyAsUnset(z.string().max(500).optional()),
});

export type Config = z.infer<typeof Env> & {
  production: boolean;
  publicOrigin: string;
  /** AES-256-GCM key for the stored player passwords (server/auth/playerSecret.ts). */
  roomSecretKey: Buffer;
};

/**
 * The key development and tests run with when ROOM_SECRET_KEY is unset.
 * Anyone can read it here, so it protects nothing, which is fine for a
 * laptop's own database. Production refuses to start without its own key.
 */
const DEVELOPMENT_ROOM_SECRET_KEY = createHash("sha256").update("raccoon-vtt development room secret key").digest();

const KEY_HINT = "32 random bytes in base64, made with: openssl rand -base64 32";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid environment:\n${z.prettifyError(parsed.error)}`);
  }
  const c = parsed.data;
  const production = c.NODE_ENV === "production";
  if (production) {
    const missing = (["PUBLIC_ORIGIN", "EGRESS_STRICT_PROXY", "EGRESS_PUBLIC_PROXY", "ROOM_SECRET_KEY"] as const).filter((k) => !c[k]);
    if (missing.length > 0) {
      const hint = missing.includes("ROOM_SECRET_KEY") ? ` ROOM_SECRET_KEY is ${KEY_HINT}.` : "";
      throw new Error(`Refusing to start in production without ${missing.join(", ")}.${hint}`);
    }
  }
  // Turnstile needs the site key in the page and the secret on the server.
  // Either one alone would refuse every room creation as a failed check.
  if (Boolean(c.TURNSTILE_SITE_KEY) !== Boolean(c.TURNSTILE_SECRET)) {
    throw new Error("Set both TURNSTILE_SITE_KEY and TURNSTILE_SECRET, or neither.");
  }
  // A registration needs both halves to get a token. One alone would fail every search Openverse answers.
  if (Boolean(c.OPENVERSE_CLIENT_ID) !== Boolean(c.OPENVERSE_CLIENT_SECRET)) {
    throw new Error("Set both OPENVERSE_CLIENT_ID and OPENVERSE_CLIENT_SECRET, or neither.");
  }
  // Development serves the SPA through Vite on 5173, which proxies to this
  // server, so that is the origin a browser presents.
  const publicOrigin = c.PUBLIC_ORIGIN === undefined ? "http://localhost:5173" : originOf(c.PUBLIC_ORIGIN);
  // The key's text is dropped once decoded, so nothing that prints the
  // config can print it.
  const { ROOM_SECRET_KEY: keyText, ...rest } = c;
  const roomSecretKey = keyText ? secretKeyOf(keyText) : DEVELOPMENT_ROOM_SECRET_KEY;
  return { ...rest, production, publicOrigin, roomSecretKey };
}

/**
 * Node's base64 decoder skips characters it does not know, so a pasted key
 * with a stray character would quietly become a different, shorter key.
 * The text is checked first, and the decoded length after.
 */
function secretKeyOf(value: string): Buffer {
  const text = value.trim();
  const key = /^[A-Za-z0-9+/]+={0,2}$/.test(text) ? Buffer.from(text, "base64") : Buffer.alloc(0);
  if (key.length !== 32) throw new Error(`ROOM_SECRET_KEY must be ${KEY_HINT}.`);
  return key;
}

/**
 * The WebSocket and CSRF checks compare the browser's `Origin` header with
 * this exactly, and a browser sends a bare origin: scheme, host and port,
 * no trailing slash. So `https://vtt.example.com/` is normalized to that,
 * while a path, query or credentials mean the value is not an origin at all
 * and would refuse every socket, so they stop the boot instead.
 */
function originOf(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`PUBLIC_ORIGIN must be http or https, not ${url.protocol}`);
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "") {
    throw new Error(`PUBLIC_ORIGIN must be an origin like https://vtt.example.com, with no path: got ${value}`);
  }
  return url.origin;
}
