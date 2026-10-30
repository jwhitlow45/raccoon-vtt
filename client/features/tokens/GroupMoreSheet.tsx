import { useMemo, type ReactNode, type RefObject } from "react";
import type { CreatureSize, HpVisibility, Member, Token } from "#shared/model.ts";
import type { ClientOp, TokenGroupPatch } from "#shared/protocol.ts";
import { Checkbox } from "../../components/Checkbox.tsx";
import { DotLabel } from "../../components/Row.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { theme } from "../../lib/theme.ts";
import { dispatchGesture } from "../../state/actions.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomView } from "../../state/view.ts";
import { ImageField } from "../images/ImageField.tsx";
import { ownerOps, ownersLit, shared, sharedImage, updateManyOps, type Lit } from "./groupEdit.ts";
import { resizeGroup } from "./resize.ts";
import { growthsSlot } from "./resizeMemory.ts";
import { SheetDialog } from "./SheetDialog.tsx";
import { FieldRow, Note, Section, Select } from "./ui.tsx";

const MIXED = "mixed";

const SIZES: { value: Exclude<CreatureSize, "custom">; label: string }[] = [
  { value: "tiny", label: "Tiny" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "huge", label: "Huge" },
  { value: "gargantuan", label: "Gargantuan" },
];

const HP_VISIBILITY: { value: HpVisibility; label: string }[] = [
  { value: "hidden", label: "Nothing" },
  { value: "label", label: "Healthy, Bloodied, Dying, Dead" },
  { value: "bar", label: "A bar" },
  { value: "exact", label: "Exact numbers" },
];

/**
 * The group action bar's More (docs/design-v1-dm-tools.md 3.5), the DM's:
 * what makes sense to set alike on every selected token. Each control
 * shows the value all of them share, or that they differ, and a change is
 * one `token.updateMany` for all of them, one undo step, but for the size,
 * one resize patch each in one gesture. Names, notes,
 * numbers and places stay per creature, in each token's own panel.
 */
