import { useEffect, useMemo, useRef, useState } from "react";
import type { Actor, Character, CompanionBlock, Token } from "#shared/model.ts";
import { emptyStatBlock } from "#shared/statBlock.ts";
import { Button } from "../../components/Button.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { Empty } from "../../components/Empty.tsx";
import { Icon } from "../../components/Icon.tsx";
import { Help, SectionLabel } from "../../components/Panel.tsx";
import { Row, RowList } from "../../components/Row.tsx";
import { Segmented } from "../../components/Segmented.tsx";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomActions, useRoomStore, useRoomUi, useRoomView } from "../../state/view.ts";
import { useSend } from "../encounter/hooks.ts";
import { useOpenEditor } from "../monsters/EditorHost.tsx";
import { CompanionPickerBody } from "../monsters/MonsterPicker.tsx";
import { StatBlockView } from "../monsters/StatBlockView.tsx";
import { blockLines, viewOf } from "../monsters/draft.ts";
import type { TokenAccess } from "./access.ts";
import {
  attachActorPatch,
  blockDetail,
  blockNumbers,
  blockRow,
  characterBlocks,
  sizePlan,
  startAttach,
  whose,
  type AttachPhase,
  type HpChoice,
  type PickerRow,
} from "./companionBlocks.ts";
import { growthsSlot } from "./resizeMemory.ts";
import { ConfirmButton, NumberField } from "./ui.tsx";

/**
 * A companion's stat blocks in the interface
 * (docs/design-v1-companion-stat-blocks.md 5 and 6): the attach dialog
 * with its numbers step, the picker a new companion's form opens, and
 * "Bree's stat blocks", the character's own list. A block made from the
 * picker is saved first and used only once its save is taken, so a refused
 * save sends nothing more and says why in the editor (6.1).
 */

/**
 * "Paste a stat block" or "New stat block": the editor for a new block of
 * the character, held over the room (monsters/openEditors.ts), so it stays
 * whatever happens to the dialog or page that opened it. Once the block is
 * saved, `use` gets its row, built from the block the save's answer found
 * in the view.
 */
function useNewBlock(character: Pick<Character, "id" | "name">, use: (row: PickerRow) => void): (paste: boolean) => void {
  const open = useOpenEditor();
  return (paste) =>
    open({
      monster: null,
      initial: emptyStatBlock(),
      paste,
      block: { character, existing: null },
      onSaved: (_id, block) => {
        if (block && block.characterId === character.id) use(blockRow(block, character.name));
      },
    });
}

/**
 * "Attach a stat block" and Change on a creature companion (5.1, 6.1): the
 * picker, then "Attach Owl" with the numbers it sets and its Size line,
 * Back to the lists with the search kept, and Attach. The attach is two
 * ops (companionBlocks.ts startAttach): the link and every number but the
 * size, then, once that is taken, the size as a resize of its own. A
 * refusal of the link stays above the footer in the server's words with
 * Attach offered again, and a refusal of the size stays on the Size line
 * with the link and numbers applied and Done in the footer.
 */
