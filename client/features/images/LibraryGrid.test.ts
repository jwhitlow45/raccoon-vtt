import "../../components/testing/register.ts";
import assert from "node:assert/strict";
import { describe, test } from "node:test";

/*
 * A Library tile opens what it shows in the handout viewer
 * (docs/design/design-v1-layout-hierarchy.md 5.3, docs/design/design-v1-pdf-handouts.md
 * 8.4): the largest copy the row lists, under the title of a handout
 * showing it, or else what the image is.
 */

const { docDetails, docTile, focusAfterDelete, imageDetails, imageTile, stillOfVideo, videoView, viewTitle, viewVariant } = await import("./LibraryGrid.tsx");

const row = (kind: "map" | "token" | "handout", variants: ("full" | "mobile" | "thumb")[] = ["full", "thumb"]) => ({ id: "a", kind, width: 100, height: 100, variants });

describe("viewing a library image", () => {
  test("loads the full copy when the row lists it, else the largest one listed", () => {
    assert.equal(viewVariant(row("map", ["full", "mobile", "thumb"])), "full");
    assert.equal(viewVariant(row("map", ["thumb", "mobile"])), "mobile");
    assert.equal(viewVariant(row("token", ["thumb"])), "thumb");
    assert.equal(viewVariant(undefined), "full");
  });

  test("is titled by a handout showing the image, the one shown last, else by its kind", () => {
    const handouts = [
      { assetId: "a", title: "The letter", shownAt: "2026-10-15T20:00:00.000Z" },
      { assetId: "a", title: "The letter, again", shownAt: "2026-10-15T21:00:00.000Z" },
      { assetId: "b", title: "Another", shownAt: "2026-10-15T22:00:00.000Z" },
    ];
    assert.equal(viewTitle("a", row("handout"), handouts), "The letter, again");
    assert.equal(viewTitle("c", row("handout"), handouts), "Handout");
    assert.equal(viewTitle("c", row("map"), handouts), "Map");
    assert.equal(viewTitle("c", row("token"), []), "Token image");
    assert.equal(viewTitle("c", undefined, []), "Token image");
  });

  test("a handout of pages names the page the image fills, and one image keeps the handout's title alone (docs/design/design-v1-pdf-handouts.md 8.1)", () => {
    const page = (assetId: string) => ({ assetId, width: 1584, height: 2048 });
    const letter = { assetId: "p1", pages: ["p1", "blank", "p3", "blank"].map(page), title: "Strange letter", shownAt: "2026-10-16T20:00:00.000Z" };
    assert.equal(viewTitle("p3", row("handout"), [letter]), "Strange letter, page 3");
    assert.equal(viewTitle("p1", row("handout"), [letter]), "Strange letter, page 1");
    // A page that repeats is named by its first place.
    assert.equal(viewTitle("blank", row("handout"), [letter]), "Strange letter, page 2");
    // The newest showing wins, pages or not.
    const map = { assetId: "p3", title: "The map", shownAt: "2026-10-16T21:00:00.000Z" };
    assert.equal(viewTitle("p3", row("handout"), [letter, map]), "The map");
    assert.equal(viewTitle("p1", row("handout"), [letter, map]), "Strange letter, page 1");
    // A one-page document shown is one page, so its title alone.
    assert.equal(viewTitle("solo", row("handout"), [{ assetId: "solo", pages: [page("solo")], title: "Solo", shownAt: "2026-10-16T20:00:00.000Z" }]), "Solo");
  });
});

