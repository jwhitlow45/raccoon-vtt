import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { sendToShell, type ShellChannel } from "./shellChannel.ts";

const MODULE = new URL("./shellChannel.ts", import.meta.url).href;

/**
 * A child with an IPC channel that, once its parent closes the channel,
 * sends twice as the supervisor's statuses do mid-stop, then exits 0. An
 * uncaught error exits 3 and names its code.
 */
async function sendAfterClose(how: "sendToShell" | "process.send"): Promise<{ code: number | null; stderr: string }> {
  const send = how === "sendToShell" ? "sendToShell(process, { type: 'status' })" : "process.send({ type: 'status' })";
  const script = [
    `import { sendToShell } from ${JSON.stringify(MODULE)};`,
    "process.on('uncaughtException', (err) => { process.stderr.write(`uncaught ${err.code}`); process.exit(3); });",
    `process.on('disconnect', () => { ${send}; ${send}; setTimeout(() => process.exit(0), 300); });`,
    "process.send({ ready: true });",
    "setInterval(() => undefined, 1000);",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.once("message", () => child.disconnect());
  const code = await new Promise<number | null>((resolve) => child.once("exit", (c) => resolve(c)));
  return { code, stderr };
}

test("a send after the shell's channel closed is skipped quietly, where a plain send ends the process as uncaught", { timeout: 20_000 }, async () => {
  assert.deepEqual(await sendAfterClose("sendToShell"), { code: 0, stderr: "" });
  assert.deepEqual(await sendAfterClose("process.send"), { code: 3, stderr: "uncaught ERR_IPC_CHANNEL_CLOSED" }, "the supervisor's failure on a Linux runner");
});

test("a send goes out only on a connected channel, and an error it meets, at once or later, goes to its callback", () => {
  const sent: unknown[] = [];
  const open: ShellChannel = { connected: true, send: (message) => (sent.push(message), true) };
  sendToShell(open, 1);
  sendToShell({ ...open, connected: false }, 2);
  sendToShell({ connected: true }, 3);
  sendToShell({}, 4);
  assert.deepEqual(sent, [1], "only the connected channel sends");
  // Closed between the check and the send: Node hands the error to the callback, which is given, rather than emitting it.
  let given = false;
  sendToShell({ connected: true, send: (_message, callback) => ((given = typeof callback === "function"), callback(Object.assign(new Error("Channel closed"), { code: "ERR_IPC_CHANNEL_CLOSED" })), false) }, 5);
  assert.equal(given, true, "a callback goes with every send");
  assert.doesNotThrow(() =>
    sendToShell(
      {
        connected: true,
        send: () => {
          throw new Error("Channel closed");
        },
      },
      7,
    ),
  );
});
