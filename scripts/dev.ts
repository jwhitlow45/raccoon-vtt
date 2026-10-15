import { spawn, type ChildProcess } from "node:child_process";

/**
 * `pnpm dev`: the API server with --watch, and Vite for the client, in one
 * terminal. Vite proxies /api and /ws to the server (vite.config.ts), so the
 * browser sees a single origin, as it does in production.
 *
 * Reads .env.local if present, so DATABASE_URL and friends need no export.
 */
const children: ChildProcess[] = [];

function run(name: string, cmd: string, args: string[]): void {
  const child = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"], env: process.env });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited with ${code}`);
    for (const c of children) c.kill("SIGTERM");
    process.exit(code ?? 0);
  });
  children.push(child);
}

const envFile = [".env.local"].filter((f) => {
  try {
    process.loadEnvFile(f);
    return true;
  } catch {
    return false;
  }
});
if (envFile.length === 0) console.log("[dev] no .env.local found, using the process environment");

run("server", process.execPath, ["--watch", "--watch-preserve-output", "server/main.ts"]);
run("vite", "pnpm", ["exec", "vite"]);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const c of children) c.kill(signal);
  });
}
