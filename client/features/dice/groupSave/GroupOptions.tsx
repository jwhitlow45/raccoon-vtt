import { useMemo, useState } from "react";
import { d20Formula, type AdvantageSource } from "#shared/dice/formula.ts";
import { hitOf } from "#shared/dice/roll.ts";
import { ABILITY_KEYS, SKILL_KEYS, type AbilityKey, type SkillKey } from "#shared/model.ts";
import type { ActorTarget } from "#shared/protocol.ts";
import { ABILITY_NAMES as ABILITY_SHORT } from "#shared/statBlock.ts";
import { SKILLS } from "#shared/rules/skills.ts";
import { Button } from "../../../components/Button.tsx";
import { displayName } from "../../../lib/scene.ts";
import { useUnsavedInput, useUnsavedSince } from "../../../lib/sheetSwipe.ts";
import { theme } from "../../../lib/theme.ts";
import { useRoomView } from "../../../state/view.ts";
import { FieldRow, Note, NumberField, Section } from "../../tokens/ui.tsx";
import { creatureRolls } from "../creature.ts";
import { rollsOf } from "../logic.ts";
import { cutLabel, damageRolls, withExtra } from "../options.ts";
import { presetFor } from "../presets.ts";
import { useDicePanel, type PanelRoll } from "../useDicePanel.ts";
import { useDiceView } from "../useDiceView.ts";
import { useReceipt } from "../useReceipt.ts";
import { useRollBlocked } from "../useRollOption.ts";
import { pageTitle } from "./GroupSave.tsx";
import { useAutoInitiativeFor } from "../../encounter/AutoInitiative.tsx";
import { useStartGroupSave, type StartInput } from "./start.ts";
import { useGroupSave } from "./store.ts";
import type { GroupTest } from "./rows.ts";

/**
 * Several selected creatures (docs/design-v1-roll-options.md 4.4): a DC,
 * then one tap rolls a save or check for every monster and asks every
 * player's creature, opening the group save with its results coming in.
 * The attacks every selected block shares by name roll each with its own
 * bonus against an optional AC, and the hits' damage rolls in one line.
 */
export function GroupOptions(props: { tokenIds: readonly string[] }) {
  const view = useRoomView((s) => s.view);
  const panel = useDicePanel();
  const start = useStartGroupSave();
  const open = useGroupSave((s) => s.page);
  const blocked = useRollBlocked();
  const [dc, setDc] = useState<number | null>(null);
  // Only a tap below sends the DC, so a sheet's swipe springs back once one is typed (docs/design-v1-sheet-swipe.md 4.6). The page it starts takes the DC with it.
  useUnsavedInput(dc !== null);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [pending, setPending] = useState<StartInput | null>(null);
  const creatures = useMemo<ActorTarget[]>(() => props.tokenIds.map((tokenId) => ({ tokenId })), [props.tokenIds]);
  const { dice } = useDiceView(creatures);
  if (!view) return null;
  const names = props.tokenIds.map((id) => view.tokens[id]).filter((t) => t !== undefined).map((t) => displayName(t));
  const n = names.length;

  const go = (input: StartInput) => {
    if (!start(input)) setPending(input);
  };
  const quick = (test: GroupTest) => {
    const taken = panel.take(creatures);
    go({ source: { kind: "selection", tokenIds: [...props.tokenIds] }, test, dc, panel: "dice", rollNow: { sources: taken.sources, secret: taken.secret } });
  };

  return (
    <section aria-label="Group rolls" style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ fontSize: theme.font.input, fontWeight: theme.weight.strong }}>{n} selected</div>
      <Note>{names.join(", ")}</Note>
      {blocked ? <Note tone="info">{blocked}</Note> : null}
      {pending ? (
        <div role="alert" style={{ display: "flex", gap: theme.space(2), flexWrap: "wrap", alignItems: "center" }}>
          <span>{`Discard the ${open ? pageTitle(open) : "group save"}?`}</span>
          <Button
            variant="danger"
            onClick={() => {
              start(pending, { replace: true });
              setPending(null);
            }}
          >
            Discard
          </Button>
          <Button onClick={() => setPending(null)}>Keep it</Button>
        </div>
      ) : null}
      <FieldRow label="DC">
        <NumberField label="DC for the group" value={dc ?? undefined} min={1} max={50} nullable placeholder="None" onCommit={setDc} width={88} />
      </FieldRow>
      <QuickGrid label="Saves" n={n} disabled={blocked} onTap={(a) => quick({ kind: "save", ability: a })} words={(a) => `${ABILITY_SHORT[a]} save for ${n}`} />
      <QuickGrid label="Checks" n={n} disabled={blocked} onTap={(a) => quick({ kind: "check", ability: a })} words={(a) => `${ABILITY_SHORT[a]} check for ${n}`} />
      <Section title="Skills" fold={{ open: skillsOpen, onToggle: () => setSkillsOpen((o) => !o) }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: theme.space(1) }}>
          {SKILL_KEYS.map((s: SkillKey) => (
            <Button key={s} size="sm" disabled={blocked !== null} onClick={() => quick({ kind: "check", ability: SKILLS[s].ability, skill: s })}>
              {`${SKILLS[s].name} for ${n}`}
            </Button>
          ))}
        </div>
      </Section>
      <GroupInitiative tokenIds={props.tokenIds} blocked={blocked} />
      {dice ? <SharedAttacks tokenIds={props.tokenIds} blocked={blocked} /> : null}
      {/* Its rows follow the selection until the roll (5.1), so a creature selected or dropped after it opens counts. A quick tap above rolls the creatures it was tapped on. */}
      <Button onClick={() => go({ source: { kind: "selection", tokenIds: [...props.tokenIds], live: true }, test: { kind: "save", ability: "dex" }, dc, panel: "dice" })}>Set up a group save</Button>
    </section>
  );
}

