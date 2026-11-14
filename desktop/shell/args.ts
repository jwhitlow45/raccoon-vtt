import { SHELL_ARGS } from "../contract.ts";

/** What this launch of the shell was asked to do (contract `SHELL_ARGS`). */
export type ShellArgs = {
  /** Open no browser, check no updates, and quit with code 0 once the supervisor runs (design 11.3). */
  smoke: boolean;
  /** Ask a running copy to quit, and start nothing (D-261113-099). */
  quit: boolean;
};

export function parseShellArgs(argv: readonly string[]): ShellArgs {
  return { smoke: argv.includes(SHELL_ARGS.smoke), quit: argv.includes(SHELL_ARGS.quit) };
}

/** What a second launch sends the running copy through the single-instance lock. */
export type SecondInstanceData = { quit: boolean };

/**
 * Whether a second launch asked the running copy to quit. Electron drops a
 * second instance's arguments when another user started it, as an installer
 * elevated by another administrator does, so the flag also travels in the
 * lock's additional data. Either one is enough.
 */
export function secondInstanceWantsQuit(argv: readonly string[], additionalData: unknown): boolean {
  if (argv.includes(SHELL_ARGS.quit)) return true;
  return typeof additionalData === "object" && additionalData !== null && (additionalData as Record<string, unknown>).quit === true;
}
