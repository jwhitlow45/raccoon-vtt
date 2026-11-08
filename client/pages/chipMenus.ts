import type { Character, Handout, HandoutDoc, Member, Scene } from "#shared/model.ts";
import type { OpRefusal, RoomActions, Toast } from "../state/types.ts";
import { focusEvent, type Focus } from "../features/dm/camera.ts";
import { showHandoutOp } from "../features/handouts/handouts.ts";
import { offerable, reshowInput, type RecentHandout, type RecentRoom, type RecentShow } from "../features/handouts/recent.ts";
import { entryKey, reshowProblem, shownOf } from "../features/handouts/recentList.ts";
import { reasonText } from "../features/resources/logic.ts";
import { MOVING_PLAYERS, movePlayers, type MoveAnswer, type MoveRoom } from "../features/scenes/movePlayers.ts";
import {
  audienceDescription,
  CHIP_WORDS,
  DM_MENU_HEADINGS,
  followOnly,
  followOnlyDescription,
  hideTitle,
  moveRefused,
  onScene,
  playersOn,
  recentDetail,
  sheetOf,
  showPlayers,
  showTitle,
  viewAs,
  type DmItemKind,
  type DmMenuSection,
} from "./chipWords.ts";

/*
 * The top bar's menus as data (docs/design/design-v1-qol.md 6): the DM
 * menu, the Blackout menu and a player's You menu, each item with the run
 * function the menu calls and the search calls for the same item
 * (design-v1-qol.md 5, Acting), so both send the same op. Pure, for node
 * --test: the room comes in as a view, and the run reaches the room only
 * through `ChipEnv`.
 */

/** A player's You menu's items (design-v1-qol.md 4, C7). */
export type YouItemKind = "sheet" | "xcard";

/** What a run opened, which the room's chip dialogs or the preview draw (ChipMenus.tsx). */
export type ChipOpen =
  | { t: "handout" }
  | { t: "time" }
  | { t: "nowPlaying" }
  | { t: "xcard" }
  | { t: "viewAs"; memberId: string; name: string }
  | { t: "sheet"; characterId: string };

/** The room as a run reaches it. The menu builds one over its Room, and the search over its own. */
export type ChipEnv = {
  actions: Pick<RoomActions, "dispatch" | "newId" | "sendEph">;
  notify(text: string, tone: Toast["tone"]): void;
  /** What a move reads of the room (scenes/movePlayers.ts). */
  moveRoom: MoveRoom;
  /** Opens a dialog, a sheet, a panel's page or the preview, which hands focus back to whatever opened it. */
  open(what: ChipOpen): void;
  /** Where the DM's camera is (dm/camera.ts), for Bring everyone here. */
  focus(): Focus | null;
  /** A re-show the server took joins this device's recent handouts (recent.ts rememberShow). */
  remember(show: RecentShow): void;
};

/** How a move that went out ended, in the words an item shows. */
export type ChipAnswer = { t: "taken" } | { t: "refused"; words: string };

/**
 * What a run did. `done`: sent, or nothing to send. `ask`: nothing sent,
 * the item asks first, and runs again with `confirmed` once the viewer
 * says yes. `wait`: sent, and the answer settles with its words.
 * `opened`: a dialog, sheet, page or preview took focus.
 */
export type ChipRunResult = { t: "done" } | { t: "ask"; warning: string; anyway: string } | { t: "wait"; answer: Promise<ChipAnswer> } | { t: "opened" };

export type ChipRun = (env: ChipEnv, opts?: { confirmed?: boolean }) => ChipRunResult;

/** A line under an item's words: a warning a move asks about, why it was refused, or that it waits. */
export type ChipUnder = { text: string; tone: "warning" | "danger" | "busy" };

export type ChipItem = {
  id: string;
  kind: DmItemKind | YouItemKind | "cancel";
  title: string;
  /** As Menu's item kinds: a plain action, a switch of its own, or one of a choice. */
  role: "action" | "checkbox" | "radio";
  checked?: boolean;
  /** Muted words at its end, such as "Showing" or "to Pat". */
  note?: string;
  description?: string;
  disabled?: boolean;
  busy?: boolean;
  under?: ChipUnder;
  run: ChipRun;
};

