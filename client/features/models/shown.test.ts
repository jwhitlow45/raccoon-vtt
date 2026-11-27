import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import type { HpVisibility, ImageRef, LifeState, ModelRef, Token } from "#shared/model.ts";
import { projectState } from "#shared/project.ts";
import { actor, character, DM, P1, room, token } from "#shared/testutil.ts";
import type { SheetImage, Sheets } from "./sheets.ts";
import { characterModelsKey, modelDragsKey, modelDragsOf, modelShown, modelWanted, tokenActor } from "./shown.ts";

/**
 * Whether a creature stands as its model (docs/design/design-v1-token-models.md
 * 6, D-261127-177, 376, 380): its image carries one, its sheet is decoded,
 * and its life as the viewer's copy shows it is not dead, dying or stable.
 */

const MODEL: ModelRef = { assetId: "0198a1b2-0000-7000-8000-00000000c0de", side: 1.4, anchorY: 0.72, boxes: Array.from({ length: 8 }, () => [30, 10, 70, 80] as [number, number, number, number]) };
const SHEET = { width: 2048, height: 1024 } as unknown as SheetImage;
const decoded: Sheets = { version: 1, image: (id) => (id === MODEL.assetId ? SHEET : null) };
const loading: Sheets = { version: 0, image: () => null };

const wearing = (image: ImageRef): Partial<Token> => ({ image });
const ICON_WITH_MODEL: ImageRef = { icon: "lorc/wolf-head", color: "#556b2f", model: MODEL };
const UPLOAD_WITH_MODEL: ImageRef = { assetId: "0198a1b2-0000-7000-8000-00000000babe", crop: { cx: 0.5, cy: 0.5, zoom: 1 }, model: MODEL };

describe("modelShown", () => {
  test("a creature stands as its model once its sheet is decoded, an upload's or an icon's alike, and as its picture until then", () => {
    for (const image of [ICON_WITH_MODEL, UPLOAD_WITH_MODEL]) {
      const t = token("w", wearing(image));
      assert.deepEqual(modelShown(t, actor(), decoded), { ref: MODEL, image: SHEET });
      assert.equal(modelShown(t, actor(), loading), null, "loading");
    }
    // A picture alone, an icon alone, or no image at all.
    for (const image of [{ icon: "lorc/wolf-head", color: "#556b2f" }, { assetId: MODEL.assetId, crop: { cx: 0.5, cy: 0.5, zoom: 1 } }] as ImageRef[]) {
      assert.equal(modelShown(token("p", wearing(image)), actor(), decoded), null);
    }
    assert.equal(modelShown(token("n"), actor(), decoded), null);
  });

  test("a dead, dying or stable creature stands as its picture, and an alive one as its model", () => {
    const states: [LifeState, boolean][] = [["alive", true], ["dying", false], ["stable", false], ["dead", false]];
    for (const [life, model] of states) {
      const t = token("w", wearing(ICON_WITH_MODEL));
      assert.equal(modelShown(t, actor({ life, hp: { cur: life === "alive" ? 5 : 0, max: 20, temp: 0 } }), decoded) !== null, model, life);
      assert.equal(modelWanted(t, actor({ life })) !== null, model, `${life}, wanted`);
    }
  });

  test("an HP-less creature and an object keep their model whatever life they store, as their bodies draw no life mark", () => {
    // A creature whose maximum is 0, and a companion that is an effect (docs/design/design-v1-combat-flow.md 3.6.6).
    assert.ok(modelShown(token("z", wearing(ICON_WITH_MODEL)), actor({ life: "dead", hp: { cur: 0, max: 0, temp: 0 } }), decoded));
    assert.ok(modelShown(token("e", { ...wearing(ICON_WITH_MODEL), kind: "object", companion: { of: "c1" } as unknown as Token["companion"] }), actor({ life: "dying" }), decoded));
    assert.ok(modelShown(token("o", { ...wearing(ICON_WITH_MODEL), kind: "object" }), actor({ life: "dead" }), decoded));
    // No creature at all: a token whose character is not in the copy.
    assert.ok(modelShown(token("c", wearing(ICON_WITH_MODEL)), undefined, decoded));
  });

  test("at every HP visibility a player's copy stands the creature as the DM's does: by its life, which every copy carries", () => {
    const visibilities: HpVisibility[] = ["hidden", "label", "bar", "exact"];
    for (const hpVisibility of visibilities) {
      for (const life of ["alive", "dying", "stable", "dead"] as LifeState[]) {
        const state = room({ tokens: { w: token("w", { ...wearing(ICON_WITH_MODEL), hpVisibility, actor: { inline: actor({ life, hp: { cur: life === "alive" ? 9 : 0, max: 20, temp: 0 } }) } }) } });
        const answers = [DM, P1].map((viewer) => {
          const t = projectState(state, viewer, { sceneId: "s1" }).tokens["w"]!;
          return modelShown(t, tokenActor(t, undefined), decoded) !== null;
        });
        assert.deepEqual(answers, [life === "alive", life === "alive"], `${hpVisibility}, ${life}`);
      }
    }
  });

  test("a token that names a character reads the character's life, and the board's key changes only with whether it may stand as its model", () => {
    const pc = token("pc", { ...wearing(ICON_WITH_MODEL), kind: "pc", actor: { ref: "c1" } });
    const plain = token("pl", { kind: "pc", actor: { ref: "c2" } });
    const alive = { c1: character("c1", { actor: actor() }), c2: character("c2") };
    const down = { c1: character("c1", { actor: actor({ life: "dying", hp: { cur: 0, max: 20, temp: 0 } }) }), c2: character("c2") };
    assert.ok(modelShown(pc, tokenActor(pc, alive), decoded));
    assert.equal(modelShown(pc, tokenActor(pc, down), decoded), null);
    const key = (characters: typeof alive) => characterModelsKey([pc, plain, token("inline", wearing(ICON_WITH_MODEL))], characters);
    assert.notEqual(key(alive), key(down));
    // Another edit to the character, or any edit to one whose token wears no model, keeps the key.
    assert.equal(key({ ...alive, c1: character("c1", { name: "Renamed", actor: actor({ hp: { cur: 3, max: 20, temp: 0 } }) }) }), key(alive));
    assert.equal(key({ ...alive, c2: character("c2", { actor: actor({ life: "dead" }) }) }), key(alive));
  });
});

