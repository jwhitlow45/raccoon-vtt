import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { Actor, CompanionBlock, CustomMonster, Token } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { statBlockFromSrd, statBlockOf } from "#shared/statBlock.ts";
import { Loading } from "../../components/Loading.tsx";
import { Group } from "../../components/Panel.tsx";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomStore, useRoomView } from "../../state/view.ts";
import { blockLines, viewOf } from "../monsters/draft.ts";
import { useOpenEditor } from "../monsters/EditorHost.tsx";
import { monsterImage } from "../monsters/images.ts";
import { MonsterPicker } from "../monsters/MonsterPicker.tsx";
import { StatBlockView, useSrdMonsters } from "../monsters/StatBlockView.tsx";
import { attachPatch, DETACH_PATCH, OWNER_DETACH_PATCH, statBlockFoldable, statBlockShown, tokenStatBlock } from "../monsters/statBlockLink.ts";
import { ownsCharacter, type TokenAccess } from "./access.ts";
import { AttachBlockDialog } from "./CompanionBlocks.tsx";
import { linkedBlockSummary } from "./creatureKind.ts";
import { whose } from "./companionBlocks.ts";
import { usePreview } from "../dm/previewContext.ts";
import { relationKey, statBlockOpen, statBlockOpenedSlot, usePanelFolds } from "./panelFolds.ts";
import { panelRelation } from "./panelOrder.ts";
import { statBlockRequest } from "./statBlockOpen.ts";
import { Note, Section, SmallButton } from "./ui.tsx";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";
import { useSrdBlocks } from "../monsters/srdBlocks.ts";
import { PcStatBlock } from "../pcstats/PcStatBlock.tsx";

/** A companion's character, as the section names it and saves blocks under it. */
type Keeper = { id: string; name: string };

/**
 * The full stat block on a monster's or NPC's token (docs/design-v1-dm-tools.md
 * 3.6), directly under the token panel's image
 * (docs/design-v1-token-panel.md 3.5): the room monster or SRD monster it
 * is linked to, read where the token is, with Edit or "Copy to this room's
 * monsters and edit", and Detach, under what they act on. Its heading is
 * the disclosure "Stat block", folded as this device last left it (the
 * Room's folds, panelFolds.ts). The numbers read every turn stand in the
 * name's header above it, so they never need the block. A token with no link
 * offers "Attach a stat block" on the heading's row, with no fold. The
 * owner of an SRD monster, such as a druid's Wild Shape, reads its block
 * too, and nothing else here.
 *
 * A request (statBlockOpen.ts) shows the block open whatever the folds
 * say, scrolls it to the top of the panel and moves focus to its
 * disclosure, which is named "Stat block" whether open or folded.
 *
 * On a player character's token the section is its character's own stat
 * block (docs/design-v1-pc-stats.md 7.3, pcstats/PcStatBlock.tsx), for the
 * DM and the character's players.
 *
 * On a creature companion the DM and its players share the section
 * (docs/design-v1-companion-stat-blocks.md 6.5): Attach, Change and Detach
 * for both, the block kept by its character with Edit, and an SRD block's
 * "Copy to Bree's stat blocks and edit". Attaching and changing go through
 * the numbers step. A room monster's link, which only "Make a companion"
 * gives a companion, shows only to the DM, with a line that its players do
 * not read it.
 */