export type ChipSection = { key: DmMenuSection | "blackout" | "you"; heading?: string; separator?: boolean; items: ChipItem[] };

/** A refused move to a scene deleted meanwhile: the server's own words ("scene is not here") read as a fault. */
export const SCENE_GONE = "That scene was deleted.";

const DONE: ChipRunResult = { t: "done" };
const OPENED: ChipRunResult = { t: "opened" };

/** The DM's view as the DM menu reads it. Every field is the room's own, `view` being the optimistic one. */
export type DmMenuView = {
  blackout: boolean;
  follow: boolean;
  /** The scene the DM looks at. */
  viewing: Scene | null;
  /** The players' scene's id and name. */
  playerScene: { id: string; name: string } | null;
  /**
   * Players hold the floor in view, an open floor of the players' scene
   * (docs/design/design-v1-floors.md 7.3, `openFloor`): Bring everyone here
   * and Look here have somewhere to send. On a scene with one floor, the
   * DM looks at the players' scene.
   */
  playersHoldHere: boolean;
  /** The floor in view lies in the players' scene, its main floor against `playerScene`'s (`onPlayersScene`). */
  playersSceneHere: boolean;
  /** The DM's camera is on the scene they look at, so Bring everyone here has a place to send. */
  focusHere: boolean;
  handouts: Readonly<Record<string, Handout | undefined>>;
  handoutDocs: Readonly<Record<string, HandoutDoc | undefined>>;
  members: Readonly<Record<string, Member | undefined>>;
  /** This device's recent handouts (recent.ts). */
  recent: readonly RecentHandout[];
  /** The handout images the library lists, or null before this device listed them (recent.ts RecentRoom). */
  images: ReadonlySet<string> | null;
  /** The clock chip's words while it gave way from the bar, so the menu holds Time, else null. */
  time: { text: string; name: string } | null;
  /** Now playing's chip gave way from the bar (the sound layout's SL-C). */
  nowPlaying: boolean;
  /** The scene a move this page sent is going to, before the server answers (movePlayers.ts movingPlayersTo). */
  movingTo: string | null;
  /** The scene a reveal's guarded lift names while it is out. Until it is answered the players still see black, so the blackout's items stay. */
  revealing: string | null;
  /** A move or a reveal has been out past the shared indicator's delay, when its item says "Moving players…". */
  outShown: boolean;
};

/** The most recent handouts the DM menu offers again (design-v1-qol.md 4, C1). */
export const MENU_RECENT = 3;

/** Names in a sentence for an audience of member ids: a re-show's audience as recent.ts offers it. */
function audienceNames(to: RecentHandout["to"], members: DmMenuView["members"]): "all" | string[] {
  return to === "all" ? "all" : to.map((id) => members[id]?.name ?? "").filter((name) => name !== "");
}

function refusalWords(refusal: OpRefusal | undefined): string {
  return refusal?.code === "gone" ? SCENE_GONE : reasonText(refusal);
}

/**
 * A move's answer in the item's words (design-v1-qol.md 4, C2's move). A
 * lost answer whose snapshot has the players elsewhere says so as a refusal
 * would, and any other lost answer is the snapshot's, which the view
 * already shows.
 */
export function moveWords(answer: MoveAnswer): ChipAnswer {
  if (answer.t === "notMoved") return { t: "refused", words: moveRefused(answer.sceneGone ? SCENE_GONE : answer.playersOn !== null ? playersOn(answer.playersOn) : reasonText(undefined)) };
  if (answer.t !== "refused") return { t: "taken" };
  return { t: "refused", words: answer.step === "lift" ? CHIP_WORDS.liftRefused : moveRefused(refusalWords(answer.refusal)) };
}

