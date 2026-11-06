import "../../../components/testing/register.ts";
import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import type { MusicRun, Playlist, Sound } from "#shared/sound.ts";
import type { MakerDraft } from "./open.ts";

/*
 * The Music window's own rules (docs/design/design-v1-music-player.md 4,
 * 5 and 10): Library's search and sort, its More menus' notes, the row's
 * Play and Pause, the maker's draft and what Save sends, and the seek in
 * hand.
 */

const { libraryPlaylists, libraryTracks, matches, playlistChoices, queueNote, rowPlay } = await import("./Library.tsx");
const { changedFields, draftDirty, draftOf, makerStatus, newDraft, savedName, savedPlaylist, savedTracks, useMakerControl } = await import("./Maker.tsx");
const { drawn } = await import("../../../components/testing/drawn.ts");
const { seekGesture, seekHolds } = await import("./NowFull.tsx");
const { queueLists } = await import("./dragOrder.ts");
const words = await import("./words.ts");

const sound = (id: string, ms: number, name: string, use: Sound["use"] = "music"): Sound => ({ id, rev: 1, name, assetId: `a-${id}`, ms, use });
const T = 1_000_000;

describe("Library's search and sort", () => {
  const sounds = Object.fromEntries(
    [sound("h1", 128_000, "Harbor at dusk"), sound("h2", 262_000, "Harbor storm"), sound("h3", 95_000, "Hárbor watch"), sound("t1", 196_000, "Tavern theme"), sound("rain", 3_000, "Harbor rain", "loop")].map((s) => [s.id, s]),
  );

  test("a search matches names whatever their case and accents, and only music", () => {
    assert.equal(matches("Hárbor watch", "harbor"), true);
    assert.equal(matches("Harbor storm", "STORM"), true);
    assert.equal(matches("Tavern theme", "harbor"), false);
    assert.equal(matches("Tavern theme", "  "), true, "an empty search keeps every row");
    assert.deepEqual(libraryTracks(sounds, "harbor", "name").map((s) => s.id), ["h1", "h2", "h3"]);
  });

  test("Longest first and Shortest first sort the tracks, and Name sorts by name", () => {
    assert.deepEqual(libraryTracks(sounds, "", "long").map((s) => s.id), ["h2", "t1", "h1", "h3"]);
    assert.deepEqual(libraryTracks(sounds, "", "short").map((s) => s.id), ["h3", "h1", "t1", "h2"]);
    assert.deepEqual(libraryTracks(sounds, "", "name").map((s) => s.id), ["h1", "h2", "h3", "t1"]);
  });

  test("playlists stay by name and match the search too", () => {
    const pl = (id: string, name: string): Playlist => ({ id, rev: 1, name, sounds: [], repeat: "all", fade: 5 });
    const playlists = { b: pl("b", "Travel"), a: pl("a", "Battle"), c: pl("c", "Boss themes") };
    assert.deepEqual(libraryPlaylists(playlists, "").map((p) => p.id), ["a", "c", "b"]);
    assert.deepEqual(libraryPlaylists(playlists, "b").map((p) => p.id), ["a", "c"]);
  });

  test("the counts and the no-match lines", () => {
    assert.equal(words.trackCount(3, 100, true), "3 of 100");
    assert.equal(words.trackCount(100, 100, false), "100");
    assert.equal(words.noTrackMatches("harbor"), 'No track matches "harbor".');
    assert.equal(words.noPlaylistMatches("x"), 'No playlist matches "x".');
  });
});

