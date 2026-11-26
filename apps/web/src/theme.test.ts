// Dark-mode safety: colours live only in index.css, and every text pair meets WCAG AA in both themes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dir = import.meta.dirname;
const css = readFileSync(join(dir, "index.css"), "utf8");
const vars = (block: string) => Object.fromEntries([...block.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6});/g)].map((m) => [m[1]!, m[2]!]));
const light = vars(css.slice(css.indexOf("@theme {"), css.indexOf(":root {")));
const darkStart = css.indexOf("@media (prefers-color-scheme: dark)");
const dark = vars(css.slice(darkStart, css.indexOf("body {", darkStart)));

const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};
const ratio = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const TEXT: [string, string[]][] = [
  ["ink", ["canvas", "panel", "mist", "hero", "wash"]],
  ["soft", ["canvas", "panel", "mist", "hero"]],
  ["accent", ["canvas", "panel", "mist", "hero"]],
  ["accent-deep", ["wash", "panel", "mist", "hero"]],
  ["on-accent", ["accent", "accent-hover"]],
  ["warn", ["warn-wash", "panel", "mist", "hero"]],
  ["danger", ["danger-wash", "panel", "mist", "hero"]],
  ["on-danger", ["danger"]],
  ["info", ["info-wash"]],
  ["panel", ["ink"]], // the dark Trust tab pill
  ["on-inverse", ["inverse"]], // demo bar and toasts
];

describe.each([["light", light], ["dark", dark]] as const)("%s theme", (_name, t) => {
  // The hero is the accent at 8% over the panel colour, as in index.css.
  const colour = (k: string) => (k === "hero" ? rgb(t.panel!).map((v, i) => Math.round(v * 0.92 + rgb(t.accent!)[i]! * 0.08)) : rgb(t[k]!));
  it("defines every token the light theme has", () => {
    expect(Object.keys(t).sort()).toEqual(Object.keys(light).sort());
  });
  it("meets 4.5:1 for text", () => {
    const low = TEXT.flatMap(([fg, bgs]) => bgs.map((bg) => ({ pair: `${fg} on ${bg}`, r: ratio(colour(fg), colour(bg)) }))).filter((x) => x.r < 4.5);
    expect(low.map((x) => `${x.pair} = ${x.r.toFixed(2)}`)).toEqual([]);
  });
  it("meets 3:1 for input borders and focus rings", () => {
    for (const [fg, bg] of [["edge", "panel"], ["edge", "mist"], ["accent", "panel"], ["accent", "canvas"]]) expect(ratio(colour(fg!), colour(bg!))).toBeGreaterThanOrEqual(3);
  });
});

describe("colour literals", () => {
  const sources = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(join(d, e.name)) : /(?<!\.test)\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
  it("appear nowhere in components", () => {
    const literal = /#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b(?![0-9a-zA-Z-])|rgba?\(|\b(?:bg|text|border|ring|fill|stroke)-(?:white|black|(?:red|sky|emerald|amber|stone|violet|gray|slate)-\d+)\b/;
    const offenders = sources(dir).filter((f) => literal.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("reduced motion stylesheet", () => {
  it("switches off animation and transition for the class and for the media query", () => {
    expect(css).toMatch(/:root\.reduce-motion \*[^{]*\{\s*animation: none !important;\s*transition: none !important;/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important;/);
    expect(css).toContain(":root.reduce-motion .ripple { display: none; }");
  });
});