export function GroupMoreSheet(props: { tokens: readonly Token[]; onClose(): void; opener: RefObject<HTMLElement | null> }) {
  const { tokens } = props;
  const actions = useRoomActions();
  const members = useRoomView((s) => s.view?.members);
  const ids = useMemo(() => tokens.map((t) => t.id), [tokens]);
  const send = (ops: readonly ClientOp[]) => {
    if (ops.length > 0) dispatchGesture(actions, ops);
  };
  const patch = (p: TokenGroupPatch) => send(updateManyOps(ids, p));
  /*
   * One resize patch for each token, sent as one gesture, one undo step:
   * each keeps its own middle (docs/design-v1-token-window.md 8.6), which
   * one patch for all of them could not. The DM's resizes are never
   * checked against walls. Each goes through this page's growth memory, as
   * a single token's does, so a shrink here or in a token's own window
   * returns it to the square it grew from (resize.ts resizeGroup).
   */
  const store = useRoomStore();
  const memory = useScoped(growthsSlot);
  const resizeAll = (size: Exclude<CreatureSize, "custom">) => {
    const view = store.getState().view;
    if (!view) return;
    const group = resizeGroup(view, tokens, { size }, "dm", memory.getState());
    send(group.ops);
    // A resize that never reached the room leaves the token where the list does not say it is, so the next shrink finds the list stale.
    memory.setState(group.growths);
  };

  const disposition = shared(tokens, (t) => t.disposition);
  const hpVisibility = shared(tokens, (t) => t.hpVisibility);
  const size = shared(tokens, (t) => t.size);
  const layer = shared(tokens, (t) => t.layer);
  const { same: sameImages, image } = sharedImage(tokens);
  const roster = useMemo(
    () => Object.values(members ?? {}).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "player" ? -1 : 1)),
    [members],
  );

  return (
    <SheetDialog title={`${tokens.length} tokens`} onClose={props.onClose} opener={props.opener} width={theme.layout.dialog.md}>
      <Note>Each change applies to all {tokens.length} at once. Use Undo for size. Use Undo setup in Setup history for the other settings.</Note>
      <Section title="Look">
        <FieldRow label="Ring">
          <Segmented<Token["disposition"]>
            label="Disposition"
            value={disposition ?? null}
            options={[
              { value: "ally", label: "Ally" },
              { value: "neutral", label: "Neutral" },
              { value: "hostile", label: "Hostile" },
            ]}
            onChange={(next) => patch({ disposition: next })}
            grow
          />
        </FieldRow>
        <FieldRow label="Size" fill>
          <Select<string>
            label="Size"
            value={size === undefined || size === "custom" ? MIXED : size}
            options={[...(size === undefined || size === "custom" ? [{ value: MIXED, label: size === "custom" ? "Custom" : "Mixed" }] : []), ...SIZES]}
            onChange={(next) => next !== MIXED && resizeAll(next as Exclude<CreatureSize, "custom">)}
          />
        </FieldRow>
        <FieldRow label="Layer">
          <Segmented<Token["layer"]>
            label="Layer"
            value={layer ?? null}
            options={[
              { value: "token", label: "Creatures" },
              { value: "object", label: "Under creatures" },
            ]}
            onChange={(next) => patch({ layer: next })}
            grow
          />
        </FieldRow>
        <FieldRow label="Image" hint={sameImages ? undefined : "They differ. A new one goes on all of them."}>
          <ImageField value={image} onChange={(next) => patch({ image: next })} shape="circle" aspect={1} canEdit />
        </FieldRow>
      </Section>
      <Section title="What players see">
        <FieldRow label="Players see HP as" fill>
          <Select<string>
            label="Players see HP as"
            value={hpVisibility ?? MIXED}
            options={[...(hpVisibility === undefined ? [{ value: MIXED, label: "Mixed" }] : []), ...HP_VISIBILITY]}
            onChange={(next) => next !== MIXED && patch({ hpVisibility: next as HpVisibility })}
          />
        </FieldRow>
        <TriToggle
          lit={litOf(tokens, (t) => t.nameHidden)}
          label="Hide the name from players"
          onChange={(on) => patch({ nameHidden: on })}
        />
        <TriToggle
          lit={litOf(tokens, (t) => t.fogExempt)}
          label="Always visible, even under fog"
          hint="When off, players lose sight of each while it stands fully in the fog."
          onChange={(on) => patch({ fogExempt: on })}
        />
      </Section>
      <Section title="Owners">
        {tokens.some((t) => t.companion) ? (
          // The server refuses owners over a companion, whose owners are its character's (docs/design-v1-combat-flow.md 3.6.4).
          <Note>A companion is played by whoever plays its character. Leave the companions out of the selection to set owners.</Note>
        ) : (
          <>
            <Note>Owners can move a token and edit what their role allows. Each keeps its other owners.</Note>
            {roster.map((m) => (
              <TriToggle key={m.id} lit={ownersLit(tokens, m.id)} label={<MemberLabel member={m} />} onChange={(on) => send(ownerOps(tokens, m.id, on))} />
            ))}
          </>
        )}
      </Section>
    </SheetDialog>
  );
}

function litOf(tokens: readonly Token[], read: (t: Token) => boolean): Lit {
  const on = tokens.filter(read).length;
  return on === 0 ? "none" : on === tokens.length ? "all" : "some";
}

function MemberLabel(props: { member: Member }) {
  return (
    <DotLabel color={props.member.color}>
      {props.member.name}
      {props.member.kind === "dm" ? <span style={{ color: theme.color.textMuted }}>(DM)</span> : null}
    </DotLabel>
  );
}

/**
 * A checkbox row for a flag the tokens may not share: checked when all
 * have it, the browser's mixed mark when some do. A tap on a mixed or
 * clear box turns it on for all, and on a checked one off for all.
 */
function TriToggle(props: { lit: Lit; label: ReactNode; hint?: string; onChange(on: boolean): void }) {
  return (
    <Checkbox
      checked={props.lit === "all"}
      indeterminate={props.lit === "some"}
      onChange={() => props.onChange(props.lit !== "all")}
      label={
        <>
          {props.label}
          {props.lit === "some" ? <span style={{ color: theme.color.textMuted }}> (some)</span> : null}
        </>
      }
      help={props.hint}
    />
  );
}