function QuickGrid(props: { label: string; n: number; disabled: string | null; onTap(a: AbilityKey): void; words(a: AbilityKey): string }) {
  return (
    <div role="group" aria-label={props.label} style={{ display: "grid", gap: theme.space(1) }}>
      <div style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>{props.label}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: theme.space(1) }}>
        {ABILITY_KEYS.map((a) => (
          <Button key={a} size="sm" disabled={props.disabled !== null} title={props.disabled ?? undefined} onClick={() => props.onTap(a)}>
            {props.words(a)}
          </Button>
        ))}
      </div>
    </div>
  );
}

/**
 * The attacks every selected block has by name (4.4), each with its own
 * bonus and critical range, against an optional AC sent as the roll's AC,
 * never as a DC. "Roll damage for 4 hits" rolls each hit's damage, a
 * critical's dice doubled, in one line, which an HP entry offers as one
 * chip: one target takes the hits, so there is no Apply.
 */
function SharedAttacks(props: { tokenIds: readonly string[]; blocked: string | null }) {
  const creatures = useMemo<ActorTarget[]>(() => props.tokenIds.map((tokenId) => ({ tokenId })), [props.tokenIds]);
  const { dice } = useDiceView(creatures);
  const shared = useMemo(() => {
    if (!dice) return [];
    const lists = creatures.map((c) => ({ c, named: creatureRolls(dice, c)?.named.filter((r) => r.attack !== undefined) ?? [] }));
    const first = lists[0];
    if (!first) return [];
    return first.named.filter((r) => lists.every((l) => l.named.some((x) => x.name === r.name))).map((r) => ({ name: r.name, each: lists.map((l) => ({ creature: l.c, named: l.named.find((x) => x.name === r.name)! })) }));
  }, [dice, creatures]);
  if (!dice || shared.length === 0) return null;
  return (
    <div role="group" aria-label="Shared attacks" style={{ display: "grid", gap: theme.space(2) }}>
      <div style={{ fontSize: theme.font.small, fontWeight: theme.weight.strong, color: theme.color.textMuted }}>Shared attacks</div>
      {shared.map((s) => (
        <SharedAttack key={s.name} name={s.name} each={s.each} dice={dice} blocked={props.blocked} />
      ))}
    </div>
  );
}

