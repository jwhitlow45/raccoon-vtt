import { useMemo, useState } from "react";
import type { LogEntry } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { Empty } from "../../components/Empty.tsx";
import { theme } from "../../lib/theme.ts";
import { useRoomView } from "../../state/view.ts";
import { describeEvent, type LogNames } from "../log/format.ts";
import { useSend, useYou } from "./hooks.ts";
import { canTakeBack, fightHpLines, type HpLine } from "./hpLog.ts";

const EMPTY: LogEntry[] = [];
/** Lines shown before "Show all", so the tracker stays about the turn order. */
const FIRST_LINES = 6;

/**
 * The fight's HP changes, newest first (features section 10): "Goblin 2
 * takes 7 damage, 3/7 left." The DM can take any of them back while the
 * creature is as that change left it.
 */
export function HpLog() {
  const you = useYou();
  const log = useRoomView((s) => s.view?.log ?? EMPTY);
  const members = useRoomView((s) => s.view?.members);
  const tokens = useRoomView((s) => s.view?.tokens);
  const characters = useRoomView((s) => s.view?.characters);
  const handouts = useRoomView((s) => s.view?.handouts);
  const encounter = useRoomView((s) => s.view?.encounter ?? null);
  const [all, setAll] = useState(false);
  const names = useMemo<LogNames>(
    () => ({ members: members ?? {}, tokens: tokens ?? {}, characters: characters ?? {}, handouts: handouts ?? {}, encounter }),
    [members, tokens, characters, handouts, encounter],
  );
  const lines = useMemo(() => fightHpLines(log), [log]);
  if (lines.length === 0) return <Empty>No HP changes yet this fight.</Empty>;
  const shown = all ? lines : lines.slice(0, FIRST_LINES);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
      <ol aria-label="HP changes this fight" style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(1) }}>
        {shown.map((line) => (
          <HpLogLine key={line.entry.id} line={line} names={names} dm={you.role === "dm"} canUndo={you.role === "dm" && canTakeBack(names, log, line)} />
        ))}
      </ol>
      {lines.length > FIRST_LINES ? (
        <div>
          <Button size="sm" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `Show all ${lines.length}`}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function HpLogLine(props: { line: HpLine; names: LogNames; dm: boolean; canUndo: boolean }) {
  const { line } = props;
  return (
    <li style={{ display: "flex", alignItems: "center", gap: theme.space(2), minHeight: theme.touch, color: line.data.back ? theme.color.textMuted : theme.color.text }}>
      <span style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>{describeEvent(line.data, props.names)}</span>
      {props.canUndo ? <TakeBack logId={line.entry.id} /> : null}
    </li>
  );
}

/** The DM's undo of one HP change from the log. An undo always waits for the server, which answers with a toast. */
export function TakeBack(props: { logId: string }) {
  const { send, waiting } = useSend();
  return (
    <Button size="sm" icon="undo" iconOnly="always" aria-label="Undo this change" busy={waiting} onClick={() => send({ t: "undo", log: props.logId })} style={{ flex: "none" }}>
      Undo
    </Button>
  );
}
