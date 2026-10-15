/**
 * The sender's side of the X-card (docs/design-v1-dm-tools.md 3.11), as
 * plain functions so they run under node --test. XCardButton.tsx draws it.
 *
 * Only the device that tapped shows any of this. The card everyone sees,
 * the sender's included, comes from the server's message and carries no
 * sign of who sent it.
 */

export type SendState = { kind: "idle" } | { kind: "sending" } | { kind: "failed"; message: string };

/**
 * Why a tap did not go out. A 429 is the session's six taps an hour. A
 * request that never reached the app (no network, or the proxy in front of
 * it answering for it) says there is no connection. A merged tap is no
 * failure: the server answers 204, since the card is already showing.
 */
export function sendFailureText(err: unknown): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 429) return "Not sent. Try again in a moment.";
  if (status === undefined || status === 0 || status === 502 || status === 503 || status === 504) return "Not sent: no connection. Try again.";
  const message = (err as { message?: string } | null)?.message;
  return message ? `Not sent. ${message}` : "Not sent: no connection. Try again.";
}

/**
 * One tap on the X. Success folds the small card away and closes the Menu's
 * sheet, so the sender's screen shows the map under the shared card as every
 * other device does, and an open Menu never marks who tapped. A failure
 * keeps the sheet open with the reason on the X, for another try.
 */
export async function sendXcard(input: { post(): Promise<void>; closeSheet(): void; settle(state: SendState): void }): Promise<void> {
  try {
    await input.post();
  } catch (err) {
    input.settle({ kind: "failed", message: sendFailureText(err) });
    return;
  }
  input.settle({ kind: "idle" });
  input.closeSheet();
}
