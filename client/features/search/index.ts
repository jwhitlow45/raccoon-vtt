import { formatFormula, parseFormula } from "#shared/dice/formula.ts";
import type { ProjectedActor } from "#shared/project.ts";
import { CONDITIONS } from "#shared/srd/conditions.ts";
import type { SrdMonster } from "#shared/srd/monsters.ts";
import { STATUSES } from "#shared/srd/statuses.ts";
import { displayName } from "../../lib/scene.ts";
import { shortcutsFor, type Shortcut } from "../../state/shortcuts.ts";
import type { RoomView } from "../../state/types.ts";
import { panelsFor, SOUND_PANEL, type PanelsForOptions } from "../panels.ts";
import type { DmMenuView } from "../../pages/chipMenus.ts";
import { ownsCharacter, tokenAccess } from "../tokens/access.ts";
import { EVERYONE } from "./catalog/everyone.ts";
import type { Catalog, CatalogEntry, FieldDef, FieldPlace, PanelWords, SearchContext, SearchRole } from "./catalog/types.ts";
import type { DmCatalog, DmCatalogState } from "./dmCatalog.ts";
import type { SearchAct, SearchEntry, SearchRoute } from "./entry.ts";
import { indexed, MAX_ROWS, parseQuery, rank, type Indexed } from "./match.ts";
import { recentEntries } from "./recent.ts";
import { ROW_WORDS, TOKEN_KIND_WORD } from "./words.ts";

/**
 * The room search's index for one viewer (designs/qol/search.md 5.10),
 * built from four sources: the panels the role is offered, its keys, the
 * catalogs it holds, and the room's own things read only from this
 * device's view. For a player that view is the projection the server sent
 * (shared/project.ts), so nothing hidden from them can be indexed, and the
 * kinds a player has no panel for (scenes, monsters, music) are not built
 * at all (search.md 5.9). It never reads notes, and a token is indexed by
 * the name its view carries, so a hidden name's true one is never typed
 * into a match.
 */

/** Where a record opens: a panel's page by kind and id, "scene:<id>", which the route (lane S1's `openAt`) reads back. */
export function recordPage(kind: "scene" | "srd" | "monster" | "playlist" | "track" | "page" | "handout" | "doc" | "character", id: string): string {
  return `${kind}:${id}`;
}

/**
 * The anchors the index's own rows route to, beside the catalogs' own: a
 * playlist's row and its Play and a track's Play in Sound's Library, Open
 * on a handout a player's Library shows, and Place on a monster's card.
 * Each is on the control of the record the route names alone
 * (music/Library.tsx, panels/LibraryPanel.tsx), and the anchor scan reads
 * this list with the catalogs' (search.md 5.10).
 */
export const PLAYLIST_ANCHOR = "sound.playlist";
export const PLAY_PLAYLIST_ANCHOR = "sound.playlist.play";
export const TRACK_ANCHOR = "sound.track";
export const OPEN_HANDOUT_ANCHOR = "library.handout.open";
export const PLACE_MONSTER_ANCHOR = "monsters.card.place";
export const VIEW_ANCHORS: readonly string[] = [PLAYLIST_ANCHOR, PLAY_PLAYLIST_ANCHOR, TRACK_ANCHOR, OPEN_HANDOUT_ANCHOR, PLACE_MONSTER_ANCHOR];

/**
 * The Suggested list's order on an empty field (search.md 5.2), lowest
 * first: in a fight Next turn, else Start a fight, then Show a handout…,
 * Black out players' screens, Long Rest for the party and Sound for a DM,
 * and a player's characters, Dice and the X-card. The index gives the
 * panels', keys' and characters' numbers. The catalogs' entries take theirs
 * from here, written on each entry as `suggest`.
 */
export const SUGGEST = {
  nextTurn: 0,
  ownCharacter: 1,
  startFight: 10,
  showHandout: 20,
  dice: 20,
  blackout: 30,
  xCard: 30,
  longRest: 40,
  sound: 90,
} as const;

/** The keys this device has now: whether each applies (its `when` with the room's env, state/shortcuts.ts) and its key as the sheet writes it. */
export type KeySource = {
  applies(shortcut: Shortcut): boolean;
  text(id: string): string;
};