export function AttachBlockDialog(props: {
  token: Token;
  actor: Partial<Actor> | undefined;
  character: Pick<Character, "id" | "name">;
  /** The viewer's rights on the token, for whether the size is theirs to change (access.ts canResize). */
  access: Pick<TokenAccess, "dm" | "owner">;
  onClose(): void;
  /** The link was taken, so the section shows the block open. */
  onAttached?(): void;
}) {
  const { token, character } = props;
  const actions = useRoomActions();
  const ui = useRoomUi();
  const store = useRoomStore();
  const growths = useScoped(growthsSlot);
  const view = useRoomView((s) => s.view);
  const role = props.access.dm ? "dm" : "player";
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<PickerRow | null>(null);
  const [use, setUse] = useState(true);
  const [hp, setHp] = useState<HpChoice>({ kind: "average" });
  const [phase, setPhase] = useState<AttachPhase>({ phase: "ready" });
  const open = useRef(true);
  useEffect(() => {
    open.current = true;
    return () => {
      open.current = false;
    };
  }, []);
  // Once the link is taken the section shows the block open, and the dialog closes when nothing is left to send.
  const moveTo = (next: AttachPhase) => {
    setPhase(next);
    if (next.phase === "done" || next.phase === "resizing" || next.phase === "sizeStopped") props.onAttached?.();
    if (next.phase === "done") props.onClose();
  };

  const choose = (row: PickerRow) => {
    setPicked(row);
    setUse(true);
    setHp(row.view.hp.average >= 1 ? { kind: "average" } : { kind: "keep" });
    setPhase({ phase: "ready" });
  };
  const newBlock = useNewBlock(character, choose);
  const numbers = picked ? blockNumbers(picked.view, token, props.actor, hp) : null;
  const linking = phase.phase === "linking" || phase.phase === "resizing";
  const missingHp = use && hp.kind === "typed" && numbers?.max === null;
  // The Size line before Attach: the token window's own rule on the view as it stands.
  const plan = picked && view ? sizePlan({ view, token, size: picked.view.size, use, role, owner: props.access.owner, growths: growths.getState()[token.id] ?? [] }) : null;
  const sizeLine = phase.phase === "resizing" ? "Resizing…" : phase.phase === "sizeStopped" ? phase.line : plan && plan.kind !== "none" ? plan.line : null;

  const attach = () => {
    if (!picked || !numbers || linking || missingHp) return;
    startAttach(
      {
        dispatch: (op, opts) => actions.dispatch(op, opts),
        view: () => store.getState().view,
        role,
        owner: props.access.owner,
        growths: () => growths.getState()[token.id] ?? [],
        setGrowths: (list) => growths.setState({ [token.id]: list }),
        open: () => open.current,
        phase: moveTo,
        notify: (text, tone) => ui.notify(text, tone),
      },
      {
        tokenId: token.id,
        patch: attachActorPatch(picked.link, use, numbers),
        size: picked.view.size,
        use,
        block: picked.view.name,
        companion: token.name,
        ...(plan?.kind === "kept" ? { previewed: plan.line } : {}),
      },
    );
  };

  const back = () => {
    setPicked(null);
    setPhase({ phase: "ready" });
  };
  const status = phase.phase === "refused" || phase.phase === "unknown" ? <span role="alert">{phase.line}</span> : null;
  return (
    <>
      <Dialog
        title={picked ? `Attach ${picked.view.name}` : "Attach a stat block"}
        onClose={props.onClose}
        back={picked && phase.phase !== "sizeStopped" && !linking ? { label: "Back to the stat blocks", onBack: back } : null}
        phone="fill"
        width="md"
        status={picked ? status : null}
        footer={
          !picked ? undefined : phase.phase === "sizeStopped" ? (
            <Button variant="primary" onClick={props.onClose}>
              Done
            </Button>
          ) : (
            <>
              <Button disabled={linking} onClick={back}>
                Back
              </Button>
              <Button variant="primary" busy={linking} disabled={missingHp} onClick={attach}>
                {linking ? "Attaching…" : "Attach"}
              </Button>
            </>
          )
        }
      >
        {picked && numbers ? (
          <NumbersStep
            token={token}
            actor={props.actor}
            block={picked.view.name}
            numbers={numbers}
            sizeLine={sizeLine}
            frozen={linking || phase.phase === "sizeStopped"}
            use={use}
            onUse={setUse}
            hp={hp}
            onHp={setHp}
          />
        ) : (
          <CompanionPickerBody
            character={character}
            name={token.name}
            help={`${whose(character.name)} players and the DM read it. Next you choose whether it sets ${token.name}’s numbers.`}
            query={query}
            onQuery={setQuery}
            onPick={choose}
            onPaste={() => newBlock(true)}
            onNew={() => newBlock(false)}
          />
        )}
      </Dialog>
    </>
  );
}

/**
 * The numbers step (5.1, 5.2): "Use Owl's numbers" or "Keep Hoot's
 * numbers", each number that changes with the one it has now, the max HP
 * to set and what that does to its current HP. Temporary HP, conditions,
 * effects, death saves and the Reaction always stay.
 */