describe("a library tile's name and status (docs/design/design-v1-pdf-handouts.md 8.4)", () => {
  test("an image's name says not in use or uploading, and only the DM's tile shows a status", () => {
    const handout = { ...row("handout"), inUse: false };
    assert.deepEqual(imageTile(handout, { dm: true }), { label: "Handout, not in use", status: "Not in use" });
    assert.deepEqual(imageTile({ ...row("map"), inUse: true }, { dm: true }), { label: "Map", status: "In use" });
    // A running upload's page on this device takes the status's place, in use or not.
    assert.deepEqual(imageTile(handout, { dm: true, uploading: true }), { label: "Handout, uploading", status: "Uploading" });
    assert.deepEqual(imageTile({ ...row("handout"), inUse: true }, { dm: true, uploading: true }), { label: "Handout, uploading", status: "Uploading" });
    // The list does not say yet, or the image is only seen on a token.
    assert.deepEqual(imageTile(row("token"), { dm: true }), { label: "Token image", status: null });
    assert.deepEqual(imageTile(undefined, { dm: true }), { label: "Token image", status: null });
    // A player's tiles have no status. The server never sends them inUse, and none is shown even if it did.
    assert.deepEqual(imageTile(row("token"), { dm: false }), { label: "Token image", status: null });
    assert.deepEqual(imageTile({ ...row("token"), inUse: true }, { dm: false }), { label: "Token image", status: null });
  });

  test("a document's name gives its page count, and showing now while it shows", () => {
    const pages = Array.from({ length: 12 }, (_, i) => ({ assetId: `p${i}`, width: 1584, height: 2048 }));
    assert.deepEqual(docTile({ title: "Strange letter", pages }, false), { label: "Strange letter, handout, 12 pages", tag: "12 pages", status: null });
    assert.deepEqual(docTile({ title: "Strange letter", pages }, true), { label: "Strange letter, handout, 12 pages, showing now", tag: "12 pages", status: "Showing now" });
    assert.deepEqual(docTile({ title: "Scrap", pages: pages.slice(0, 1) }, false), { label: "Scrap, handout, 1 page", tag: "1 page", status: null });
  });

  test("a video's header line names its length between its size and its bytes, and its kind is Animated map", () => {
    const facts = { widthPx: 1920, heightPx: 1080, container: "mp4" as const, video: "avc1.640028", fps: 30, durationMs: 125_000, kbps: 4000 };
    assert.equal(imageDetails({ width: 1920, height: 1080, bytes: 2_000_000, video: facts }, "Not in use"), "1920 × 1080 px, 2:05, 2 MB. Not in use.");
    assert.deepEqual(imageTile({ id: "v", kind: "video", width: 1920, height: 1080, variants: ["full"], inUse: true }, { dm: true }), { label: "Animated map", status: "In use" });
  });

  test("a turned or stretched video's line and viewer page read the size it shows at, not its coded size (docs/design/design-v1-video-turns.md 7)", () => {
    const facts = { widthPx: 1920, heightPx: 1080, container: "mp4" as const, video: "avc1.640028", fps: 30, durationMs: 42_000, kbps: 4000 };
    // The row keeps the coded size.
    assert.equal(imageDetails({ width: 1920, height: 1080, bytes: 2_000_000, video: { ...facts, turn: 90 } }, null), "1080 × 1920 px, 0:42, 2 MB.");
    assert.equal(imageDetails({ width: 1920, height: 1080, video: { ...facts, turn: 180, mirror: true } }, null), "1920 × 1080 px, 0:42.");
    assert.equal(imageDetails({ width: 1440, height: 1080, video: { ...facts, widthPx: 1440, displayWidthPx: 1920 } }, null), "1920 × 1080 px, 0:42.");
    assert.equal(imageDetails({ width: 1440, height: 1080, video: { ...facts, widthPx: 1440, displayWidthPx: 1920, turn: 270 } }, null), "1080 × 1920 px, 0:42.");
    const assets = { url: (id: string, variant: string) => `/a/${id}/${variant}` };
    const page = videoView({ assetId: "v", ...facts, turn: 90 }, "s", assets).pages[0]!;
    assert.deepEqual([page.width, page.height], [1080, 1920], "the page stands upright");
    assert.deepEqual(page.video?.video.turn, 90, "and the element turns into it");
    const plain = videoView({ assetId: "v", ...facts }, null, assets).pages[0]!;
    assert.deepEqual([plain.width, plain.height], [1920, 1080]);
  });

  test("a video's still in the viewer is the still of the first scene or phase that names it", () => {
    const base = { rev: 1, name: "s", bounds: { w: 1, h: 1 }, grid: { show: true, color: "#fff", opacity: 1, lineWidth: 1 }, background: "#000", fogEnabled: false, wallsVersion: 0 };
    const facts = { widthPx: 100, heightPx: 100, container: "webm" as const, video: "vp8", fps: 30, durationMs: 2000, kbps: 100 };
    const map = (assetId: string, video?: string) => ({ assetId, widthPx: 100, heightPx: 100, cellPx: 10, originPx: { x: 0, y: 0 }, ...(video ? { video: { assetId: video, ...facts } } : null) });
    const scenes = {
      b: { ...base, id: "b", order: 2, map: map("still-b", "loop") },
      a: { ...base, id: "a", order: 1, map: map("day"), phases: [{ id: "p1", name: "Day", assetId: "day", widthPx: 100, heightPx: 100 }, { id: "p2", name: "Night", assetId: "night-still", widthPx: 100, heightPx: 100, video: { assetId: "loop", ...facts } }] },
    };
    assert.equal(stillOfVideo(scenes as never, "loop"), "night-still");
    assert.equal(stillOfVideo(scenes as never, "other"), null);
    assert.equal(stillOfVideo(undefined, "loop"), null);
  });

  test("the viewer's header line: the size once listed, then the DM's status", () => {
    assert.equal(imageDetails({ width: 280, height: 280, bytes: 20_000 }, "Not in use"), "280 × 280 px, 20 KB. Not in use.");
    assert.equal(imageDetails({ width: 280, height: 280 }, null), "280 × 280 px.");
    assert.equal(imageDetails(undefined, null), null);
    assert.equal(imageDetails(undefined, "In use"), "In use.");
    assert.equal(docDetails(12, 4_100_000, false), "12 pages, 4 MB.");
    assert.equal(docDetails(12, null, false), "12 pages.");
    assert.equal(docDetails(12, 4_100_000, true), "12 pages, 4 MB. Showing now. Close it in the DM panel to delete it.");
  });
});