/** Move players here, or for a reveal Show players <scene>: through the one move helper, asking first where it warns, and quiet, since the item says the refusal itself. */
function moveRun(scene: Scene, reveal: boolean): ChipRun {
  return (env, opts) => {
    const step = movePlayers(env.actions, scene, env.moveRoom, { confirmed: opts?.confirmed === true, reveal, quiet: true });
    if (step.t === "ask") return { t: "ask", warning: step.warning, anyway: reveal ? CHIP_WORDS.showAnyway : CHIP_WORDS.moveAnyway };
    return { t: "wait", answer: step.answer.then(moveWords) };
  };
}

function send(op: Parameters<ChipEnv["actions"]["dispatch"]>[0]): ChipRun {
  return (env) => {
    env.actions.dispatch(op);
    return DONE;
  };
}

/** Whether a move of the players to the scene the DM looks at is still out, so its item stays, busy, though the view already shows them there. */
function moveOut(view: DmMenuView): boolean {
  return view.viewing !== null && view.movingTo === view.viewing.id;
}

/** Whether a reveal of the scene the DM looks at is still out: the move, or the lift after it. */
function revealOut(view: DmMenuView): boolean {
  return moveOut(view) || (view.viewing !== null && view.revealing === view.viewing.id);
}

/** The DM is on another scene than the players, or a move there is still out. */
function elsewhere(view: DmMenuView): boolean {
  return view.viewing !== null && (view.playerScene?.id !== view.viewing.id || moveOut(view));
}

/** The busy look of an item that is out: busy at once, "Moving players…" past the indicator's delay. */
function moving(view: DmMenuView, out: boolean): Pick<ChipItem, "busy" | "under"> {
  if (!out) return {};
  return view.outShown ? { busy: true, under: { text: MOVING_PLAYERS, tone: "busy" } } : { busy: true };
}

/**
 * The Blackout menu's items (design-v1-qol.md 4, C2): End the blackout, and while the
 * DM looks at another scene, Show players <scene>. They lead the DM menu
 * too during a blackout. Nothing while there is no blackout.
 */
export function blackoutItems(view: DmMenuView): ChipItem[] {
  if (!view.blackout && view.revealing === null) return [];
  const items: ChipItem[] = [{ id: "endBlackout", kind: "endBlackout", title: CHIP_WORDS.endBlackout, role: "action", description: CHIP_WORDS.endBlackoutDescription, run: send({ t: "view.blackout", blackout: false }) }];
  const scene = view.viewing;
  if (scene && (elsewhere(view) || revealOut(view))) {
    items.push({ id: "showPlayers", kind: "showPlayers", title: showPlayers(scene.name), role: "action", description: CHIP_WORDS.showPlayersDescription, ...moving(view, revealOut(view)), run: moveRun(scene, true) });
  }
  return items;
}

/**
 * The DM menu (design-v1-qol.md 4, C1, D-261106-121): during a blackout its two items
 * first, above a line, then Handouts, Players' screens, Map phase,
 * Preview, and what gave way from the bar. A section shows only while it
 * holds something.
 */