function SharedAttack(props: { name: string; each: { creature: ActorTarget; named: import("#shared/dice/bonus.ts").NamedRoll }[]; dice: NonNullable<ReturnType<typeof useDiceView>["dice"]>; blocked: string | null }) {
  const panel = useDicePanel();
  const [ac, setAc] = useState<number | null>(null);
  // The attack sends the AC, and the field stays to read the hits, so the AC counts from the last attack on (docs/design-v1-sheet-swipe.md 4.6).
  const sentAc = useUnsavedSince(ac);
  const [tag, setTag] = useState<string | null>(null);
  const [damageTag, setDamageTag] = useState<string | null>(null);
  const receipt = useReceipt(tag);
  const damage = useReceipt(damageTag);
  const rolled = receipt?.state === "committed" ? rollsOf(receipt.lines) : [];
  const n = props.each.length;
  const hits = ac === null ? [] : rolled.flatMap((r, i) => {
    const verdict = hitOf(r, ac);
    return verdict === "miss" ? [] : [{ i, critical: verdict === "critical" }];
  });
  const attack = () => {
    const rolls: PanelRoll[] = props.each.map(({ creature, named }) => {
      const preset = presetFor(props.dice, creature, { kind: "attack" });
      return { formula: withExtra(d20Formula(named.attack ?? 0), preset.extra), label: cutLabel(named.name), creature, sources: [...preset.sources] as AdvantageSource[], ...(named.critOn ? { critOn: named.critOn } : {}) };
    });
    setDamageTag(null);
    setTag(panel.roll(rolls, ac !== null ? { ac } : {}));
    sentAc();
  };
  const rollDamage = () => {
    const rolls = hits.flatMap(({ i, critical }) => {
      const each = props.each[i];
      if (!each) return [];
      return damageRolls({ ...each.named, name: `${props.name} damage for ${hits.length} hits` }, { on: new Set(), critical, creature: each.creature }).map((r) => ({ ...r, label: cutLabel(`${props.name} damage for ${hits.length} hits${r.label?.includes(",") ? `,${r.label.split(",").at(-1)}` : ""}`) }));
    });
    setDamageTag(panel.roll(rolls));
  };
  const total = damage?.state === "committed" ? rollsOf(damage.lines).reduce((a, r) => a + r.total, 0) : null;
  return (
    <div style={{ display: "grid", gap: theme.space(1), borderTop: `${theme.line.border}px solid ${theme.color.border}`, paddingTop: theme.space(1) }}>
      <div style={{ display: "flex", gap: theme.space(2), alignItems: "center", flexWrap: "wrap" }}>
        <Button size="sm" disabled={props.blocked !== null} busy={receipt?.state === "sending"} onClick={attack}>
          {`${props.name} for ${n}`}
        </Button>
        <NumberField label="Target's AC" value={ac ?? undefined} min={1} max={50} nullable placeholder="AC" onCommit={setAc} width={72} />
      </div>
      {rolled.length > 0 ? (
        <Note>
          {rolled
            .map((r) => {
              const verdict = ac === null ? null : hitOf(r, ac);
              return `${r.total}${verdict === "critical" ? " critical hit" : verdict === "hit" ? " hit" : verdict === "miss" ? " miss" : ""}`;
            })
            .join(", ")}
        </Note>
      ) : null}
      {hits.length > 0 ? (
        <Button size="sm" disabled={props.blocked !== null} busy={damage?.state === "sending"} onClick={rollDamage}>
          {`Roll damage for ${hits.length} hit${hits.length === 1 ? "" : "s"}`}
        </Button>
      ) : null}
      {total !== null ? <Note>{`${total} damage. Every HP entry offers it as a chip.`}</Note> : null}
    </div>
  );
}

/** "Initiative for the 4 in the fight" (4.4), by the tracker's auto initiative mode (section 7). Shown only for monsters in the fight. */
function GroupInitiative(props: { tokenIds: readonly string[]; blocked: string | null }) {
  const auto = useAutoInitiativeFor(props.tokenIds);
  if (auto.count === 0) return null;
  return (
    <Button size="sm" busy={auto.busy} disabled={props.blocked !== null} title={props.blocked ?? undefined} onClick={auto.press}>
      {`Initiative for the ${auto.count} in the fight`}
    </Button>
  );
}