describe("focus after the open tile is deleted (docs/design/design-v1-pdf-handouts.md 8.4)", () => {
  const handouts = (keys: string[]) => ({ id: "handouts", heading: true, keys });
  const maps = (keys: string[]) => ({ id: "map", heading: true, keys });

  test("goes to the next tile in that section, else the one before", () => {
    const before = [handouts(["doc:a", "image:b", "image:c"]), maps(["image:m"])];
    assert.deepEqual(focusAfterDelete(before, "image:b", [handouts(["doc:a", "image:c"]), maps(["image:m"])]), { t: "tile", key: "image:c" });
    assert.deepEqual(focusAfterDelete(before, "image:c", [handouts(["doc:a", "image:b"]), maps(["image:m"])]), { t: "tile", key: "image:b" });
    // A neighbour that went too is passed over.
    assert.deepEqual(focusAfterDelete(before, "doc:a", [handouts(["image:c"]), maps(["image:m"])]), { t: "tile", key: "image:c" });
    // Never a tile of another section.
    assert.deepEqual(focusAfterDelete([maps(["image:m"]), handouts(["doc:a"])], "image:m", [maps([]), handouts(["doc:a"])]), { t: "heading", section: "map" });
  });

  test("goes to the section's heading while the section stays, else the panel's first control", () => {
    const before = [handouts(["doc:a"]), maps(["image:m"])];
    // The Handouts section stays while a note says what the delete came to.
    assert.deepEqual(focusAfterDelete(before, "doc:a", [handouts([]), maps(["image:m"])]), { t: "heading", section: "handouts" });
    assert.deepEqual(focusAfterDelete(before, "doc:a", [maps(["image:m"])]), { t: "panel" });
    // A player's one section has no heading.
    assert.deepEqual(focusAfterDelete([{ id: "tokens", heading: false, keys: ["image:t"] }], "image:t", [{ id: "tokens", heading: false, keys: [] }]), { t: "panel" });
    assert.deepEqual(focusAfterDelete([], "image:x", []), { t: "panel" });
  });
});

