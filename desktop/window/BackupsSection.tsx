import { useEffect, useState } from "react";
import { Button } from "../../client/components/Button.tsx";
import { Loading } from "../../client/components/Loading.tsx";
import { theme } from "../../client/lib/theme.ts";
import { WORDS, type BackupSummary, type RaccoonLocal, type SupervisorStatus } from "../contract.ts";
import { formatDate, formatWhen } from "./format.ts";
import { ButtonRow, Card, Confirm, Help, useAction } from "./ui.tsx";
import { backupKindLabel, failureText, restorable, restoring } from "./view.ts";

/** Backups (design 8.2, 8.3 and 9, item 5): the last one, Back up now, the list with Restore each, and the folder. */
export function BackupsSection(props: { sup: SupervisorStatus; bridge: RaccoonLocal; now: Date }) {
  const { sup, bridge } = props;
  const blocked = restoring(sup);
  const [backups, setBackups] = useState<BackupSummary[] | null>(null);
  const [listFailure, setListFailure] = useState<string | null>(null);
  const [asking, setAsking] = useState<BackupSummary | null>(null);
  const [restoringName, setRestoringName] = useState<string | null>(null);

  // A new backup, a restore's end and the server coming back each change the list, so each lists it again.
  useEffect(() => {
    if (blocked) return;
    let live = true;
    setListFailure(null);
    bridge
      .listBackups()
      .then((result) => {
        if (!live) return;
        if (result.ok) setBackups(result.value.backups);
        else if (result.failure.error === "notRunning") setBackups(null);
        else setListFailure(failureText(result.failure, "backup"));
      })
      .catch(() => live && setListFailure("RaccoonVTT did not answer. Try again."));
    return () => void (live = false);
  }, [bridge, blocked, sup.lastBackup, sup.state === "running", sup.notice?.seq]);

  const backUp = useAction(async () => {
    const result = await bridge.backupNow();
    return result.ok ? null : failureText(result.failure, "backup");
  });
  const restore = useAction(async (name: string) => {
    const result = await bridge.restore(name);
    return result.ok ? null : failureText(result.failure, "restore");
  });
  const backingUp = backUp.busy || sup.backingUp;
  const list = backups ? restorable(backups) : null;

  return (
    <Card id="backups" title={WORDS.backups.heading}>
      <Help>{sup.lastBackup ? WORDS.backups.last(formatWhen(sup.lastBackup, props.now)) : WORDS.backups.none}</Help>
      <ButtonRow>
        <Button disabled={blocked} busy={backingUp} onClick={() => void backUp.start()} aria-describedby={blocked ? "backups-blocked" : undefined}>
          {backingUp ? WORDS.backups.backingUp : WORDS.backups.backUpNow}
        </Button>
      </ButtonRow>
      {blocked ? <Help>{<span id="backups-blocked">{WORDS.notDuringRestore}</span>}</Help> : null}
      {backUp.error ? <Help role="alert" tone="danger">{backUp.error}</Help> : null}
      {listFailure ? <Help role="alert" tone="danger">{listFailure}</Help> : null}
      {list === null && !listFailure && !blocked && sup.state === "running" ? <Loading text="Loading backups" small /> : null}
      {list && list.length > 0 ? (
        <ul data-backups="" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid" }}>
          {list.map((b, i) => (
            <li
              key={b.name}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: theme.space(3),
                padding: `${theme.space(2)}px 0`,
                borderTop: i === 0 ? "none" : `${theme.line.border}px solid ${theme.color.border}`,
              }}
            >
              <div style={{ flex: "1 1 0", minWidth: 0, display: "grid", gap: 2 }}>
                <span style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong, lineHeight: theme.leading.tight, overflowWrap: "anywhere" }}>{formatWhen(b.started, props.now)}</span>
                <span style={{ fontSize: theme.font.small, color: theme.color.textMuted }}>{backupKindLabel(b)}</span>
              </div>
              <Button size="sm" disabled={blocked} busy={restore.busy && restoringName === b.name} aria-label={`${WORDS.backups.restore}, ${formatWhen(b.started, props.now)}`} onClick={() => (restore.busy ? undefined : setAsking(b))}>
                {WORDS.backups.restore}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {restore.error ? <Help role="alert" tone="danger">{restore.error}</Help> : null}
      <ButtonRow>
        <Button size="sm" onClick={() => void bridge.openFolder("backups")}>
          {WORDS.backups.showFolder}
        </Button>
      </ButtonRow>
      {asking ? (
        <Confirm
          name={WORDS.backups.restore}
          question={WORDS.backups.confirm(formatDate(asking.started, props.now))}
          confirm={WORDS.backups.restore}
          danger
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            const backup = asking;
            setAsking(null);
            setRestoringName(backup.name);
            void restore.start(backup.name);
          }}
        />
      ) : null}
    </Card>
  );
}
