import { closeSync, readdirSync, readlinkSync } from "node:fs";
import type { Platform } from "../contract.ts";

/** This process's open descriptors as /proc/self/fd shows them, which tests replace. */
export type FdTable = {
  list(): string[];
  /** What the descriptor is, as its /proc/self/fd link reads ("socket:[123]"), or null when it can't be read. */
  target(fd: number): string | null;
  close(fd: number): void;
};

const procFds: FdTable = {
  list: () => readdirSync("/proc/self/fd"),
  target: (fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`);
    } catch {
      return null;
    }
  },
  close: (fd) => closeSync(fd),
};

/**
 * Closes, on Linux, every socket this process inherited beyond its
 * standard streams and its IPC channel to the shell (fd 3), before it
 * starts anything. Node's spawn on Linux leaves open in its child every
 * descriptor its parent has without close-on-exec, and the shell's
 * Chromium makes its Mojo channels to its renderers so. A renderer ends
 * once the other end of its channel closes, so a copy here, and in every
 * process this one starts after, kept a shell killed outright's renderer
 * running as long as the supervisor and PostgreSQL ran (a Linux run showed
 * one past 30 s). The supervisor opens no socket of its own before this
 * runs. macOS's spawn closes them itself (POSIX_SPAWN_CLOEXEC_DEFAULT), and
 * Windows hands on only the handles a spawn names. Answers the descriptors
 * it closed.
 */
export function closeInheritedSockets(platform: Platform, fds: FdTable = procFds): number[] {
  if (platform !== "linux") return [];
  const closed: number[] = [];
  for (const name of fds.list()) {
    const fd = Number(name);
    if (!Number.isInteger(fd) || fd <= 3 || !fds.target(fd)?.startsWith("socket:")) continue;
    try {
      fds.close(fd);
      closed.push(fd);
    } catch {
      // Closed since the listing: nothing to do.
    }
  }
  return closed;
}