function NumbersStep(props: {
  token: Token;
  actor: Partial<Actor> | undefined;
  block: string;
  numbers: ReturnType<typeof blockNumbers>;
  /** The Size line: the size it sets and what the resize rule makes of it, or how the resize stands once sent. */
  sizeLine: string | null;
  /**
   * Sent, or done but for the size: the choices hold still. Attach sends
   * what they said when it was pressed, so a change made while its answer
   * waits would show one thing and do another.
   */
  frozen: boolean;
  use: boolean;
  onUse(use: boolean): void;
  hp: HpChoice;
  onHp(hp: HpChoice): void;
}) {
  const { numbers, token } = props;
  const current = props.actor?.hp?.max;
  const hpOptions = [
    ...(numbers.average !== null ? [{ value: "average" as const, label: `Average ${numbers.average}` }] : []),
    { value: "typed" as const, label: "Type one" },
    ...(current !== undefined ? [{ value: "keep" as const, label: `Keep ${current}` }] : []),
  ];
  return (
    <fieldset disabled={props.frozen} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(3), fontSize: theme.font.body14, border: 0, margin: 0, padding: 0, minWidth: 0 }}>
      <Segmented<"use" | "keep">
        label="Numbers"
        value={props.use ? "use" : "keep"}
        wrap
        disabled={props.frozen}
        options={[
          { value: "use", label: `Use ${whose(props.block)} numbers` },
          { value: "keep", label: `Keep ${whose(token.name)} numbers` },
        ]}
        onChange={(v) => props.onUse(v === "use")}
      />
      {props.use ? (
        <>
          {numbers.lines.length > 0 ? (
            <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: theme.space(1), overflowWrap: "anywhere" }}>
              {numbers.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <Help>{`${token.name} already has ${whose(props.block)} AC, speeds, senses, Passive Perception and initiative.`}</Help>
          )}
          {/* Read out as it changes: the preview, then "Resizing…" and how the resize came out. */}
          <p role="status" data-size-line="" style={{ margin: 0, overflowWrap: "anywhere" }}>
            {props.sizeLine}
          </p>
          <SectionLabel>Max HP</SectionLabel>
          <Segmented<HpChoice["kind"]>
            label="Max HP"
            value={props.hp.kind}
            options={hpOptions}
            disabled={props.frozen}
            onChange={(kind) => props.onHp(kind === "typed" ? { kind, value: props.hp.kind === "typed" ? props.hp.value : null } : { kind })}
          />
          {props.hp.kind === "typed" ? (
            <NumberField label="Max HP" value={props.hp.value ?? undefined} min={1} max={100_000} nullable disabled={props.frozen} onCommit={(value) => props.onHp({ kind: "typed", value })} />
          ) : null}
          {numbers.hpLine ? <Help style={{ overflowWrap: "anywhere" }}>{numbers.hpLine}</Help> : <Help>Type the maximum this casting gives it.</Help>}
          <Help>Temporary HP, conditions and effects stay.</Help>
        </>
      ) : (
        <Help style={{ overflowWrap: "anywhere" }}>{`Only the stat block is attached. ${token.name} keeps its AC, HP, speeds, senses and initiative.`}</Help>
      )}
    </fieldset>
  );
}

/**
 * The picker a new companion's form opens (6.1, 6.3): a pick closes it and
 * fills the form. A block pasted or typed here is saved first, and chosen
 * once its save is taken.
 */
export function ChooseBlockDialog(props: { character: Pick<Character, "id" | "name">; name: string; onChoose(row: PickerRow): void; onClose(): void }) {
  const [query, setQuery] = useState("");
  const newBlock = useNewBlock(props.character, props.onChoose);
  return (
    <Dialog title="Choose a stat block" onClose={props.onClose} phone="fill" width="md">
      <CompanionPickerBody
        character={props.character}
        name={props.name}
        help={`${whose(props.character.name)} players and the DM read it. Its numbers fill in the form, and you can change them there.`}
        query={query}
        onQuery={setQuery}
        onPick={props.onChoose}
        onPaste={() => newBlock(true)}
        onNew={() => newBlock(false)}
      />
    </Dialog>
  );
}

