import { useEffect, useState } from "react";
import type { Trap, TrapDue } from "#shared/model.ts";
import { trapFill } from "../dice/groupSave/fills.ts";
import { ReplaceConfirm } from "../dice/groupSave/ReplaceConfirm.tsx";
import { useStartGroupSave, type StartInput } from "../dice/groupSave/start.ts";

/** The group save a springing starts (docs/design-v1-traps.md 4.4): its rows the creatures it hits, frozen when it went off, and Apply settles it. */
export function trapStart(trap: Trap, due: TrapDue): StartInput {
  return { source: { kind: "trap", trapId: trap.id, due: due.id, tokenIds: [...due.hits] }, ...trapFill(trap), panel: "dice" };
}

/**
 * Save and damage from a trap's card: starts the group save at once, or
 * asks first when the open one holds rolls (ReplaceConfirm), as an area's
 * does. One group save at a time.
 */
export function TrapSaveStart(props: { trap: Trap; due: TrapDue; onDone(): void }) {
  const start = useStartGroupSave();
  const [pending, setPending] = useState<StartInput | null>(null);
  useEffect(() => {
    const input = trapStart(props.trap, props.due);
    if (start(input)) props.onDone();
    else setPending(input);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pending) return null;
  return (
    <ReplaceConfirm
      onDiscard={() => {
        if (start(pending, { replace: true })) props.onDone();
      }}
      onKeep={props.onDone}
    />
  );
}