export function StatBlockSection(props: {
  token: Token;
  actor: Partial<Actor> | undefined;
  access: TokenAccess;
  patchActor(patch: ActorPatch): void;
}) {
  const { token, actor, access } = props;
  const monsters = useRoomView((s) => s.view?.monsters);
  const blocks = useRoomView((s) => s.view?.companionBlocks);
  const keeperName = useRoomView((s) => (token.companion ? s.view?.characters[token.companion.of]?.name : undefined));
  // A player character's token shows its character's own stat block (docs/design-v1-pc-stats.md 7.3).
  const pc = useRoomView((s) => ("ref" in token.actor ? s.view?.characters[token.actor.ref] : undefined));
  const you = useRoomView((s) => s.you);
  const keeper: Keeper | null = token.companion ? { id: token.companion.of, name: keeperName ?? "its character" } : null;
  const { folds, slot } = usePanelFolds();
  const preview = usePreview() !== null;
  const openedStore = useScoped(statBlockOpenedSlot);
  const override = useStore(openedStore);
  const request = useScoped(statBlockRequest);
  const asked = useStore(request, (s) => (s.tokenId === token.id ? s : null));
  const relation = panelRelation(access);
  const open = statBlockOpen(folds, override, token.id, relation);
  const openEditor = useOpenEditor();
  const store = useRoomStore();
  const [picking, setPicking] = useState(false);
  // The SRD as far as this page has loaded it, for the folded row's name and CR: folding never loads it.
  const srd = useSrdBlocks(false);
  const ref = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLButtonElement>(null);

  // Each press of "Stat block" is a new request, so a second one while the block shows scrolls and focuses it again.
  const askedSeq = asked?.seq ?? null;
  const askedFocus = asked?.focus ?? false;
  useEffect(() => {
    if (askedSeq === null) return;
    request.setState({ tokenId: null });
    // After the render that unfolds it, so the whole block is laid out before it scrolls.
    requestAnimationFrame(() => {
      const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      ref.current?.scrollIntoView({ block: "start", behavior: still ? "auto" : "smooth" });
      if (askedFocus) focusRef.current?.focus({ preventScroll: true });
    });
  }, [askedSeq, askedFocus, request]);

  if (!statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor, companion: keeper !== null, character: "ref" in token.actor, ownsCharacter: pc ? ownsCharacter(you?.memberId, pc) : undefined })) return null;
  const toggle = () => {
    // A tap is the viewer's own choice: the request's override gives way to it, and it is what this device remembers.
    openedStore.setState({ tokenId: null });
    slot.tap(relationKey("statBlock", relation), !open, !preview);
  };
  if ("ref" in token.actor) {
    return (
      <div ref={ref} data-stat-block="" style={{ scrollMarginTop: theme.space(2), overflowWrap: "anywhere" }}>
        {pc ? <PcStatBlock character={pc} fold={{ open, onToggle: toggle, foldRef: focusRef }} /> : <Group label="Stat block" />}
      </div>
    );
  }
  const link = tokenStatBlock(actor, monsters, blocks);
  /*
   * Each editor opens over the room with the block or monster as it is at
   * this moment, and keeps it: the link changing or this section going
   * away, with the block deleted, the companion's character deleted or no
   * longer the viewer's, never takes the draft (monsters/openEditors.ts).
   */
  const editRoom = (monster: CustomMonster) => openEditor({ monster, initial: statBlockOf(monster) });
  const editBlock = (block: CompanionBlock, of: Keeper) => openEditor({ monster: null, initial: blockLines(block), block: { character: of, existing: block } });
  const copySrd = (monster: SrdMonster) => {
    const attach = (id: string) => props.patchActor(attachPatch(keeper ? { blockId: id } : { monsterId: id }));
    // A companion's copy is its character's block, which never takes the DM's image and keeps the SRD's credit (docs/design-v1-companion-stat-blocks.md 6.1).
    if (keeper) {
      openEditor({ monster: null, initial: statBlockFromSrd(monster), block: { character: keeper, existing: null, fromSrd: monster.srdId }, onSaved: attach });
      return;
    }
    // A room monster's copy starts with the image that SRD monster's tokens get, the DM's choice or its shipped icon, as the Monsters panel's copy starts.
    const image = monsterImage(store.getState().view ?? {}, { srdId: monster.srdId });
    openEditor({ monster: null, initial: { ...statBlockFromSrd(monster), ...(image ? { defaultImage: image } : {}) }, onSaved: attach });
  };
  // A companion's players detach what they may link. The DM's Detach clears a room monster's link too.
  const detach =
    (access.dm || keeper !== null) && link.kind !== "none" ? <SmallButton onClick={() => props.patchActor(access.dm ? DETACH_PATCH : OWNER_DETACH_PATCH)}>Detach</SmallButton> : null;
  const change = keeper ? <SmallButton onClick={() => setPicking(true)}>Change</SmallButton> : null;

  return (
    // Its lines and buttons name the companion's character, whose name may be long and unbroken: it wraps rather than run out of the panel.
    <div ref={ref} data-stat-block="" style={{ scrollMarginTop: theme.space(2), overflowWrap: "anywhere" }}>
      {statBlockFoldable(link) ? (
        <Group label="Stat block" open={open} onToggle={toggle} foldRef={focusRef} summary={linkedBlockSummary(link, srd.list)}>
          {link.kind === "room" ? (
            <>
              <StatBlockView view={viewOf(link.monster)} source="room" />
              {keeper ? (
                <Note>{`${whose(keeper.name)} players do not see this block: it is one of this room's own monsters. Change it to an SRD block or one of ${whose(keeper.name)} for them to read one.`}</Note>
              ) : null}
              {access.dm ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
                  <SmallButton onClick={() => editRoom(link.monster)}>Edit</SmallButton>
                  {change}
                  {detach}
                </div>
              ) : null}
            </>
          ) : link.kind === "srd" ? (
            <SrdBlock
              srdId={link.srdId}
              copy={access.dm || keeper !== null ? (keeper ? `Copy to ${whose(keeper.name)} stat blocks and edit` : "Copy to this room's monsters and edit") : null}
              buttons={
                <>
                  {change}
                  {detach}
                </>
              }
              onCopy={copySrd}
            />
          ) : link.kind === "block" ? (
            <>
              <StatBlockView view={viewOf(link.block)} source={link.block.fromSrd ? "srd" : "room"} credit={link.block.fromSrd !== undefined} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
                {keeper ? <SmallButton onClick={() => editBlock(link.block, keeper)}>Edit</SmallButton> : null}
                {change}
                {detach}
              </div>
            </>
          ) : null}
        </Group>
      ) : (
        <Group
          label="Stat block"
          action={
            (link.kind === "none" || (keeper !== null && (link.kind === "deleted" || link.kind === "deletedBlock"))) && (access.dm || keeper !== null) ? (
              <SmallButton ref={focusRef} wrap onClick={() => setPicking(true)}>
                Attach a stat block
              </SmallButton>
            ) : null
          }
        >
          {link.kind === "deleted" || link.kind === "deletedBlock" ? (
            <>
              <Note>{link.kind === "deletedBlock" ? "This companion's stat block was deleted." : "This token's stat block was deleted from this room."}</Note>
              <div style={{ display: "flex", gap: theme.space(2) }}>{detach}</div>
            </>
          ) : null}
        </Group>
      )}
      {picking && keeper ? (
        <AttachBlockDialog
          token={token}
          actor={actor}
          character={keeper}
          access={access}
          onClose={() => setPicking(false)}
          // A block just attached is one its reader means to read, so it shows open, as a request would.
          onAttached={() => openedStore.setState({ tokenId: token.id })}
        />
      ) : null}
      {picking && !keeper ? (
        <MonsterPicker
          name={token.name}
          onClose={() => setPicking(false)}
          onPick={(picked) => {
            setPicking(false);
            // A block just attached is one the DM means to read, so it shows open, as a request would.
            openedStore.setState({ tokenId: token.id });
            props.patchActor(attachPatch(picked));
          }}
        />
      ) : null}
    </div>
  );
}

/** An SRD monster's block. The SRD chunk loads only here, once the section is open on this device. */
function SrdBlock(props: { srdId: string; copy: string | null; buttons: ReactNode; onCopy(monster: SrdMonster): void }) {
  const { monsters, failed } = useSrdMonsters();
  const monster = monsters?.find((m) => m.srdId === props.srdId);
  if (failed) return <SrdLoadFailed what="The stat block" inline />;
  if (!monsters) return <Loading text="Loading the stat block…" />;
  return (
    <>
      {monster ? <StatBlockView view={monster} source="srd" credit /> : <Note>This token names an SRD monster this app does not have.</Note>}
      {props.copy !== null ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          {monster ? (
            <SmallButton wrap onClick={() => props.onCopy(monster)}>
              {props.copy}
            </SmallButton>
          ) : null}
          {props.buttons}
        </div>
      ) : null}
    </>
  );
}