describe("modelDragsKey", () => {
  test("another member's drags of tokens that may stand as their models, each at its spot to half a cell, and none of the token this device drags", () => {
    const wolf = token("wolf", wearing(ICON_WITH_MODEL));
    const fallen = token("fallen", { ...wearing(ICON_WITH_MODEL), actor: { inline: actor({ life: "dead", hp: { cur: 0, max: 20, temp: 0 } }) } });
    const plain = token("plain");
    const mine = token("mine", wearing(UPLOAD_WITH_MODEL));
    const tokens = new Map([wolf, fallen, plain, mine].map((t) => [t.id, t]));
    const drags = { a: { tokenId: "wolf", x: 3.2, y: 7.8 }, b: { tokenId: "fallen", x: 1, y: 1 }, c: { tokenId: "plain", x: 2, y: 2 }, d: { tokenId: "mine", x: 4, y: 4 }, e: { tokenId: "gone", x: 5, y: 5 } };
    const key = modelDragsKey(drags, tokens, undefined, "mine");
    assert.deepEqual(modelDragsOf(key), [{ tokenId: "wolf", x: 3, y: 8 }]);
    // A step inside the same half cell keeps the key, and one past it changes it.
    assert.equal(modelDragsKey({ ...drags, a: { tokenId: "wolf", x: 3.24, y: 7.76 } }, tokens, undefined, "mine"), key);
    assert.deepEqual(modelDragsOf(modelDragsKey({ ...drags, a: { tokenId: "wolf", x: 3.3, y: 7.8 } }, tokens, undefined, "mine")), [{ tokenId: "wolf", x: 3.5, y: 8 }]);
    assert.equal(modelDragsKey({}, tokens, undefined, null), "");
    assert.deepEqual(modelDragsOf(""), []);
  });
});

describe("only the isometric board stands a model", () => {
  test("Top-down, the tracker, the party bar and every panel keep the picture: no part of the client but the board reads modelShown or draws a sheet", () => {
    const root = new URL("../../", import.meta.url).pathname;
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.tsx?$/.test(name) && !/\.test\.ts$/.test(name) && /\bmodelShown\(|<ModelArt\b|\buseSheets\(/.test(readFileSync(p, "utf8"))) readers.push(path.relative(root, p));
      }
    };
    walk(root);
    assert.deepEqual(readers.sort(), ["canvas/TokenNode.tsx", "canvas/relief/IsoBoard.tsx", "canvas/relief/keptTesting.ts", "features/models/sheets.ts", "features/models/shown.ts"]);
    // In TokenNode, only the standee draws one, and only from the model its layout passed.
    const node = readFileSync(new URL("../../canvas/TokenNode.tsx", import.meta.url), "utf8");
    assert.equal(node.match(/<ModelArt\b/g)?.length, 1);
    const standee = node.slice(node.indexOf("function Standee("), node.indexOf("\n}\n", node.indexOf("function Standee(")));
    assert.match(standee, /<ModelArt model=\{model\}/);
    assert.match(standee, /const model = iso\.model \?\? null;/);
  });
});