export type IndexInput = {
  state: RoomView;
  /** From 900 px up, where the side panel stands in for the narrow-only panels (panelsFor). */
  wide: boolean;
  /** What a player's panel list waits for (panelsFor), as the Room works it out. */
  panelOptions?: PanelsForOptions;
  keys: KeySource;
  /** The catalogs this viewer holds (catalogsFor). */
  catalogs: readonly Catalog[];
  /** The SRD monsters once their chunk is in, for a DM (loadedMonsters). */
  monsters: readonly SrdMonster[] | null;
  /** The DM menu's view for a DM's search (catalog/types.ts SearchContext). */
  dmMenu?: DmMenuView;
};

export type SearchIndex = {
  role: SearchRole;
  items: readonly Indexed[];
  byId: ReadonlyMap<string, Indexed>;
  /** The empty field's Suggested list, in its order. */
  suggested: readonly SearchEntry[];
};

/** The role a search runs as. One not yet known searches as a player, who holds the least. */
export function searchRole(state: Pick<RoomView, "you">): SearchRole {
  return state.you?.role === "dm" ? "dm" : "player";
}

/**
 * The catalogs a viewer's index reads: everyone's, and the DM's once it is
 * on this device. Only a DM's asks for the DM's, so a player's search never
 * starts its load (dmCatalog.ts). `dm` says how that load stands, for the
 * sheet's loading and failed rows.
 */
export function catalogsFor(state: Pick<RoomView, "you">, dm: Pick<DmCatalog, "request">): { catalogs: Catalog[]; dm: DmCatalogState } {
  if (searchRole(state) !== "dm") return { catalogs: [EVERYONE], dm: { status: "none" } };
  const loaded = dm.request(state.you?.role);
  return { catalogs: loaded.status === "ready" ? [EVERYONE, loaded.catalog] : [EVERYONE], dm: loaded };
}

/** A key's title where its sheet words read oddly alone. */
function keyTitle(s: Shortcut, role: SearchRole): string {
  if (s.id.startsWith("tool:")) return `${s.name ?? s.does} tool`;
  if (s.id === "turn") return role === "dm" ? "Next turn" : "End turn";
  if (s.id === "sheet") return "Show the shortcuts";
  // The sheet's sentence says what a digit does. The row's press takes the viewer to the HP field to type the change.
  if (s.id === "hpDigit") return "Change HP";
  return s.does;
}

/** Static entries and SRD monsters keep their folded words for the page's life, since neither changes. */
const kept = new WeakMap<object, Indexed>();

function keptIndexed(source: object, make: () => SearchEntry): Indexed {
  let item = kept.get(source);
  if (!item) {
    item = indexed(make());
    kept.set(source, item);
  }
  return item;
}

class Builder {
  readonly items: Indexed[] = [];
  readonly byId = new Map<string, Indexed>();
  readonly suggested: { at: number; n: number; entry: SearchEntry }[] = [];

  /** Adds an entry. A second with the same id is dropped: ids are unique in an index (entry.ts), and the first source wins. */
  add(item: Indexed, suggest?: number): void {
    if (this.byId.has(item.entry.id)) return;
    this.byId.set(item.entry.id, item);
    this.items.push(item);
    if (suggest !== undefined) this.suggested.push({ at: suggest, n: this.suggested.length, entry: item.entry });
  }

  entry(entry: SearchEntry, suggest?: number): void {
    this.add(indexed(entry), suggest);
  }
}

function catalogEntry(e: CatalogEntry, ctx: SearchContext): Indexed {
  const { when: _when, valueNow, suggest: _suggest, ...entry } = e;
  if (!valueNow) return keptIndexed(e, () => entry);
  const value = valueNow(ctx);
  return indexed(value === undefined ? entry : { ...entry, value });
}

function mergedPanelWords(catalogs: readonly Catalog[]): Map<string, PanelWords> {
  const out = new Map<string, PanelWords>();
  for (const c of catalogs) {
    for (const [id, words] of Object.entries(c.panels)) {
      const had = out.get(id);
      out.set(id, { names: [...(had?.names ?? []), ...(words.names ?? [])], bets: [...(had?.bets ?? []), ...(words.bets ?? [])] });
    }
  }
  return out;
}