/**
 * "Bree's stat blocks" (6.4), in the Characters panel's place for the DM
 * and the character's players: "Paste a stat block" and "New stat block",
 * then each block as a disclosure row that opens its view with Edit and
 * Delete. A delete takes two taps, and the companions that used it keep
 * their numbers and show that it was deleted. Done hands focus back.
 */
export function CharacterBlocksPage(props: { character: Pick<Character, "id" | "name">; onDone(): void }) {
  const { character } = props;
  const stored = useRoomView((s) => s.view?.companionBlocks);
  const blocks = useMemo(() => characterBlocks({ companionBlocks: stored ?? {} }, character.id), [stored, character.id]);
  const [openId, setOpenId] = useState<string | null>(null);
  const newBlock = useNewBlock(character, (row) => setOpenId("blockId" in row.link ? row.link.blockId : null));
  const openEditor = useOpenEditor();
  const edit = (block: CompanionBlock) => openEditor({ monster: null, initial: blockLines(block), block: { character, existing: block } });
  const heading = useRef<HTMLHeadingElement>(null);
  // The opener went with the card this page replaced, so focus starts at the page's heading.
  useEffect(() => heading.current?.focus(), []);
  return (
    // The heading, the empty line and the rows name the character, whose name may be long and unbroken: it wraps rather than run out of the page.
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: theme.space(2), fontSize: theme.font.body14, overflowWrap: "anywhere" }}>
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <h3 ref={heading} tabIndex={-1} style={{ margin: 0, flex: 1, minWidth: 0, overflowWrap: "anywhere", fontSize: theme.font.heading, fontWeight: theme.weight.bold }}>
          {whose(character.name)} stat blocks
        </h3>
        <Button size="sm" onClick={props.onDone}>
          Done
        </Button>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
        <Button size="sm" onClick={() => newBlock(true)}>
          Paste a stat block
        </Button>
        <Button size="sm" onClick={() => newBlock(false)}>
          New stat block
        </Button>
      </div>
      {blocks.length === 0 ? (
        <Empty>{`${whose(character.name)} companions’ stat blocks go here. Paste one from a book, start one, or pick an SRD creature when you add a companion.`}</Empty>
      ) : (
        <RowList label={`${whose(character.name)} stat blocks`}>
          {blocks.map((block) => (
            <BlockRow key={block.id} block={block} open={openId === block.id} onToggle={() => setOpenId(openId === block.id ? null : block.id)} onEdit={() => edit(block)} />
          ))}
        </RowList>
      )}
    </div>
  );
}

function BlockRow(props: { block: CompanionBlock; open: boolean; onToggle(): void; onEdit(): void }) {
  const { block } = props;
  const remove = useSend();
  return (
    <div style={{ display: "grid", gap: theme.space(2) }}>
      <Row
        expanded={props.open}
        onClick={props.onToggle}
        title={block.name}
        detail={blockDetail(block)}
        trailing={<Icon name={props.open ? "chevronDown" : "chevronRight"} style={{ color: theme.color.textMuted }} />}
      />
      {props.open ? (
        <div style={{ display: "grid", gap: theme.space(2), padding: `0 ${theme.space(1)}px ${theme.space(2)}px` }}>
          <StatBlockView view={viewOf(block)} source={block.fromSrd ? "srd" : "room"} credit={block.fromSrd !== undefined} />
          <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
            <Button size="sm" icon="edit" onClick={props.onEdit}>
              Edit
            </Button>
            <ConfirmButton icon="delete" confirm="Tap again to delete" busy={remove.waiting} onConfirm={() => remove.send({ t: "companionBlock.delete", blockId: block.id })}>
              Delete
            </ConfirmButton>
          </div>
          <Help>Companions using it keep their numbers and show that it was deleted.</Help>
        </div>
      ) : null}
    </div>
  );
}
