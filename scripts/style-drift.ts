import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { theme } from "../client/lib/theme.ts";

/**
 * How far the client's styles drift from the tokens in client/lib/theme.ts
 * (docs/design-v1-visual.md, "Drift in numbers" and section 5.5).
 *
 * `node scripts/style-drift.ts` prints the measures the design's audit
 * quotes: font sizes, radii and spacing from tokens against raw numbers,
 * shadows, z-index values, raw buttons, color literals, disabled opacities
 * and the local copies of shared patterns. Run on the tree the audit read,
 * it gives the audit's numbers, so later runs show what the pass changed.
 *
 * It also lists what section 5.5's drift test fails on, with that
 * section's allowlist, so the test (client/lib/styleDrift.test.ts) and
 * this report agree on one reading of the source. `--findings` prints only
 * those, one per line.
 *
 * The scan reads source text, not an AST: TypeScript 7 ships no JavaScript
 * compiler API, and a regular reading of inline style objects is enough
 * for counts. Comments are stripped first, so a value quoted in a comment
 * is never counted.
 */

export const ROOT = fileURLToPath(new URL("..", import.meta.url));

export type SourceFile = { path: string; text: string };

/** Every client source file the audit counts: `client/**\/*.ts(x)` without tests, `client/dev` and the tokens themselves. */
export function clientFiles(root: string = ROOT): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (rel === "client/dev") continue;
        walk(full);
      } else if (/\.tsx?$/.test(entry.name) && !/\.(test|itest|e2e)\.tsx?$/.test(entry.name) && rel !== "client/lib/theme.ts") {
        out.push({ path: rel, text: stripComments(readFileSync(full, "utf8")) });
      }
    }
  };
  walk(path.join(root, "client"));
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

const REGEX_AFTER = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_AFTER_WORD = /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|new|delete|void|throw|yield|await)$/;

/**
 * The source with its comments blanked. Strings, template literals and
 * regular expression literals are copied as they are, so a `//` inside a
 * URL or a pattern survives. A slash starts a regular expression where
 * an operand is expected, judged by the character before it, which is
 * right for this codebase's style. Newlines are kept, so line numbers in
 * findings still match the file.
 */
export function stripComments(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;

  const lastSignificant = (): string => {
    for (let k = out.length - 1; k >= 0; k--) {
      const ch = out[k]!;
      if (!/\s/.test(ch)) return ch;
    }
    return "";
  };
  const regexAllowed = (): boolean => {
    const last = lastSignificant();
    if (REGEX_AFTER.has(last)) return true;
    return /[\w$]/.test(last) && REGEX_AFTER_WORD.test(out.trimEnd());
  };

  const copyString = (quote: string) => {
    out += src[i++];
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += ch;
      i++;
      if (ch === quote || ch === "\n") return;
    }
  };

  const copyRegex = () => {
    out += src[i++];
    let inClass = false;
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      out += ch;
      i++;
      if (ch === "\n") return;
      if (ch === "[") inClass = true;
      else if (ch === "]") inClass = false;
      else if (ch === "/" && !inClass) break;
    }
    while (i < n && /[a-z]/i.test(src[i]!)) out += src[i++];
  };

  // Code until the `}` that closes a template's `${`, or to the end.
  const copyCode = (inTemplate: boolean) => {
    let depth = 0;
    while (i < n) {
      const ch = src[i]!;
      const next = src[i + 1];
      if (ch === "/" && next === "/") {
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (ch === "/" && next === "*") {
        const end = src.indexOf("*/", i + 2);
        const stop = end === -1 ? n : end + 2;
        out += src.slice(i, stop).replace(/[^\n]/g, " ");
        i = stop;
        continue;
      }
      if (ch === '"' || ch === "'") {
        copyString(ch);
        continue;
      }
      if (ch === "`") {
        copyTemplate();
        continue;
      }
      if (ch === "/" && regexAllowed()) {
        copyRegex();
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") {
        if (inTemplate && depth === 0) {
          out += ch;
          i++;
          return;
        }
        depth--;
      }
      out += ch;
      i++;
    }
  };

  const copyTemplate = () => {
    out += src[i++];
    while (i < n) {
      const ch = src[i]!;
      if (ch === "\\") {
        out += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (ch === "`") {
        out += ch;
        i++;
        return;
      }
      if (ch === "$" && src[i + 1] === "{") {
        out += "${";
        i += 2;
        copyCode(true);
        continue;
      }
      out += ch;
      i++;
    }
  };

  copyCode(false);
  return out;
}

/** The value written after `key:` in an object, up to the next comma, brace or line end at the same nesting. */
function propertyValues(text: string, key: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`(?<![\\w$.-])${key}\\s*:\\s*`, "g");
  for (let m = re.exec(text); m; m = re.exec(text)) {
    let depth = 0;
    let j = re.lastIndex;
    let quote: string | null = null;
    for (; j < text.length; j++) {
      const ch = text[j]!;
      if (quote) {
        if (ch === "\\") j++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      else if (ch === "(" || ch === "[" || ch === "{") depth++;
      else if (ch === ")" || ch === "]" || ch === "}") {
        if (depth === 0) break;
        depth--;
      } else if ((ch === "," || ch === "\n" || ch === ";") && depth === 0) break;
    }
    out.push(text.slice(re.lastIndex, j).trim());
  }
  return out;
}

/** A JSX opening tag from its `<` to its closing `>`, skipping any `>` inside an attribute's braces or quotes, such as an arrow function's. */
function openingTag(text: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let j = start + 1; j < text.length; j++) {
    const ch = text[j]!;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (depth === 0 && (ch === '"' || ch === "'")) quote = ch;
    else if (depth === 0 && ch === ">") return text.slice(start, j + 1);
  }
  return text.slice(start);
}

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (text.charCodeAt(k) === 10) line++;
  return line;
}

