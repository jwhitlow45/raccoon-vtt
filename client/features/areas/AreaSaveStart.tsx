import { useEffect, useMemo, useState } from "react";
import type { AreaTemplate } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { theme } from "../../lib/theme.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { pageTitle } from "../dice/groupSave/GroupSave.tsx";
import { areaFill } from "../dice/groupSave/fills.ts";
import { useStartGroupSave, type StartInput } from "../dice/groupSave/start.ts";
import { useGroupSave } from "../dice/groupSave/store.ts";
import { useDiceView } from "../dice/useDiceView.ts";
import { Note } from "../tokens/ui.tsx";
import { areaTitle } from "./labels.ts";

/**
 * An area's "Save and damage" (docs/design-v1-roll-options.md 5.6): starts
 * the group save with the area as its source, filled from the spell preset
 * whose name the area keeps and from its caster, or with No save for a
 * preset everyone takes. One group save at a time: one that holds rolls
 * is discarded only on the DM's word.
 */
export function AreaSaveStart(props: { template: AreaTemplate; onDone(): void }) {
  const { template, onDone } = props;
  const start = useStartGroupSave();
  const open = useGroupSave((s) => s.page);
  const creatures = useMemo<ActorTarget[]>(() => (template.casterId ? [{ tokenId: template.casterId }] : []), [template.casterId]);
  const { dice, loading } = useDiceView(creatures);
  const [pending, setPending] = useState<StartInput | null>(null);
  const input = useMemo<StartInput | null>(() => {
    // The caster's stat block gives the DC, so the fill waits for it, and a block that failed to load leaves the DC to the DM.
    if (!dice || loading) return null;
    const filled = areaFill(dice, template);
    const source = { kind: "area" as const, templateId: template.id };
    if (!filled) return { source, test: { kind: "save", ability: "dex" }, dc: null, fill: { name: areaTitle(template), from: `From ${areaTitle(template)}: no spell preset, so set the save and the damage.` }, panel: "areas" };
    return { source, ...filled, panel: "areas" };
  }, [dice, loading, template]);
  useEffect(() => {
    if (!input || pending) return;
    if (start(input)) onDone();
    else setPending(input);
  }, [input]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!pending) return <Note>Reading the area…</Note>;
  return (
    <div role="alert" style={{ display: "grid", gap: theme.space(2) }}>
      <span>{`Discard the ${open ? pageTitle(open) : "group save"}?`}</span>
      <div style={{ display: "flex", gap: theme.space(2) }}>
        <Button
          variant="danger"
          onClick={() => {
            start(pending, { replace: true });
            onDone();
          }}
        >
          Discard
        </Button>
        <Button onClick={onDone}>Keep it</Button>
      </div>
    </div>
  );
}
