import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { Member, RoomState, Token } from "#shared/model.ts";
import { Button } from "../../components/Button.tsx";
import { IconButton } from "../../components/IconButton.tsx";
import { Menu } from "../../components/Menu.tsx";
import { menuAction } from "../../components/menuKeys.ts";
import { Popover, usePopover, type PopoverSide, type Rect } from "../../components/Popover.tsx";
import { useLayoutSize } from "../device/layout.ts";
import { uiScale } from "../device/settings.ts";
import { theme } from "../../lib/theme.ts";
import { scopeSlot, useScoped } from "../../state/scope.ts";
import { useRoomView } from "../../state/view.ts";
import { tokenOwnerIds } from "../tokens/access.ts";
import { SheetDialog } from "../tokens/SheetDialog.tsx";

/*
 * View as a player from wherever the DM stands (D-261027-09): the DM
 * panel's picker, a token's bar and its panel's header, and the eye beside
 * each player in its Owners group. Every entry opens the one preview this
 * Room holds (PlayerPreview.tsx ViewAsHost), so two entries can never stack two previews, and
 * each names the control focus returns to when the preview ends.
 */

export type ViewAsTarget = {
  memberId: string;
  /** The name to show until the room's copy of the member is read, and after the member left. */
  name: string;
  /** The control that opened it, which takes focus back on Exit: a list's own button, not the list item, which has gone by then. */
  returnFocus: HTMLElement | null;
};

export type ViewAs = {
  readonly store: StoreApi<{ target: ViewAsTarget | null }>;
  /** Opens the preview, unless one is open: the first stays, with the control it returns focus to. */
  open(target: ViewAsTarget): void;
  exit(): void;
};

export function createViewAs(): ViewAs {
  const store = createStore<{ target: ViewAsTarget | null }>(() => ({ target: null }));
  return {
    store,
    open(target) {
      if (store.getState().target === null) store.setState({ target });
    },
    exit() {
      store.setState({ target: null });
    },
  };
}

export const viewAsSlot = scopeSlot(createViewAs);

/**
 * The players the DM may view a token as: its owners, directly or through
 * its character, as the Owners group counts them, and for a companion
 * whoever plays its character. The server keeps a companion's owners in
 * step with its character's, and reading the character too covers a copy
 * caught between the two. The DM is never one, so a monster or NPC only the
 * DM controls gets none.
 */
export function viewAsPlayers(view: Pick<RoomState, "characters" | "members"> | null | undefined, token: Pick<Token, "ownerIds" | "actor" | "companion">): Member[] {
  if (!view) return [];
  const ids = new Set(tokenOwnerIds(view, token));
  const keeper = token.companion ? view.characters[token.companion.of] : undefined;
  for (const id of keeper?.ownerIds ?? []) ids.add(id);
  return [...ids]
    .map((id) => view.members[id])
    .filter((m): m is Member => m !== undefined && m.kind === "player")
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The players a token's View as offers this viewer: none for a player, or in a preview, which reads as a player. */
function useTokenPlayers(token: Pick<Token, "ownerIds" | "actor" | "companion">): Member[] {
  const dm = useRoomView((s) => s.you?.role === "dm");
  const members = useRoomView((s) => s.view?.members);
  const characters = useRoomView((s) => s.view?.characters);
  return useMemo(() => (dm && members && characters ? viewAsPlayers({ members, characters }, token) : []), [dm, members, characters, token]);
}

const VIEW_AS_A_PLAYER = "View as a player";

/**
 * A token's View as, in its bar and its panel's header: "View as Ana" for
 * one player owner, and with several, "View as a player" opening a list of
 * them, a menu from 900 px up and a bottom sheet on a phone, as Attach's
 * list opens. Nothing for a token with no player owner. `onOpen` hears
 * whether the menu is open, so the bar can stand over the notices while it
 * is, as it does for Attach (docs/design-v1-tool-options.md 7.6).
 */
export function ViewAsButton(props: { token: Pick<Token, "ownerIds" | "actor" | "companion">; style?: CSSProperties; onOpen?(open: boolean): void }) {
  const players = useTokenPlayers(props.token);
  const wide = useLayoutSize().width >= theme.layout.wideMinWidth;
  const only = players.length === 1 ? players[0] : undefined;
  if (only) return <ViewAsOne player={only} style={props.style} />;
  if (players.length === 0) return null;
  return wide ? <ViewAsMenu players={players} style={props.style} onOpen={props.onOpen} /> : <ViewAsSheet players={players} style={props.style} />;
}

function ViewAsOne(props: { player: Member; style: CSSProperties | undefined }) {
  const viewAs = useScoped(viewAsSlot);
  const { player } = props;
  return (
    <Button size="sm" icon="viewAs" onClick={(e) => viewAs.open({ memberId: player.id, name: player.name, returnFocus: e.currentTarget })} style={props.style}>
      View as {player.name}
    </Button>
  );
}

function ViewAsMenu(props: { players: readonly Member[]; style: CSSProperties | undefined; onOpen: ((open: boolean) => void) | undefined }) {
  const viewAs = useScoped(viewAsSlot);
  const menu = usePopover({ kind: "menu" });
  const { onOpen } = props;
  const open = menu.open;
  useEffect(() => {
    onOpen?.(open);
  }, [open, onOpen]);
  // The bar stands back under the notices when the menu goes with its button, which a switch to one owner or a phone's width does.
  useEffect(() => () => onOpen?.(false), [onOpen]);
  const anchor = useRef<HTMLElement | null>(null);
  // Toward the larger room, as Attach's list opens: the panel header's copy stands near the side panel's top, a bar's wherever it hangs.
  const [side, setSide] = useState<PopoverSide>("above");
  const { ref, onClick, onKeyDown, ...anchorProps } = menu.anchorProps;
  // Down and Up open a menu without a click, so every way it opens decides first.
  const decideSide = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (r) setSide(r.top + r.height / 2 > window.innerHeight / 2 ? "above" : "below");
  };
  return (
    <>
      <Button
        {...anchorProps}
        ref={(el: HTMLButtonElement | null) => {
          ref(el);
          anchor.current = el;
        }}
        onClick={(e) => {
          if (!menu.open) decideSide();
          onClick(e);
        }}
        onKeyDown={(e) => {
          if (!menu.open && (e.key === "ArrowDown" || e.key === "ArrowUp")) decideSide();
          onKeyDown(e);
        }}
        size="sm"
        icon="viewAs"
        style={props.style}
      >
        {VIEW_AS_A_PLAYER}
      </Button>
      <Popover handle={menu} side={side} bound={viewportBound}>
        <Menu
          label={VIEW_AS_A_PLAYER}
          sections={[{ key: "players", items: props.players.map((p) => ({ id: p.id, title: p.name, kind: "action" as const })) }]}
          onPick={(id) => {
            const player = props.players.find((p) => p.id === id);
            if (player) viewAs.open({ memberId: player.id, name: player.name, returnFocus: anchor.current });
          }}
        />
      </Popover>
    </>
  );
}

