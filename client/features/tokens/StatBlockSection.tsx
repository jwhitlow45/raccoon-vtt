import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { Actor, Token } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { statBlockFromSrd, statBlockOf } from "#shared/statBlock.ts";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { viewOf } from "../monsters/draft.ts";
import { MonsterEditor } from "../monsters/MonsterEditor.tsx";
import { MonsterPicker } from "../monsters/MonsterPicker.tsx";
import { StatBlockView, useSrdMonsters } from "../monsters/StatBlockView.tsx";
import { attachPatch, DETACH_PATCH, statBlockFoldable, statBlockShown, tokenStatBlock } from "../monsters/statBlockLink.ts";
import type { TokenAccess } from "./access.ts";
import { usePreview } from "../dm/previewContext.ts";
import { statBlockOpen, statBlockOpenedSlot, usePanelFolds } from "./panelFolds.ts";
import { statBlockRequest } from "./statBlockOpen.ts";
import { Note, Section, SmallButton } from "./ui.tsx";
import { SrdLoadFailed } from "../monsters/SrdLoadFailed.tsx";

type Editing = { kind: "edit" } | { kind: "copy" } | null;

/**
 * The full stat block on a monster's or NPC's token (docs/design-v1-dm-tools.md
 * 3.6), directly under the token panel's image
 * (docs/design-v1-token-panel.md 3.5): the room monster or SRD monster it
 * is linked to, read where the token is, with Edit or "Copy to this room's
 * monsters and edit", and Detach, under what they act on. Its heading is
 * the disclosure "Stat block", folded as this device last left it (the
 * Room's folds, panelFolds.ts), and `summary`, the token's own AC, speed
 * and Passive Perception, sits under the heading folded or open, so the
 * numbers read every turn never need the block. A token with no link
 * offers "Attach a stat block" on the heading's row, with no fold. The
 * owner of an SRD monster, such as a druid's Wild Shape, reads its block
 * too, and nothing else here.
 *
 * A request (statBlockOpen.ts) shows the block open whatever the folds
 * say, scrolls it to the top of the panel and moves focus to its
 * disclosure, which is named "Stat block" whether open or folded.
 */
export function StatBlockSection(props: {
  token: Token;
  actor: Partial<Actor> | undefined;
  access: TokenAccess;
  patchActor(patch: ActorPatch): void;
  /** The summary line, shown under the heading whether the block is open or folded. */
  summary: ReactNode;
}) {
  const { token, actor, access } = props;
  const monsters = useRoomView((s) => s.view?.monsters);
  const { folds, slot } = usePanelFolds();
  const preview = usePreview() !== null;
  const openedStore = useScoped(statBlockOpenedSlot);
  const override = useStore(openedStore);
  const request = useScoped(statBlockRequest);
  const asked = useStore(request, (s) => (s.tokenId === token.id ? s : null));
  const open = statBlockOpen(folds, override, token.id);
  const [editing, setEditing] = useState<Editing>(null);
  const [picking, setPicking] = useState(false);
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

  if (!statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor })) return null;
  const link = tokenStatBlock(actor, monsters);
  const detach = access.dm && link.kind !== "none" ? <SmallButton onClick={() => props.patchActor(DETACH_PATCH)}>Detach</SmallButton> : null;
  const toggle = () => {
    // A tap is the viewer's own choice: the request's override gives way to it, and it is what this device remembers.
    openedStore.setState({ tokenId: null });
    slot.tap("statBlock", !open, !preview);
  };

  return (
    <div ref={ref} data-stat-block="" style={{ scrollMarginTop: theme.space(2) }}>
      {statBlockFoldable(link) ? (
        <Section title="Stat block" fold={{ open, onToggle: toggle, foldRef: focusRef, summary: props.summary ? <div style={{ flexBasis: "100%", minWidth: 0, paddingBottom: theme.space(1) }}>{props.summary}</div> : undefined }}>
          {link.kind === "room" ? (
            <>
              <StatBlockView view={viewOf(link.monster)} source="room" />
              {access.dm ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
                  <SmallButton onClick={() => setEditing({ kind: "edit" })}>Edit</SmallButton>
                  {detach}
                </div>
              ) : null}
            </>
          ) : link.kind === "srd" ? (
            <SrdBlock srdId={link.srdId} dm={access.dm} detach={detach} onCopy={() => setEditing({ kind: "copy" })} />
          ) : null}
        </Section>
      ) : (
        <Section
          title="Stat block"
          aside={
            link.kind === "none" && access.dm ? (
              <SmallButton ref={focusRef} wrap onClick={() => setPicking(true)}>
                Attach a stat block
              </SmallButton>
            ) : null
          }
        >
          {props.summary}
          {link.kind === "deleted" ? (
            <>
              <Note>This token’s stat block was deleted from this room.</Note>
              <div style={{ display: "flex", gap: theme.space(2) }}>{detach}</div>
            </>
          ) : null}
        </Section>
      )}
      {editing?.kind === "edit" && link.kind === "room" ? (
        <MonsterEditor monster={link.monster} initial={statBlockOf(link.monster)} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />
      ) : null}
      {editing?.kind === "copy" && link.kind === "srd" ? (
        <CopyEditor
          srdId={link.srdId}
          onClose={() => setEditing(null)}
          onSaved={(monsterId) => {
            setEditing(null);
            // The copy is the block the DM means for this creature now, so the token follows it.
            props.patchActor(attachPatch({ monsterId }));
          }}
        />
      ) : null}
      {picking ? (
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
function SrdBlock(props: { srdId: string; dm: boolean; detach: ReactNode; onCopy(): void }) {
  const { monsters, failed } = useSrdMonsters();
  const monster = monsters?.find((m) => m.srdId === props.srdId);
  if (failed) return <SrdLoadFailed what="The stat block" inline />;
  if (!monsters) return <Loading text="Loading the stat block…" />;
  return (
    <>
      {monster ? <StatBlockView view={monster} source="srd" credit /> : <Note>This token names an SRD monster this app does not have.</Note>}
      {props.dm ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          {monster ? (
            <SmallButton wrap onClick={props.onCopy}>
              Copy to this room’s monsters and edit
            </SmallButton>
          ) : null}
          {props.detach}
        </div>
      ) : null}
    </>
  );
}

/** The editor started from an SRD block, with the image the DM chose for that SRD monster, as the Monsters panel's copy starts. */
function CopyEditor(props: { srdId: string; onClose(): void; onSaved(monsterId: string): void }) {
  const { monsters } = useSrdMonsters();
  const image = useRoomView((s) => s.view?.srdImages?.[props.srdId]?.image);
  const monster = monsters?.find((m) => m.srdId === props.srdId);
  if (!monster) return null;
  return (
    <MonsterEditor
      monster={null}
      initial={{ ...statBlockFromSrd(monster), ...(image ? { defaultImage: image } : {}) }}
      onClose={props.onClose}
      onSaved={props.onSaved}
    />
  );
}