export function dmMenuSections(view: DmMenuView): ChipSection[] {
  const sections: ChipSection[] = [];
  const lead = blackoutItems(view);
  if (lead.length > 0) sections.push({ key: "blackout", items: lead });
  const separator = lead.length > 0;
  const section = (key: DmMenuSection, items: ChipItem[]) => {
    if (items.length > 0) sections.push({ key, heading: DM_MENU_HEADINGS[key], ...(separator && sections.length === 1 ? { separator: true } : {}), items });
  };

  // Handouts: Hide what shows, newest first, then up to three recent ones that do not show, then the form.
  const showing = Object.values(view.handouts)
    .filter((h): h is Handout => h !== undefined)
    .sort((a, b) => (a.shownAt < b.shownAt ? 1 : -1));
  const room: RecentRoom = { members: view.members, handoutDocs: view.handoutDocs, handouts: view.handouts, images: view.images };
  const recent = offerable(view.recent, room).slice(0, MENU_RECENT);
  section("handouts", [
    ...showing.map((h): ChipItem => ({ id: `hide:${h.id}`, kind: "hideHandout", title: hideTitle(h.title), role: "action", note: CHIP_WORDS.showing, run: send({ t: "handout.close", handoutId: h.id }) })),
    ...recent.map((entry): ChipItem => {
      const names = audienceNames(entry.to, view.members);
      return { id: `recent:${entryKey(entry)}`, kind: "showRecent", title: showTitle(entry.title), role: "action", note: recentDetail(entry.kind, names), description: audienceDescription(names), run: reshowRun(entry, room) };
    }),
    { id: "showHandout", kind: "showHandout", title: CHIP_WORDS.showHandout, role: "action", run: openRun({ t: "handout" }) },
  ]);

  // Players' screens: Black out (not during one, whose items lead), Follow me, then Bring everyone here or Move players here.
  const scene = view.viewing;
  const away = elsewhere(view);
  const players = view.playerScene?.name;
  const screens: ChipItem[] = [];
  if (!view.blackout && view.revealing === null) screens.push({ id: "blackout", kind: "blackout", title: CHIP_WORDS.blackout, role: "checkbox", checked: false, run: send({ t: "view.blackout", blackout: true }) });
  screens.push({
    id: "follow",
    kind: "follow",
    title: CHIP_WORDS.follow,
    role: "checkbox",
    checked: view.follow,
    // Enabled elsewhere too, as the panel's switch is, with the limit said on the item (ViewControls.tsx).
    ...(away && players ? { note: followOnly(players), description: followOnlyDescription(players) } : {}),
    run: send({ t: "view.follow", follow: !view.follow }),
  });
  if (scene && away) {
    screens.push({ id: "movePlayers", kind: "movePlayers", title: CHIP_WORDS.movePlayers, role: "action", note: onScene(scene.name), ...moving(view, moveOut(view)), run: moveRun(scene, false) });
  } else if (scene) {
    screens.push({ id: "bringEveryone", kind: "bringEveryone", title: CHIP_WORDS.bringEveryone, role: "action", disabled: !view.focusHere, run: bringRun(scene.id) });
  }
  section("screens", screens);

  // Map phase: the scene's phases as one choice, whenever it has two or more, so the menu keeps one shape at every width.
  const phases = scene?.phases ?? [];
  if (scene && phases.length > 1) {
    const current = scene.phaseId ?? phases[0]?.id;
    section(
      "phase",
      phases.map((p): ChipItem => ({ id: `phase:${p.id}`, kind: "phase", title: p.name, role: "radio", checked: p.id === current, run: p.id === current ? () => DONE : send({ t: "scene.setPhase", sceneId: scene.id, phaseId: p.id }) })),
    );
  }

  // Preview: View as each player, by name.
  const members = Object.values(view.members)
    .filter((m): m is Member => m !== undefined && m.kind === "player")
    .sort((a, b) => a.name.localeCompare(b.name));
  section(
    "preview",
    members.map((m): ChipItem => ({ id: `viewAs:${m.id}`, kind: "viewAs", title: viewAs(m.name), role: "action", run: openRun({ t: "viewAs", memberId: m.id, name: m.name }) })),
  );

  // What gave way from the bar: only while its chip is off the bar.
  if (view.time) section("time", [{ id: "time", kind: "time", title: view.time.text, role: "action", description: view.time.name, run: openRun({ t: "time" }) }]);
  if (view.nowPlaying) section("nowPlaying", [{ id: "nowPlaying", kind: "nowPlaying", title: DM_MENU_HEADINGS.nowPlaying, role: "action", run: openRun({ t: "nowPlaying" }) }]);
  return sections;
}

function openRun(what: ChipOpen): ChipRun {
  return (env) => {
    env.open(what);
    return OPENED;
  };
}

/** Bring everyone here sends the camera as it is, once, and says so (ViewControls.tsx), only while it stands on that scene. */
function bringRun(sceneId: string): ChipRun {
  return (env) => {
    const f = env.focus();
    if (!f || f.sceneId !== sceneId) return DONE;
    env.actions.sendEph(focusEvent(f));
    env.notify(CHIP_WORDS.bringEveryoneDone, "info");
    return DONE;
  };
}

/**
 * Show <title> again, at once, to the same audience less those who left
 * (recent.ts reshowInput). Remembered once taken, as the panel's Recent
 * row does, and a refusal is a toast, since the menu has closed by then.
 */