describe("the More menus' notes", () => {
  const ids = ["a", "b", "c", "d", "e"];
  const lengths = Object.fromEntries(ids.map((id) => [id, { ms: 60_000, use: "music" as const }]));
  const run = (repeat: MusicRun["repeat"]): MusicRun => ({ run: "r", order: ids, index: 2, repeat, fade: 0, now: { soundId: "c", at: T } });

  test("Add to queue: Playing on the playing track, In the queue while still to come, open for a track not queued", () => {
    const all = queueLists(run("all"), lengths, T + 1_000)!;
    assert.equal(queueNote(all, "c"), words.PLAYING_NOTE);
    assert.equal(queueNote(all, "a"), words.IN_THE_QUEUE, "under Repeat all a track heard comes round again");
    assert.equal(queueNote(all, "e"), words.IN_THE_QUEUE);
    assert.equal(queueNote(all, "z"), null);
    const off = queueLists(run("off"), lengths, T + 1_000)!;
    assert.equal(queueNote(off, "a"), null, "under Repeat off a heard track can be queued again, at the end");
    assert.equal(queueNote(off, "e"), words.IN_THE_QUEUE);
  });

  test("Add to playlist: each playlist by name, one that holds the track or is full disabled with why, then a new one with it", () => {
    const pl = (id: string, name: string, sounds: string[]): Playlist => ({ id, rev: 1, name, sounds, repeat: "all", fade: 5 });
    const full = Array.from({ length: 100 }, (_, i) => `f${i}`);
    const items = playlistChoices({ t: pl("t", "Tavern night", ["a"]), b: pl("b", "Battle", []), x: pl("x", "Big", full) }, "a");
    assert.deepEqual(
      items.map((i) => [i.title, i.disabled === true, i.note ?? null]),
      [
        ["Battle", false, null],
        ["Big", true, "100 tracks"],
        ["Tavern night", true, "Already in it"],
        [words.NEW_PLAYLIST_WITH, false, null],
      ],
    );
  });
});

describe("a row's Play and Pause (D-261102-951)", () => {
  const run = { run: "r", playlistId: "pl", order: ["pony", "road"], index: 0, repeat: "all" as const, fade: 5 as const, now: { soundId: "pony", at: T } };

  test("Pause on the track Now playing names and on the playlist the run plays, Play to resume them while paused, and Play elsewhere", () => {
    assert.equal(rowPlay(null, { soundId: "pony" }, T), "play");
    assert.equal(rowPlay(run, { soundId: "pony" }, T + 1_000), "pause");
    assert.equal(rowPlay(run, { playlistId: "pl" }, T + 1_000), "pause");
    assert.equal(rowPlay(run, { soundId: "road" }, T + 1_000), "play");
    assert.equal(rowPlay({ ...run, playlistId: undefined }, { playlistId: "pl" }, T + 1_000), "play", "a track played alone marks no playlist");
    assert.equal(rowPlay({ ...run, paused: 4_000 }, { soundId: "pony" }, T + 90_000), "resume");
    const crossing = { ...run, next: { soundId: "road", at: T + 25_000 } };
    assert.equal(rowPlay(crossing, { soundId: "pony" }, T + 25_000), "play");
    assert.equal(rowPlay(crossing, { soundId: "road" }, T + 25_000), "pause");
  });
});