/** A field's entry for one creature: its title, the creature's name as where it lives, and the value as this device holds it. */
function fieldEntry(f: FieldDef, holder: string, name: string, actor: ProjectedActor | undefined, near: boolean, act: SearchAct): SearchEntry {
  const value = actor ? f.value?.(actor) : undefined;
  return {
    id: `field:${holder}:${f.key}`,
    kind: f.kind ?? "field",
    title: f.title,
    ...(f.names ? { names: f.names } : null),
    ...(f.bets ? { bets: f.bets } : null),
    where: name,
    icon: f.icon,
    ...(value ? { value } : null),
    ...(near ? { near: true } : null),
    act,
  };
}

function fieldRoute(panel: string, place: FieldPlace, page?: string): SearchRoute {
  return { panel, ...(page ? { page } : null), ...(place.section ? { section: place.section } : null), anchor: place.anchor };
}

export function buildIndex(input: IndexInput): SearchIndex {
  const { state } = input;
  const role = searchRole(state);
  const memberId = state.you?.memberId ?? null;
  const ctx: SearchContext = { role, memberId, state, wide: input.wide, ...(input.dmMenu ? { dmMenu: input.dmMenu } : null) };
  const b = new Builder();

  const panelWords = mergedPanelWords(input.catalogs);
  for (const p of panelsFor(role, input.wide, input.panelOptions)) {
    const words = panelWords.get(p.id);
    const entry: SearchEntry = {
      id: `panel:${p.id}`,
      kind: "panel",
      title: p.title,
      ...(words?.names?.length ? { names: words.names } : null),
      ...(words?.bets?.length ? { bets: words.bets } : null),
      where: "",
      icon: p.icon,
      act: { t: "open", route: { panel: p.id } },
    };
    const suggest = role === "dm" && p.id === SOUND_PANEL ? SUGGEST.sound : role === "player" && p.id === "dice" ? SUGGEST.dice : undefined;
    b.add(words ? indexed(entry) : keptIndexed(p, () => entry), suggest);
  }

  for (const s of shortcutsFor(role)) {
    // The arrows and Page keys need a direction and a selection the search cannot give.
    if (s.navigation || !input.keys.applies(s)) continue;
    const title = keyTitle(s, role);
    const names = [s.name, s.does].filter((n): n is string => n !== undefined && n !== title);
    b.entry(
      {
        id: `key:${s.id}`,
        kind: "key",
        title,
        ...(names.length > 0 ? { names } : null),
        where: s.id.startsWith("tool:") ? ROW_WORDS.toolbar : ROW_WORDS.shortcuts,
        icon: "more",
        keys: input.keys.text(s.id),
        act: { t: "key", shortcut: s.id },
      },
      s.id === "turn" ? SUGGEST.nextTurn : undefined,
    );
  }

  const fields: FieldDef[] = [];
  for (const c of input.catalogs) {
    for (const e of c.entries) if (!e.when || e.when(ctx)) b.add(catalogEntry(e, ctx), e.suggest);
    for (const e of c.items?.(ctx) ?? []) b.add(catalogEntry(e, ctx), e.suggest);
    fields.push(...c.fields);
  }

  const view = state.view;
  if (!view) return finish(role, b);
  const sceneId = state.sceneId;
  const sceneName = sceneId ? view.scenes[sceneId]?.name : undefined;

  // The selection's fields and conditions, near the top while it is chosen, for a token the viewer may change.
  const selectedId = state.local.selectedId;
  const selected = selectedId ? view.tokens[selectedId] : undefined;
  let selectionCharacter: string | null = null;
  if (selected && selected.sceneId === sceneId && tokenAccess({ role, memberId, view, token: selected }).full) {
    const name = displayName(selected);
    const character = "ref" in selected.actor ? view.characters[selected.actor.ref] : undefined;
    const actor = "inline" in selected.actor ? selected.actor.inline : character?.actor;
    if (character) selectionCharacter = character.id;
    for (const f of fields) {
      if (!f.token || f.shown?.({ surface: "token", role, memberId, token: selected, ...(character ? { character } : null) }) === false) continue;
      b.entry(fieldEntry(f, `token:${selected.id}`, name, actor, true, { t: "open", route: fieldRoute("token", f.token) }));
    }
    const effects = actor?.effects ?? [];
    const conditions = [...Object.values(CONDITIONS).map((c) => ({ key: c.key, name: c.name })), ...Object.values(STATUSES).map((s) => ({ key: s.key, name: s.label }))];
    for (const c of conditions) {
      const has = effects.some((e) => e.key === c.key);
      b.entry({
        id: `condition:${c.key}`,
        kind: "condition",
        title: c.name,
        where: has ? ROW_WORDS.removeFrom(name) : ROW_WORDS.addTo(name),
        icon: "combat",
        near: true,
        act: { t: "condition", condition: c.key, remove: has },
      });
    }
  }

  for (const tk of Object.values(view.tokens)) {
    if (tk.sceneId !== sceneId) continue;
    const kind = TOKEN_KIND_WORD[tk.kind];
    // A DM may type a hidden name's public one ("Hooded figure"). A player's view carries only that one, as the name.
    const publicName = role === "dm" && tk.nameHidden && tk.publicName ? [tk.publicName] : null;
    b.entry({
      id: `token:${tk.id}`,
      kind: "token",
      title: displayName(tk),
      ...(publicName ? { names: publicName } : null),
      where: sceneName ? ROW_WORDS.tokenOn(kind, sceneName) : kind,
      icon: "token",
      ...(role === "dm" && tk.visibility === "dm" ? { mark: ROW_WORDS.hidden } : null),
      act: { t: "token", tokenId: tk.id },
    });
  }

  // A DM finds every character and the few fields play reads. A player finds only their own, every field, ranked first.
  for (const ch of Object.values(view.characters)) {
    const own = role === "player" && ownsCharacter(memberId, ch);
    if (role === "player" && !own) continue;
    b.entry(
      { id: `character:${ch.id}`, kind: "character", title: ch.name, where: "", icon: "characters", ...(own ? { near: true } : null), act: { t: "character", characterId: ch.id } },
      own ? SUGGEST.ownCharacter : undefined,
    );
    const page = recordPage("character", ch.id);
    for (const f of fields) {
      if (!f.page || (role === "dm" && !f.everyCharacter) || f.shown?.({ surface: "page", role, memberId, character: ch }) === false) continue;
      // The selected token's own field stands for its character's, so the two never list as twins.
      if (ch.id === selectionCharacter && f.token) continue;
      b.entry(fieldEntry(f, `character:${ch.id}`, ch.name, ch.actor, own, { t: "character", characterId: ch.id, route: fieldRoute("characters", f.page, page) }));
    }
  }

  if (role === "dm") {
    const playersOn = view.meta.playerSceneId;
    for (const sc of Object.values(view.scenes)) {
      const where = [sc.id === sceneId ? ROW_WORDS.youAreHere : null, sc.id === playersOn ? ROW_WORDS.playersAreHere : null].filter((w) => w !== null).join(" · ");
      b.entry({ id: `scene:${sc.id}`, kind: "scene", title: sc.name, where, icon: "scenes", act: { t: "open", route: { panel: "scenes", page: recordPage("scene", sc.id) } } });
    }
    for (const m of input.monsters ?? []) {
      b.add(
        keptIndexed(m, () => ({
          id: `monster:srd:${m.srdId}`,
          kind: "monster",
          title: m.name,
          where: ROW_WORDS.monster(m.cr, m.type),
          icon: "monsters",
          act: { t: "open", route: { panel: "monsters", page: recordPage("srd", m.srdId), anchor: PLACE_MONSTER_ANCHOR } },
        })),
      );
    }
    for (const m of Object.values(view.monsters)) {
      b.entry({
        id: `monster:${m.id}`,
        kind: "monster",
        title: m.name,
        where: `${ROW_WORDS.monster(m.cr, m.type)} · ${ROW_WORDS.roomMonster}`,
        icon: "monsters",
        act: { t: "open", route: { panel: "monsters", page: recordPage("monster", m.id), anchor: PLACE_MONSTER_ANCHOR } },
      });
    }
    const music = view.playing?.music ?? null;
    for (const pl of Object.values(view.playlists ?? {})) {
      const page = recordPage("playlist", pl.id);
      b.entry({ id: `playlist:${pl.id}`, kind: "playlist", title: pl.name, where: ROW_WORDS.tracks(pl.sounds.length), icon: "music", act: { t: "open", route: { panel: SOUND_PANEL, page, anchor: PLAYLIST_ANCHOR } } });
      // Playing, its row's button is Pause, which Play would press.
      if (music?.playlistId === pl.id && music.paused === undefined) continue;
      b.entry({
        id: `action:play:${pl.id}`,
        kind: "action",
        title: ROW_WORDS.play(pl.name),
        where: ROW_WORDS.library,
        icon: "play",
        act: { t: "open", route: { panel: SOUND_PANEL, page, anchor: PLAY_PLAYLIST_ANCHOR, press: true } },
      });
    }
    for (const so of Object.values(view.sounds ?? {})) {
      if (so.use !== "music" || !so.name) continue;
      b.entry({ id: `track:${so.id}`, kind: "track", title: so.name, where: ROW_WORDS.library, icon: "music", act: { t: "open", route: { panel: SOUND_PANEL, page: recordPage("track", so.id), anchor: TRACK_ANCHOR } } });
    }
    for (const doc of Object.values(view.handoutDocs)) {
      b.entry({
        id: `handout:doc:${doc.id}`,
        kind: "handout",
        title: doc.title,
        where: ROW_WORDS.library,
        icon: "library",
        act: { t: "open", route: { panel: "dm", section: "handouts", page: recordPage("doc", doc.id) } },
      });
    }
  }

  for (const j of Object.values(view.journal)) {
    b.entry({ id: `page:${j.id}`, kind: "page", title: j.title, where: j.folder ?? ROW_WORDS.journal, icon: "journal", act: { t: "open", route: { panel: "journal", page: recordPage("page", j.id) } } });
  }

  // A DM's showings are in the DM panel's Handouts, which opens one's viewer, a player's in Library, whose Open opens it.
  const handoutRoute = (id: string): SearchRoute =>
    role === "dm" ? { panel: "dm", section: "handouts", page: recordPage("handout", id) } : { panel: "library", page: recordPage("handout", id), anchor: OPEN_HANDOUT_ANCHOR, press: true };
  for (const h of Object.values(view.handouts)) {
    b.entry({ id: `handout:${h.id}`, kind: "handout", title: h.title, where: ROW_WORDS.showing, icon: "library", act: { t: "open", route: handoutRoute(h.id) } });
  }

  return finish(role, b);
}

