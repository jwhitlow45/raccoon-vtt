import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { LOG_FILES, LOG_KEEP, LOG_ROTATE_BYTES } from "../contract.ts";

/**
 * The shell's log, `logs/shell.log` in the data folder (design 8.1), rotated
 * at 10 MB with 5 kept like every other process's. The supervisor works the
 * data folder out and names it in its first status, so lines written before
 * then wait in memory, a bounded number of them.
 */
const EARLY_LINES = 500;

export class ShellLog {
  #dir: string | null = null;
  #early: string[] = [];
  readonly #now: () => Date;
  readonly #echo: ((line: string) => void) | null;

  /**
   * `echo` also gets every line as it is made. --smoke passes stderr, so a
   * run that stops before the supervisor names the data folder still says
   * why to whoever ran it.
   */
  constructor(now: () => Date = () => new Date(), echo: ((line: string) => void) | null = null) {
    this.#now = now;
    this.#echo = echo;
  }

  /** The logs folder, once the supervisor has named it. Writes the lines kept so far. */
  setDir(dir: string): void {
    if (this.#dir === dir) return;
    this.#dir = dir;
    const early = this.#early;
    this.#early = [];
    for (const line of early) this.#write(line);
  }

  info(message: string): void {
    this.#line("info", message);
  }

  error(message: string): void {
    this.#line("error", message);
  }

  #line(level: "info" | "error", message: string): void {
    // One line per entry, whatever the message holds, so the last line of
    // the file is always a whole entry.
    const line = `${this.#now().toISOString()} ${level} ${message.replace(/\r?\n/g, " | ")}\n`;
    this.#echo?.(line);
    if (this.#dir === null) {
      this.#early.push(line);
      if (this.#early.length > EARLY_LINES) this.#early.shift();
      return;
    }
    this.#write(line);
  }

  #write(line: string): void {
    const dir = this.#dir;
    if (dir === null) return;
    const file = join(dir, LOG_FILES.shell);
    try {
      mkdirSync(dir, { recursive: true });
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        // No file yet.
      }
      if (size > 0 && size + Buffer.byteLength(line) > LOG_ROTATE_BYTES) rotate(file);
      appendFileSync(file, line);
    } catch {
      // A log that cannot be written must never stop the app.
    }
  }
}

/** shell.log becomes shell.log.1, each older one moves up, and the sixth is dropped. */
export function rotate(file: string): void {
  rmSync(`${file}.${LOG_KEEP}`, { force: true });
  for (let i = LOG_KEEP - 1; i >= 1; i--) {
    try {
      renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    } catch {
      // That one does not exist yet.
    }
  }
  renameSync(file, `${file}.1`);
}