describe("the maker's draft", () => {
  const sounds = Object.fromEntries([sound("a", 60_000, "A"), sound("b", 60_000, "B"), sound("c", 60_000, "C"), sound("loop", 3_000, "L", "loop")].map((s) => [s.id, s]));
  const saved: Playlist = { id: "pl", rev: 4, name: "Tavern night", sounds: ["a", "b"], repeat: "all", fade: 5 };

  test("a saved playlist's draft changes nothing until edited, then Save sends only what changed", () => {
    const draft = draftOf(saved);
    assert.deepEqual(changedFields(draft, sounds), {});
    assert.equal(draftDirty(draft, sounds), false);
    assert.deepEqual(changedFields({ ...draft, name: "Tavern late" }, sounds), { name: "Tavern late" }, "a rename sends the name alone");
    assert.deepEqual(changedFields({ ...draft, sounds: ["b", "a"] }, sounds), { sounds: ["b", "a"] });
    assert.deepEqual(changedFields({ ...draft, shuffle: true, fade: 10 }, sounds), { shuffle: true, fade: 10 });
    assert.equal(draftDirty({ ...draft, repeat: "off" }, sounds), true);
    assert.deepEqual(changedFields({ ...draft, name: "  Tavern night  " }, sounds), {}, "spaces around the same name change nothing");
  });

  test("a new playlist sends every field, an empty name as New playlist, and tracks no longer music drop out", () => {
    const draft = { ...newDraft("new-id", "a"), sounds: ["a", "loop", "gone", "c"] };
    assert.deepEqual(savedTracks(draft, sounds), ["a", "c"]);
    assert.equal(savedName(draft), "New playlist");
    assert.deepEqual(changedFields(draft, sounds), { name: "New playlist", sounds: ["a", "c"], shuffle: false, repeat: "all", fade: 5 });
    assert.equal(draftDirty(newDraft("n"), sounds), false, "an untouched new playlist has nothing to lose");
    assert.equal(draftDirty(newDraft("n", "a"), sounds), true, "one started from a track has");
  });

  test("the status line: deleted elsewhere first, then another DM's change of tracks, then the playing note", () => {
    const draft = { ...draftOf(saved), sounds: ["b"] };
    assert.equal(makerStatus({ draft, stored: undefined, sounds, playingIt: false }), words.DELETED_ELSEWHERE);
    assert.equal(makerStatus({ draft, stored: { ...saved, rev: 5, sounds: ["a", "b", "c"] }, sounds, playingIt: true }), words.TRACKS_CHANGED);
    assert.equal(makerStatus({ draft: draftOf(saved), stored: { ...saved, rev: 5, sounds: ["a", "b", "c"] }, sounds, playingIt: true }), "Changes apply the next time it starts.", "a draft that kept the tracks takes no warning");
    assert.equal(makerStatus({ draft, stored: { ...saved, rev: 5, name: "Renamed" }, sounds, playingIt: false }), null, "another field's change is no conflict");
  });

  test("a rename while another DM deletes a track the draft holds and adds one: Save sends the name alone, the draft is clean, and no warning shows", () => {
    const draft = { ...draftOf(saved), name: "Tavern late" };
    // Another DM deleted b, which left every playlist, and added c.
    const { b: _gone, ...left } = sounds;
    const stored: Playlist = { ...saved, rev: 6, sounds: ["a", "c"] };
    assert.deepEqual(changedFields(draft, left), { name: "Tavern late" }, "so c stays");
    assert.equal(draftDirty(draftOf(saved), left), false, "an untouched draft has nothing to throw away");
    assert.equal(makerStatus({ draft, stored, sounds: left, playingIt: false }), null);
    const moved = { ...draft, sounds: ["a"] };
    assert.deepEqual(changedFields(moved, left), { name: "Tavern late" }, "a list that only lost b is the same list");
    assert.equal(makerStatus({ draft: moved, stored, sounds: left, playingIt: false }), null, "so it warns of nothing");
    const edited = { ...draft, sounds: ["c", "a"] };
    assert.deepEqual(changedFields(edited, left), { name: "Tavern late", sounds: ["c", "a"] }, "a real change of tracks still sends them");
    assert.equal(makerStatus({ draft: edited, stored, sounds: left, playingIt: false }), words.TRACKS_CHANGED, "and warns that it keeps this list");
  });

  test("Play starts the playlist as the store holds it once the save is answered: another DM's tracks, Repeat, Crossfade and Shuffle, with nothing laid over it", () => {
    const draft = draftOf(saved);
    // Another DM added c and set Repeat off, Crossfade 10 s and Shuffle after the draft began.
    const stored: Playlist = { ...saved, rev: 7, sounds: ["a", "b", "c"], repeat: "off", fade: 10, shuffle: true };
    assert.deepEqual(savedPlaylist(draft, "pl", stored, sounds), stored, "an unchanged draft plays what is stored");
    assert.deepEqual(savedPlaylist({ ...draft, name: "Tavern late" }, "pl", { ...stored, name: "Tavern late" }, sounds), { ...stored, name: "Tavern late" }, "a rename saved, then the rest as stored");
    // A save of [b, a] and another DM's append of c committed in one batch: the server holds [b, a, c], and the draft's [b, a] would be refused by Play's order check.
    assert.deepEqual(savedPlaylist({ ...draft, sounds: ["b", "a"] }, "pl", { ...stored, sounds: ["b", "a", "c"] }, sounds).sounds, ["b", "a", "c"]);
    const created = savedPlaylist({ ...draft, name: "Again" }, "fresh", stored, sounds);
    assert.deepEqual(created, { id: "fresh", rev: 0, name: "Again", sounds: ["a", "b"], repeat: "all", fade: 5 }, "nothing stored under the saved id: the draft's own, not the stored playlist under the old id");
    assert.deepEqual(draftOf(savedPlaylist(draft, "pl", stored, sounds)), draftOf(stored), "and the draft's new base is the stored playlist, so it is clean");
  });

  test("Play reads the room store as the save's answer comes, before React renders its batch: a save of [b, a] and another DM's append of c in one answer batch plays [b, a, c] (MB-ASTRA-02)", () => {
    const sent: { op: Record<string, unknown>; onAnswer?: (answer: "taken") => void }[] = [];
    let ids = 0;
    // The store before the batch, as the last render saw it, then after.
    let room: { playlists: Record<string, Playlist>; sounds: typeof sounds } = { playlists: { pl: saved }, sounds };
    const drafts: MakerDraft[] = [];
    const input = {
      draft: { ...draftOf(saved), sounds: ["b", "a"] },
      stored: saved,
      sounds,
      playingIt: false,
      actions: { dispatch: (op: unknown, opts?: { onAnswer?: (answer: "taken") => void }) => void sent.push({ op: op as Record<string, unknown>, onAnswer: opts?.onAnswer }), newId: () => `id${++ids}` },
      room: () => room,
      setDraft: (d: MakerDraft) => void drafts.push(d),
      onSaved() {},
    };
    const control = drawn((p: typeof input) => useMakerControl(p as never) as never, input) as unknown as { play(): void };
    control.play();
    assert.deepEqual(sent.map((s) => s.op), [{ t: "playlist.update", id: "pl", sounds: ["b", "a"] }], "Play saves first");
    room = { playlists: { pl: { ...saved, rev: 6, sounds: ["b", "a", "c"] } }, sounds };
    sent[0]!.onAnswer!("taken");
    const played = sent.slice(1).map((s) => s.op);
    assert.equal(played.length, 1);
    assert.equal(played[0]!.t, "music.play");
    assert.deepEqual(played[0]!.order, ["b", "a", "c"], "the order the server holds, so its playlist-order check takes it");
    assert.deepEqual(drafts.map((d) => [d.sounds, d.base?.rev]), [[["b", "a", "c"], 6]], "and the draft's new base is what the store holds");
  });
});