/** A phone's list of players, in a bottom sheet. Down and Up move between them and wrap, Home and End go to the ends, as a menu's keys do. */
function ViewAsSheet(props: { players: readonly Member[]; style: CSSProperties | undefined }) {
  const viewAs = useScoped(viewAsSlot);
  const opener = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const items = useRef<(HTMLButtonElement | null)[]>([]);
  const pick = (player: Member) => {
    setOpen(false);
    viewAs.open({ memberId: player.id, name: player.name, returnFocus: opener.current });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const index = items.current.findIndex((el) => el === document.activeElement);
    const action = menuAction({ key: e.key, letter: null, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey }, index, props.players.length, false);
    if (action.type !== "focus") return;
    e.preventDefault();
    items.current[action.index]?.focus();
  };
  return (
    <>
      <Button ref={opener} size="sm" icon="viewAs" aria-haspopup="menu" expanded={open} onClick={() => setOpen(true)} style={props.style}>
        {VIEW_AS_A_PLAYER}
      </Button>
      {open ? (
        <SheetDialog title={VIEW_AS_A_PLAYER} opener={opener} onClose={() => setOpen(false)} width={theme.layout.dialog.sm}>
          <div role="menu" aria-label={VIEW_AS_A_PLAYER} onKeyDown={onKeyDown} style={{ display: "grid", gap: theme.space(1) }}>
            {props.players.map((p, i) => (
              <Button
                key={p.id}
                ref={(el: HTMLButtonElement | null) => {
                  items.current[i] = el;
                }}
                role="menuitem"
                // The first takes focus as the sheet opens, so Down and Up move at once, as in a menu.
                autoFocus={i === 0}
                onClick={() => pick(p)}
                style={{ justifyContent: "flex-start" }}
              >
                {p.name}
              </Button>
            ))}
          </div>
        </SheetDialog>
      ) : null}
    </>
  );
}

/** The eye beside a player in a token's Owners group: one tap to that player's view. */
export function ViewAsEye(props: { player: Pick<Member, "id" | "name"> }) {
  const viewAs = useScoped(viewAsSlot);
  const dm = useRoomView((s) => s.you?.role === "dm");
  const { player } = props;
  if (!dm) return null;
  return <IconButton icon="viewAs" label={`View as ${player.name}`} onClick={(e) => viewAs.open({ memberId: player.id, name: player.name, returnFocus: e.currentTarget })} />;
}

function viewportBound(): Rect {
  const scale = uiScale();
  return { left: 0, top: 0, right: window.innerWidth / scale, bottom: window.innerHeight / scale };
}
