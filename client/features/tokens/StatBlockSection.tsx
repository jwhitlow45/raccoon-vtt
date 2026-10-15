import { useEffect, useRef, useState, type ReactNode } from "react";
import { useStore } from "zustand";
import type { Actor, Token } from "#shared/model.ts";
import type { ActorPatch } from "#shared/protocol.ts";
import { statBlockFromSrd, statBlockOf } from "#shared/statBlock.ts";
import { Loading } from "../../components/Loading.tsx";
import { theme } from "../../lib/theme.ts";
import { useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { layoutWidth } from "../device/layout.ts";
import { viewOf } from "../monsters/draft.ts";
import { MonsterEditor } from "../monsters/MonsterEditor.tsx";
import { MonsterPicker } from "../monsters/MonsterPicker.tsx";
import { StatBlockView, useSrdMonsters } from "../monsters/StatBlockView.tsx";
import { attachPatch, DETACH_PATCH, statBlockFoldable, statBlockShown, tokenStatBlock } from "../monsters/statBlockLink.ts";
import type { TokenAccess } from "./access.ts";
import { statBlockRequest } from "./statBlockOpen.ts";
import { Note, Section, SmallButton } from "./ui.tsx";

type Editing = { kind: "edit" } | { kind: "copy" } | null;

/**
 * The full stat block on a monster's or NPC's token (docs/design-v1-dm-tools.md
 * 3.6): the room monster or SRD monster it is linked to, read where the
 * token is, with Edit or "Copy to this room's monsters and edit", and
 * Detach. A token with no link offers "Attach a stat block". The owner of
 * an SRD monster, such as a druid's Wild Shape, reads its block too, and
 * nothing else here. Folded on a phone, where the panel is a sheet.
 */
export function StatBlockSection(props: { token: Token; actor: Partial<Actor> | undefined; access: TokenAccess; patchActor(patch: ActorPatch): void }) {
  const { token, actor, access } = props;
  const monsters = useRoomView((s) => s.view?.monsters);
  const request = useScoped(statBlockRequest);
  const requested = useStore(request, (s) => s.tokenId === token.id);
  const [open, setOpen] = useState(() => layoutWidth() >= theme.layout.wideMinWidth || requested);
  const [editing, setEditing] = useState<Editing>(null);
  const [picking, setPicking] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!requested) return;
    setOpen(true);
    request.setState({ tokenId: null });
    // After the render that unfolds it, so the whole block is laid out before it scrolls.
    requestAnimationFrame(() => ref.current?.scrollIntoView({ block: "start", behavior: "smooth" }));
  }, [requested, request]);

  if (!statBlockShown({ dm: access.dm, owner: access.owner, kind: token.kind, actor })) return null;
  const link = tokenStatBlock(actor, monsters);
  const detach = access.dm && link.kind !== "none" ? <SmallButton onClick={() => props.patchActor(DETACH_PATCH)}>Detach</SmallButton> : null;

  return (
    <div ref={ref} style={{ scrollMarginTop: theme.space(2) }}>
      <Section
        title="Stat block"
        aside={
          !statBlockFoldable(link) ? null : (
            <SmallButton onClick={() => setOpen((o) => !o)} label={open ? "Fold the stat block" : "Show the stat block"}>
              {open ? "Hide" : "Show"}
            </SmallButton>
          )
        }
      >
        {link.kind === "none" ? (
          <>
            <Note>No stat block is linked to this token.</Note>
            <SmallButton onClick={() => setPicking(true)}>Attach a stat block</SmallButton>
          </>
        ) : link.kind === "deleted" ? (
          <>
            <Note>This token’s stat block was deleted from this room.</Note>
            <div style={{ display: "flex", gap: theme.space(2) }}>{detach}</div>
          </>
        ) : !open ? null : link.kind === "room" ? (
          <>
            <StatBlockView view={viewOf(link.monster)} source="room" />
            {access.dm ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
                <SmallButton onClick={() => setEditing({ kind: "edit" })}>Edit</SmallButton>
                {detach}
              </div>
            ) : null}
          </>
        ) : (
          <SrdBlock
            srdId={link.srdId}
            dm={access.dm}
            detach={detach}
            onCopy={() => setEditing({ kind: "copy" })}
          />
        )}
      </Section>
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
            setOpen(true);
            props.patchActor(attachPatch(picked));
          }}
        />
      ) : null}
    </div>
  );
}

/** An SRD monster's block. The SRD chunk loads only here, once the section is open on this device. */
function SrdBlock(props: { srdId: string; dm: boolean; detach: ReactNode; onCopy(): void }) {
  const { monsters, failed, retry } = useSrdMonsters();
  const monster = monsters?.find((m) => m.srdId === props.srdId);
  if (failed) {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: theme.space(2) }}>
        <Note tone="error">The stat block did not load.</Note>
        <SmallButton onClick={retry}>Try again</SmallButton>
      </div>
    );
  }
  if (!monsters) return <Loading text="Loading the stat block…" />;
  return (
    <>
      {monster ? <StatBlockView view={monster} source="srd" credit /> : <Note>This token names an SRD monster this app does not have.</Note>}
      {props.dm ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: theme.space(2) }}>
          {monster ? <SmallButton onClick={props.onCopy}>Copy to this room’s monsters and edit</SmallButton> : null}
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
