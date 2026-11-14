import { Button } from "../../client/components/Button.tsx";
import { Notice } from "../../client/components/Notice.tsx";
import { WORDS, type RaccoonLocal, type ShellState } from "../contract.ts";
import { theme } from "../../client/lib/theme.ts";
import { Working, useAction, DID_NOT_ANSWER } from "./ui.tsx";

/** The page's one box padding (StatusSection BOX), so every notice's words start where a card's do. */
const PAD = { padding: theme.space(4) } as const;

/** The update banner (design 8.4 and 9, item 7) and the clock notice. */
export function UpdateBanner(props: { shell: ShellState; bridge: RaccoonLocal }) {
  const { update } = props.shell;
  const install = useAction(async () => {
    const result = await props.bridge.installUpdate();
    return result.ok ? null : WORDS.updates.failed(result.failure.error === "failed" ? result.failure.reason : DID_NOT_ANSWER);
  });
  const download = useAction(async () => {
    await props.bridge.openRelease();
    return null;
  });
  if (update.state === "none") return null;
  if (update.state === "downloading") {
    return (
      <Notice role="status" style={PAD}>
        <div style={{ display: "flex", alignItems: "center", gap: theme.space(3) }}>
          <Working active>{WORDS.updates.downloading(update.percent)}</Working>
          <progress aria-label={WORDS.updates.downloading(update.percent)} max={100} value={update.percent} style={{ flex: "1 1 60px", minWidth: 0, height: 8 }} />
        </div>
      </Notice>
    );
  }
  if (update.state === "stopping") {
    return (
      <Notice role="status" style={PAD}>
        <Working active>{WORDS.updates.stopping}</Working>
      </Notice>
    );
  }
  return (
    <Notice
      role="status"
      style={{ ...PAD, flexWrap: "wrap" }}
      action={
        update.install ? (
          <Button size="sm" variant="primary" busy={install.busy} onClick={() => void install.start()}>
            {WORDS.updates.install}
          </Button>
        ) : (
          <Button size="sm" variant="primary" busy={download.busy} onClick={() => void download.start()}>
            {WORDS.updates.download}
          </Button>
        )
      }
    >
      {WORDS.updates.banner(update.version)}
      {install.error ? <span role="alert" style={{ display: "block" }}>{install.error}</span> : null}
    </Notice>
  );
}

export function ClockNotice(props: { minutes: number | null }) {
  if (props.minutes === null) return null;
  return (
    <Notice tone="warning" role="status" style={PAD}>
      {WORDS.updates.clock(Math.abs(props.minutes))}
    </Notice>
  );
}