const NUMBER = /^-?\d*\.?\d+$/;
const TOKEN_HEX = new Set((Object.values(theme.color) as string[]).filter((v) => v.startsWith("#")).map((v) => v.toLowerCase()));

function tally(values: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return new Map([...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
}

function formatTally(counts: Map<string, number>): string {
  return [...counts].map(([v, c]) => (c > 1 ? `${v} x${c}` : v)).join(", ");
}

/** Whether one padding, margin or gap value is non-zero, and whether it is written with `theme.space`. */
function spacingKind(value: string): "zero" | "token" | "raw" | "other" {
  if (/^0(px)?$|^["'`]0(px)?["'`]$/.test(value)) return "zero";
  if (/theme\.space\(/.test(value)) return /\b[1-9]\d*px\b/.test(value.replace(/\$\{[^}]*\}/g, "")) ? "raw" : "token";
  if (NUMBER.test(value)) return "raw";
  if (/^["'`][^"'`$]*["'`]$/.test(value)) return /\b[1-9]/.test(value) ? "raw" : "zero";
  return "other";
}

export type Measures = {
  files: number;
  fontSize: { total: number; tokens: number; raw: Map<string, number>; rawCount: number };
  fontWeight: Map<string, number>;
  radius: { total: number; tokens: number; raw: Map<string, number> };
  spacing: { tokens: number; raw: number; other: number; gaps: Map<string, number> };
  shadows: { uses: number; distinct: number };
  zIndex: Map<string, number>;
  buttons: { raw: number; rawStyled: number; shared: number };
  /** `untokened` leaves out literals equal to a token's value, which only need the token's name. */
  hex: { uses: number; distinct: number; untokened: number };
  rgb: { uses: number; blackAlphas: number };
  disabledOpacity: { uses: number; values: Map<string, number> };
  copies: Map<string, number>;
};

const COPIES = ["SmallButton", "ToolButton", "Segmented", "Toggle", "IconButton", "Chip", "Pill", "Note", "Help", "Hint", "Muted", "Group", "Section"];
const STATE_WORDS = /\b(disabled|busy|saving|sending)\b/i;

export function measure(files: readonly SourceFile[]): Measures {
  const fontSizes: string[] = [];
  const weights: string[] = [];
  const radii: string[] = [];
  const spacing = { tokens: 0, raw: 0, other: 0 };
  const gaps: string[] = [];
  const shadows: string[] = [];
  const zs: string[] = [];
  const buttons = { raw: 0, rawStyled: 0, shared: 0 };
  const hexes: string[] = [];
  let rgbUses = 0;
  const blackAlphas = new Set<string>();
  const opacities: string[] = [];
  const copies = new Map<string, number>();

  for (const { text } of files) {
    fontSizes.push(...propertyValues(text, "fontSize"));
    weights.push(...propertyValues(text, "fontWeight"));
    radii.push(...propertyValues(text, "borderRadius"));
    for (const key of ["padding", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft", "paddingInline", "paddingBlock", "margin", "marginTop", "marginRight", "marginBottom", "marginLeft", "marginInline", "marginBlock", "gap", "rowGap", "columnGap"]) {
      for (const v of propertyValues(text, key)) {
        const kind = spacingKind(v);
        if (kind === "token") spacing.tokens++;
        else if (kind !== "zero") spacing[kind]++;
        if (key === "gap" && NUMBER.test(v)) gaps.push(v);
      }
    }
    shadows.push(...propertyValues(text, "boxShadow"));
    zs.push(...propertyValues(text, "zIndex"));
    for (const m of text.matchAll(/<button\b/g)) {
      buttons.raw++;
      if (/\bstyle=\{\{/.test(openingTag(text, m.index))) buttons.rawStyled++;
    }
    buttons.shared += [...text.matchAll(/<Button\b/g)].length;
    for (const m of text.matchAll(/["'`][^"'`\n]*["'`]/g)) {
      for (const h of m[0].matchAll(/#[0-9a-fA-F]{3,8}\b/g)) hexes.push(h[0].toLowerCase());
    }
    for (const m of text.matchAll(/\brgba?\(([^)]*)\)/g)) {
      rgbUses++;
      const parts = (m[1] ?? "").split(",").map((s) => s.trim());
      if (parts.length === 4 && parts[0] === "0" && parts[1] === "0" && parts[2] === "0" && NUMBER.test(parts[3]!)) blackAlphas.add(parts[3]!);
    }
    for (const v of propertyValues(text, "opacity")) if (STATE_WORDS.test(v)) for (const n of v.matchAll(/\b0?\.\d+\b/g)) opacities.push(n[0]);
    for (const name of COPIES) {
      const count = [...text.matchAll(new RegExp(`function ${name}\\b`, "g"))].length;
      if (count > 0) copies.set(name, (copies.get(name) ?? 0) + count);
    }
  }

  const rawSizes = fontSizes.filter((v) => NUMBER.test(v));
  return {
    files: files.length,
    fontSize: { total: fontSizes.length, tokens: fontSizes.filter((v) => /^theme\.font\./.test(v)).length, raw: tally(rawSizes), rawCount: rawSizes.length },
    fontWeight: tally(weights.filter((v) => NUMBER.test(v))),
    radius: {
      total: radii.length,
      tokens: radii.filter((v) => /^theme\.radius\./.test(v)).length,
      raw: tally(radii.filter((v) => NUMBER.test(v) || /^["']\d+%["']$/.test(v)).map((v) => v.replace(/'/g, '"'))),
    },
    spacing: { ...spacing, gaps: tally(gaps) },
    shadows: { uses: shadows.length, distinct: new Set(shadows).size },
    zIndex: tally(zs),
    buttons,
    hex: { uses: hexes.length, distinct: new Set(hexes).size, untokened: hexes.filter((h) => !TOKEN_HEX.has(h)).length },
    rgb: { uses: rgbUses, blackAlphas: blackAlphas.size },
    disabledOpacity: { uses: opacities.length, values: tally(opacities) },
    copies,
  };
}

/**
 * Section 5.5's allowlist. Each entry says which checks it is exempt from,
 * so an exception stays as small as the reason for it.
 *
 * A file that is all tokens, all art or all TV (the theme, a board layer,
 * the table display) is exempt as a whole. A file that mixes a stored
 * palette with ordinary interface code is exempt only inside the named
 * declarations that hold the palette (`declarations`), so a color written
 * into a button's style there is still a finding.
 */
export type Exemption = { colors?: true; sizes?: true; stacking?: true };

export type AllowEntry = {
  match: (file: string) => boolean;
  why: string;
  exempt: Exemption;
  /** The `const`, `let` or `function` declarations the exemption covers. The whole file when left out. */
  declarations?: readonly string[];
};

const ART_FILES = [
  "client/features/builder/draw.ts",
  "client/features/builder/textures.ts",
  "client/features/builder/stamps/rules.ts",
  "client/features/builder/stamps/draw.ts",
  "client/features/builder/stamps/StampHandles.tsx",
  "client/features/builder/heights/relief.ts",
  "client/features/builder/heights/boardText.ts",
  "client/features/vision/SightOverlay.tsx",
  "client/features/mapexport/render.ts",
];

export const ALLOWLIST: readonly AllowEntry[] = [
  { match: (f) => f === "client/lib/theme.ts" || f === "client/lib/accent.ts", why: "tokens and the accent math", exempt: { colors: true } },
  {
    match: (f) => f === "client/features/scenes/create.ts",
    why: "stored data defaults, part of saved rooms",
    exempt: { colors: true },
    declarations: ["DEFAULT_GRID", "MAT_BACKGROUND", "BUILDER_BACKGROUND", "MAP_BACKGROUND"],
  },
  { match: (f) => f === "client/features/tokens/EffectsSection.tsx", why: "the custom effect palette", exempt: { colors: true }, declarations: ["CUSTOM_COLORS"] },
  { match: (f) => f === "client/lib/tokenView.ts", why: "the status palette", exempt: { colors: true }, declarations: ["CHIPS", "OTHER_CHIP_COLOR"] },
  {
    match: (f) => (f.startsWith("client/canvas/") && f !== "client/canvas/TokenActionBar.tsx" && f !== "client/canvas/SceneLoading.tsx") || /^client\/features\/.+Layer\.tsx$/.test(f) || ART_FILES.includes(f),
    why: "art drawn on the board or into an export",
    exempt: { colors: true },
  },
  { match: (f) => f === "client/features/images/icons.ts", why: "the icon glyph's inks", exempt: { colors: true }, declarations: ["NEAR_BLACK", "WHITE"] },
  { match: (f) => f === "client/features/images/iconColors.ts", why: "the icon disk's neutrals", exempt: { colors: true }, declarations: ["ICON_NEUTRALS", "DEFAULT_ICON_COLOR"] },
  { match: (f) => f === "client/features/images/IconsTab.tsx", why: "the names of the icon disk's colors", exempt: { colors: true }, declarations: ["COLOR_NAMES"] },
  { match: (f) => f.startsWith("client/features/display/"), why: "the table display's TV sizes and stacking", exempt: { colors: true, sizes: true, stacking: true } },
];

type Span = { from: number; to: number };

/**
 * Where each named declaration sits in the text: from `const NAME`,
 * `let NAME` or `function NAME` to the end of its statement or body, the
 * first `;` or line end outside every bracket and string.
 */
export function declarationSpans(text: string, names: readonly string[]): Span[] {
  const out: Span[] = [];
  for (const name of names) {
    const re = new RegExp(`(?:^|\\n)[ \\t]*(?:export[ \\t]+)?(?:const|let|function)[ \\t]+${name}\\b`, "g");
    for (const m of text.matchAll(re)) {
      let depth = 0;
      let quote: string | null = null;
      let j = m.index + m[0].length;
      for (; j < text.length; j++) {
        const ch = text[j]!;
        if (quote) {
          if (ch === "\\") j++;
          else if (ch === quote) quote = null;
          continue;
        }
        if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (depth === 0 && (ch === ";" || ch === "\n")) break;
      }
      out.push({ from: m.index, to: j });
    }
  }
  return out;
}

/** What a file is exempt from, and where: everywhere, or only inside its named declarations. */
function exemption(file: SourceFile): { exempt: Exemption; within: (index: number) => boolean } {
  const exempt: Exemption = {};
  let spans: Span[] | null = null;
  for (const entry of ALLOWLIST) {
    if (!entry.match(file.path)) continue;
    Object.assign(exempt, entry.exempt);
    if (entry.declarations) spans = [...(spans ?? []), ...declarationSpans(file.text, entry.declarations)];
  }
  const scoped = spans;
  return { exempt, within: (index) => scoped === null || scoped.some((s) => index >= s.from && index < s.to) };
}

export type Finding = { file: string; line: number; rule: "color" | "fontSize" | "borderRadius" | "boxShadow" | "zIndex" | "opacity"; text: string };

/**
 * What section 5.5's drift test fails on: a hex or rgb literal outside the
 * allowlist, a raw font size or radius number, a shadow that is not a
 * `theme.shadow` value, a z-index above 2 outside `theme.z`, and an
 * opacity that depends on a disabled or busy state (Principle 4).
 */
export function findings(files: readonly SourceFile[]): Finding[] {
  const out: Finding[] = [];
  const at = (file: SourceFile, index: number, rule: Finding["rule"], text: string) => out.push({ file: file.path, line: lineOf(file.text, index), rule, text });
  for (const file of files) {
    const { text } = file;
    const { exempt, within } = exemption(file);
    for (const m of text.matchAll(/["'`][^"'`\n]*["'`]/g)) {
      if (exempt.colors && within(m.index)) continue;
      for (const h of m[0].matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)/g)) at(file, m.index, "color", h[0]);
    }
    const scan = (key: string, rule: Finding["rule"], bad: (v: string) => boolean) => {
      const re = new RegExp(`(?<![\\w$.-])${key}\\s*:\\s*`, "g");
      const values = propertyValues(text, key);
      let k = 0;
      for (let m = re.exec(text); m; m = re.exec(text), k++) {
        const v = values[k] ?? "";
        if (bad(v)) at(file, m.index, rule, `${key}: ${v}`);
      }
    };
    if (!exempt.sizes) scan("fontSize", "fontSize", (v) => NUMBER.test(v));
    scan("borderRadius", "borderRadius", (v) => NUMBER.test(v) && v !== "0");
    // A shadow may be chosen by a condition, as long as every choice is a token, "none" or nothing.
    scan("boxShadow", "boxShadow", (v) => /["'`\d]/.test(v.replace(/theme\.shadow\.\w+|undefined|"none"|'none'/g, "")));
    if (!exempt.stacking) scan("zIndex", "zIndex", (v) => NUMBER.test(v) && Number(v) > 2);
    scan("opacity", "opacity", (v) => STATE_WORDS.test(v));
  }
  return out;
}

function report(m: Measures): string {
  const pct = (a: number, b: number) => (b === 0 ? "0%" : `${Math.round((a / b) * 100)}%`);
  const spacingAll = m.spacing.tokens + m.spacing.raw + m.spacing.other;
  const lines = [
    `Files scanned: ${m.files}`,
    `Font sizes from tokens: ${m.fontSize.tokens} of ${m.fontSize.total} (${pct(m.fontSize.tokens, m.fontSize.total)}). ${m.fontSize.rawCount} raw numbers in ${m.fontSize.raw.size} values: ${formatTally(m.fontSize.raw)}`,
    `Font weights: ${formatTally(m.fontWeight)}`,
    `Radii from tokens: ${m.radius.tokens} of ${m.radius.total}. Raw: ${formatTally(m.radius.raw)}`,
    `Spacing from tokens: ${pct(m.spacing.tokens, spacingAll)} of non-zero padding, margin and gap (${m.spacing.tokens} tokens, ${m.spacing.raw} raw, ${m.spacing.other} other). Raw gaps: ${formatTally(m.spacing.gaps)}`,
    `Shadows: ${m.shadows.uses} uses, ${m.shadows.distinct} distinct values`,
    `z-index: ${[...m.zIndex.values()].reduce((a, b) => a + b, 0)} uses: ${formatTally(m.zIndex)}`,
    `Raw <button> vs <Button>: ${m.buttons.raw} vs ${m.buttons.shared}. ${m.buttons.rawStyled} of the raw ones carry their own inline style`,
    `Hex literals: ${m.hex.uses} (${m.hex.distinct} distinct), ${m.hex.untokened} of them equal to no token. rgb literals: ${m.rgb.uses} (${m.rgb.blackAlphas} alphas of black)`,
    `Disabled or busy opacity: ${m.disabledOpacity.uses} places, values ${formatTally(m.disabledOpacity.values)}`,
    `Local copies of one pattern: ${formatTally(new Map([...m.copies].map(([k, v]) => [k, v])))}`,
  ];
  return lines.join("\n");
}

if (import.meta.main) {
  const files = clientFiles();
  if (process.argv.includes("--findings")) {
    const found = findings(files);
    for (const f of found) console.log(`${f.file}:${f.line} ${f.rule} ${f.text}`);
    console.log(`${found.length} findings`);
  } else {
    console.log(report(measure(files)));
    console.log(`Drift test findings (section 5.5): ${findings(files).length}. Run with --findings to list them.`);
  }
}