function finish(role: SearchRole, b: Builder): SearchIndex {
  const suggested = [...b.suggested].sort((x, y) => x.at - y.at || x.n - y.n).map((s) => s.entry);
  return { role, items: b.items, byId: b.byId, suggested };
}

/** A typed dice formula's row, "Roll 2d6+3", which rolls as the Dice panel's Roll does. Null for anything that is not one. */
export function diceRow(text: string): SearchEntry | null {
  const typed = text.trim();
  if (!/d\d/i.test(typed)) return null;
  const parsed = parseFormula(typed);
  if (!parsed.ok) return null;
  const formula = formatFormula(parsed.formula);
  return { id: `dice:${formula}`, kind: "dice", title: ROW_WORDS.roll(formula), where: ROW_WORDS.dice, icon: "dice", act: { t: "roll", formula } };
}

export type SearchResults =
  /** An empty field: this device's recent picks the index still holds, then Suggested without them. */
  | { t: "empty"; recent: SearchEntry[]; suggested: SearchEntry[] }
  /** One ranked list, best first, a typed dice formula's row on top. */
  | { t: "typed"; rows: SearchEntry[] };

/**
 * What the sheet lists for a field's text. Recent picks show only on an
 * empty field, as their own section: a typed list is the matcher's alone
 * and never reorders by use (D-261106-175).
 */
export function searchResults(index: SearchIndex, text: string, recent: readonly string[]): SearchResults {
  const q = parseQuery(text);
  if (q.words.length === 0) {
    const shown = recentEntries(recent, index.byId);
    const ids = new Set(shown.map((e) => e.id));
    return { t: "empty", recent: shown, suggested: index.suggested.filter((e) => !ids.has(e.id)) };
  }
  const rows = rank(index.items, q);
  const roll = diceRow(text);
  return { t: "typed", rows: roll ? [roll, ...rows].slice(0, MAX_ROWS) : rows };
}