describe("a seek in hand", () => {
  test("holds while the run and the playing track stay, and drops on a change of either", () => {
    const ids = ["a", "b"];
    const lengths = Object.fromEntries(ids.map((id) => [id, { ms: 60_000, use: "music" as const }]));
    const run: MusicRun = { run: "r", order: ids, index: 0, repeat: "all", fade: 0, now: { soundId: "a", at: T } };
    const lists = queueLists(run, lengths, T + 1_000)!;
    assert.equal(seekHolds({ run: "r", soundId: "a", ms: 30_000 }, lists), true);
    assert.equal(seekHolds({ run: "r", soundId: "a", ms: 30_000 }, queueLists(run, lengths, T + 61_000)), false, "the next track plays now");
    assert.equal(seekHolds({ run: "r", soundId: "a", ms: 30_000 }, queueLists({ ...run, run: "r2" }, lengths, T + 1_000)), false, "another DM played or jumped");
    assert.equal(seekHolds({ run: "r", soundId: "a", ms: 30_000 }, null), false);
  });
});

describe("when the seek slider sends", () => {
  /** A gesture on the window's timers, mocked, and the times its commits came at. */
  function gesture() {
    mock.timers.enable({ apis: ["setTimeout"] });
    let now = 0;
    const sent: number[] = [];
    const g = seekGesture(() => sent.push(now));
    const wait = (ms: number) => {
      now += ms;
      mock.timers.tick(ms);
    };
    return { g, sent, wait };
  }
  afterEach(() => mock.timers.reset());

  // The run and track a value is given on: A, then B once another DM starts it.
  const A = "r1\na";
  const B = "r2\nb";

  test("a key's value sends 400 ms after the last, so a held arrow sends once", () => {
    const { g, sent, wait } = gesture();
    for (let i = 0; i < 5; i++) {
      assert.equal(g.input(A), true);
      wait(100);
    }
    assert.deepEqual(sent, []);
    wait(300);
    assert.deepEqual(sent, [800]);
  });

  test("a drag sends once, as it ends, and nothing while the pointer is down", () => {
    const { g, sent, wait } = gesture();
    g.start(A);
    for (let i = 0; i < 10; i++) {
      assert.equal(g.input(A), true);
      wait(200);
    }
    wait(500);
    assert.deepEqual(sent, [], "held still past 400 ms");
    g.end();
    g.end();
    assert.deepEqual(sent, [2_500], "a second release, or a lost capture after it, sends no more");
    wait(1_000);
    assert.deepEqual(sent, [2_500]);
  });

  test("a drag begun within 400 ms of a key: the key's timer never fires while the pointer is down (MB-ASTRA-05)", () => {
    const { g, sent, wait } = gesture();
    g.input(A);
    wait(100);
    g.start(A);
    wait(1_000);
    assert.deepEqual(sent, [], "held past the key's 400 ms");
    g.input(A);
    g.end();
    assert.deepEqual(sent, [1_100]);
  });

  test("a drag on track A as another DM starts B: the seek in hand drops, the values after are refused, the release sends nothing, and the next press seeks again (MB-SOL-01)", () => {
    const { g, sent, wait } = gesture();
    g.start(A);
    assert.equal(g.input(A), true);
    wait(200);
    // B plays: the window's effect drops A's seek, then the pointer goes on moving over B.
    g.drop();
    assert.equal(g.input(B), false, "no seek in hand made on B");
    wait(1_000);
    assert.equal(g.input(B), false, "for the rest of the press");
    g.end();
    wait(1_000);
    assert.deepEqual(sent, [], "the release sends nothing, and no timer was armed");
    g.start(B);
    assert.equal(g.input(B), true);
    g.end();
    assert.deepEqual(sent, [2_200], "a new press on B seeks");
  });

  test("a value given on B before the window drops A's seek cancels the press too, as does a change with no value given yet", () => {
    const { g, sent, wait } = gesture();
    g.start(A);
    g.input(A);
    assert.equal(g.input(B), false, "B's first value, before the effect runs");
    assert.equal(g.input(A), false, "and the press stays cancelled");
    g.end();
    assert.deepEqual(sent, []);
    g.start(A);
    wait(500);
    assert.equal(g.input(B), false, "pressed on A, B playing before any value");
    g.end();
    assert.deepEqual(sent, []);
    g.start(A);
    g.input(A);
    g.drop();
    g.end();
    assert.deepEqual(sent, [], "a drop with no value after it: the release sends nothing either");
  });

  test("a key's seek dropped before its timer sends nothing", () => {
    const { g, sent, wait } = gesture();
    g.input(A);
    wait(100);
    g.drop();
    wait(1_000);
    assert.deepEqual(sent, []);
  });
});