describe("the Library panel's tiles, rendered", async () => {
  const { createElement } = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createStore } = await import("zustand/vanilla");
  const { room } = await import("#shared/testutil.ts");
  const { LibraryGrid } = await import("./LibraryGrid.tsx");
  const { rememberAsset, resetLibraryForTest, uploadingSlot } = await import("./library.ts");
  const { RoomProvider } = await import("../../state/view.ts");
  const { RoomScope, RoomScopeProvider } = await import("../../state/scope.ts");

  const page = (assetId: string) => ({ assetId, width: 1584, height: 2048 });
  const asset = (id: string, kind: "handout" | "map" | "token", inUse: boolean) => ({ id, kind, width: 1584, height: 2048, variants: ["full" as const, "thumb" as const], inUse, bytes: 100_000 });

  function render(role: "dm" | "player", scope = new RoomScope()) {
    const state = room({
      handoutDocs: { letter: { id: "letter", rev: 1, title: "Strange letter", pages: [page("p1"), page("p2")], createdAt: "2026-10-16T10:00:00.000Z" } },
      handouts: { h1: { id: "h1", rev: 1, assetId: "p1", pages: [page("p1"), page("p2")], title: "Strange letter", to: "all", shownAt: "2026-10-16T11:00:00.000Z" } },
    });
    const store = createStore(() => ({ roomId: "lib-room", view: state, you: { memberId: role === "dm" ? "dm1" : "p1", role }, connection: "open", accessVersion: 1 }));
    const assets = { url: (id: string, variant: string) => `/a/${id}/${variant}` };
    const grid = createElement(LibraryGrid, { roomId: "lib-room" });
    return renderToStaticMarkup(
      createElement(RoomProvider, { store: store as never, actions: { dispatch: () => null } as never, ui: {} as never, assets, children: createElement(RoomScopeProvider, { scope, children: grid }) }),
    );
  }

  test("the DM's Handouts list the document first as one tile, its pages not loose, every tile a button with its status and no card", () => {
    resetLibraryForTest();
    for (const a of [asset("p1", "handout", true), asset("p2", "handout", true), asset("loose", "handout", false), asset("job", "handout", false), asset("m1", "map", true)]) rememberAsset("lib-room", a);
    const scope = new RoomScope();
    const uploading = scope.get(uploadingSlot);
    uploading.setState({ ids: new Set(["job"]) });
    // A server render reads a zustand store's initial state, which a page in a browser never does.
    uploading.getInitialState = uploading.getState;
    const markup = render("dm", scope);
    const handouts = markup.slice(markup.indexOf("Handouts in this room"), markup.indexOf("Maps in this room"));
    const labels = [...handouts.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(labels, ["Strange letter, handout, 2 pages, showing now", "Handout, not in use", "Handout, uploading"]);
    assert.match(handouts, />2 pages</);
    assert.match(handouts, />Showing now</);
    assert.match(handouts, />Not in use</);
    assert.match(handouts, />Uploading</);
    assert.doesNotMatch(markup, /aria-pressed/, "a tile opens the viewer, it is not selected");
    assert.match(markup, />In use</, "the map's status");
    // Cleanup offers only the loose image: not the upload's page, nor a document's.
    assert.match(markup, />Delete 1 not in use \(100 KB\)</);
  });

  test("the DM's Maps list a video as a film strip with its length and its status, and Cleanup counts it (docs/design/design-v1-animated-maps.md 4.6)", () => {
    resetLibraryForTest();
    const facts = { widthPx: 1920, heightPx: 1080, container: "webm" as const, video: "vp09.00.40.08", fps: 30, durationMs: 42_000, kbps: 4000 };
    rememberAsset("lib-room", { id: "v1", kind: "video", width: 1920, height: 1080, variants: ["full"], inUse: false, bytes: 2_000_000, video: facts });
    rememberAsset("lib-room", asset("m1", "map", true));
    const markup = render("dm");
    const maps = markup.slice(markup.indexOf("Maps in this room"));
    const labels = [...maps.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(labels.includes("Animated map, not in use"), labels.join(" | "));
    assert.match(maps, />0:42</, "its length in the corner");
    assert.match(maps, />Not in use</);
    // No thumbnail is asked for: a video has none.
    assert.doesNotMatch(markup, /\/a\/v1\/thumb/);
    assert.match(markup, />Delete 1 not in use \(2 MB\)</);
    resetLibraryForTest();
  });

  test("a player's tiles have no status", () => {
    resetLibraryForTest();
    rememberAsset("lib-room", { ...asset("t1", "token", true), inUse: undefined } as never);
    const markup = render("player");
    assert.match(markup, /aria-label="Token image"/);
    assert.doesNotMatch(markup, /In use|Not in use|Showing now/);
    resetLibraryForTest();
  });
});