function reshowRun(entry: RecentHandout, room: RecentRoom): ChipRun {
  return (env) => {
    const input = reshowInput(entry, room, env.actions.newId());
    const result = input ? showHandoutOp(input) : null;
    if (!result?.ok) {
      env.notify(result?.error ?? reshowProblem("refused"), "error");
      return DONE;
    }
    const op = result.op;
    const n = env.actions.dispatch(op, {
      quiet: true,
      onAnswer: (answer, refusal) => {
        if (answer === "taken") env.remember(shownOf(op, entry));
        else env.notify(reshowProblem(answer, refusal), "error");
      },
    });
    if (n === null) env.notify(reshowProblem("refused"), "error");
    return DONE;
  };
}

/** A player's view as the You menu reads it: their own member and the characters their projection holds. */
export type YouMenuView = {
  memberId: string;
  member: Pick<Member, "name"> | undefined;
  /** A player's projection leaves out the owners of a character that is not theirs (`ownerIds ?? []`). */
  characters: Readonly<Record<string, (Pick<Character, "id" | "name"> & { ownerIds?: readonly string[] }) | undefined>>;
  /** The DM viewing as this player, where the X-card cannot be sent (XCardButton.tsx). */
  preview: boolean;
};

/** Said on the X-card item in a preview, as the Menu panel's X-card says it. */
export const XCARD_PREVIEW = "Not available while viewing as a player.";

/**
 * A player's You menu (design-v1-qol.md 4, C7), headed with their name: each
 * character they own, by name, opening its sheet, then X-card…. Only the
 * characters their projection lists with them among its owners.
 */
export function youMenuSections(view: YouMenuView): ChipSection[] {
  if (!view.member) return [];
  const own = Object.values(view.characters)
    .filter((c): c is NonNullable<typeof c> => c !== undefined && (c.ownerIds ?? []).includes(view.memberId))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [
    {
      key: "you",
      heading: view.member.name,
      items: [
        ...own.map((c): ChipItem => ({ id: `sheet:${c.id}`, kind: "sheet", title: sheetOf(c.name), role: "action", run: openRun({ t: "sheet", characterId: c.id }) })),
        { id: "xcard", kind: "xcard", title: CHIP_WORDS.xcard, role: "action", ...(view.preview ? { disabled: true, description: XCARD_PREVIEW } : {}), run: openRun({ t: "xcard" }) },
      ],
    },
  ];
}

// ---------------------------------------------------------------- the menu's own asking and answers

/** A run that asked, armed in the open menu: its item, the warning, and the anyway words. */
export type ChipAsk = { id: string; warning: string; anyway: string };

export const anywayId = (id: string) => `${id}:anyway`;
export const cancelId = (id: string) => `${id}:cancel`;

/**
 * The sections as the open menu draws them (design-v1-qol.md 4, C2's move, D-261106-136):
 * an item that asked stands as its anyway item, the warning under its
 * words and as its description, then Cancel. An item a refusal answered
 * shows why, under its words and as its description, until it is pressed
 * again or the menu closes.
 */
export function asDrawn(sections: readonly ChipSection[], host: { ask: ChipAsk | null; said: ReadonlyMap<string, string> }): ChipSection[] {
  return sections.map((s) => ({
    ...s,
    items: s.items.flatMap((item): ChipItem[] => {
      const ask = host.ask;
      if (ask && ask.id === item.id && !item.busy) {
        return [
          { ...item, id: anywayId(item.id), title: ask.anyway, note: undefined, description: ask.warning, under: { text: ask.warning, tone: "warning" }, run: (env) => item.run(env, { confirmed: true }) },
          { id: cancelId(item.id), kind: "cancel", title: CHIP_WORDS.cancel, role: "action", run: () => DONE },
        ];
      }
      const said = host.said.get(item.id);
      return said !== undefined && !item.busy ? [{ ...item, description: said, under: { text: said, tone: "danger" } }] : [item];
    }),
  }));
}

/** Every item drawn, in order. */
export function itemsOf(sections: readonly ChipSection[]): ChipItem[] {
  return sections.flatMap((s) => s.items);
}
