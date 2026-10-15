import { cutName, wrapWhole } from "../../lib/boardText.ts";

type Measure = (text: string, px: number) => number;

/**
 * A pill's lines. A value (a distance, "Moved 20 ft" over "10 ft left") is
 * never cut: it is the reading the pill exists for, and a cut number reads
 * as a different number. An optional member name in front of it ("Vex ·
 * 30 ft") is cut on its own, keeping at least four letters, or left out.
 * A name with no value (an area's name, a ping's member) wraps onto two
 * lines, then is cut on the second, or is cut on one line when `maxLines`
 * is 1, since the full name is a tap away in its panel.
 */
export function pillLines(input: { value?: string; name?: string | null; px: number; maxWidth: number; maxLines?: 1 | 2 }, measure: Measure): string[] {
  const { value, px, maxWidth } = input;
  const name = input.name?.trim() || null;
  if (value !== undefined) {
    const valueLines = value.split("\n");
    if (!name) return valueLines;
    if (valueLines.length > 1) return [measure(name, px) <= maxWidth ? name : (cutName(name, undefined, maxWidth, px, measure) ?? name), ...valueLines];
    const one = `${name} · ${value}`;
    if (measure(one, px) <= maxWidth) return [one];
    const room = maxWidth - measure(` · ${value}`, px);
    const cut = room > 0 ? cutName(name, undefined, room, px, measure) : null;
    return cut ? [`${cut} · ${value}`] : [value];
  }
  if (!name) return [];
  if (measure(name, px) <= maxWidth) return [name];
  if (input.maxLines === 1) return [cutName(name, undefined, maxWidth, px, measure) ?? name];
  const two = wrapWhole(name, undefined, maxWidth, 2, px, measure);
  if (two) return two;
  const first = wrapWhole(name, undefined, maxWidth, Number.MAX_SAFE_INTEGER, px, measure);
  if (first && first.length > 1) {
    const rest = first.slice(1).join(" ");
    const cut = cutName(rest, undefined, maxWidth, px, measure);
    return cut ? [first[0]!, cut] : [first[0]!];
  }
  return [cutName(name, undefined, maxWidth, px, measure) ?? name];
}
