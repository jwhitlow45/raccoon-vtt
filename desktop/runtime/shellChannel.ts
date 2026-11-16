/** The parts of a process's IPC channel to the shell that sending uses, so tests can stand in for one. */
export type ShellChannel = {
  readonly connected?: boolean;
  send?: (message: unknown, callback: (error: Error | null) => void) => boolean;
};

/**
 * Sends a message to the shell, and does nothing once the channel has
 * closed, as it has when the shell was killed outright and the supervisor
 * is stopping. Node reports a send on a closed channel by emitting 'error'
 * on the process a tick later, which no try catches, so a status sent
 * mid-stop would end the supervisor as an uncaught error. The callback
 * takes that error instead, for a channel that closes between the check
 * and the send. The disconnect handler logs the close, once, and stops
 * everything.
 */
export function sendToShell(channel: ShellChannel, message: unknown): void {
  if (!channel.send || !channel.connected) return;
  try {
    channel.send(message, () => undefined);
  } catch {
    // Closed as it was sent: the disconnect handler stops everything.
  }
}
