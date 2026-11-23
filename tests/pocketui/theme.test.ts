// The theme contract: every theme PocketUI ships paints every part in every
// state, in colours a reader can tell apart, and draws every mark.
import { describe, expect, test } from "bun:test";
import { bitmap, NO_GLYPH, stockGlyph } from "../../framework/src/pocketui/core/glyphs.ts";
import { GLYPHS, inkOf, PARTS, REST, type Paint, type PartState, type Theme } from "../../framework/src/pocketui/core/theme.ts";
import { THEMES, themeById } from "../../framework/src/pocketui/themes/index.ts";

const HEX = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i;

function rgb(color: string): [number, number, number, number] {
  const n = color.slice(1);
  return [parseInt(n.slice(0, 2), 16), parseInt(n.slice(2, 4), 16), parseInt(n.slice(4, 6), 16), n.length === 8 ? parseInt(n.slice(6, 8), 16) / 255 : 1];
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((v, i) => (i < 3 ? (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4) : v));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}
/** The colours a paint puts behind its content: the fill, or each end of the gradient. */
function grounds(paint: Paint): string[] {
  if (paint.gradient) return [paint.gradient[0], paint.gradient[paint.gradient.length - 1]!];
  // a ground painted by a layer under the content (the default button's face inside its frame)
  const face = paint.under?.find((layer) => layer.fill && layer.l !== undefined && layer.r !== undefined && layer.t !== undefined && layer.b !== undefined);
  if (face?.fill) return [face.fill];
  return paint.fill && rgb(paint.fill)[3] > 0.9 ? [paint.fill] : [];
}

const STATES: Partial<PartState>[] = [
  {},
  { pressed: true },
  { focused: true },
  { hovered: true },
  { hovered: true, disabled: true },
  { variant: "overlay" },
  { variant: "panel" },
  { disabled: true },
  { selected: true },
  { selected: true, focused: true },
  { active: false },
  { variant: "filled" },
  { variant: "filled", pressed: true },
  { variant: "filled", tone: "bad" },
  { variant: "tinted", tone: "bad" },
  { variant: "plain" },
  { variant: "pill" },
  { variant: "self" },
  { variant: "close" },
  { variant: "close", disabled: true },
  { variant: "table" },
  { tone: "warn" },
  { tone: "bad" },
  { tone: "good" },
];

describe.each(THEMES.map((theme) => [theme.id, theme] as const))("the %s theme", (_id, theme: Theme) => {
  test("paints every part in every state with colours the core can parse", () => {
    for (const part of PARTS) {
      for (const partial of STATES) {
        const paint = theme.paint(part, { ...REST, ...partial });
        expect(typeof paint).toBe("object");
        const colours = [paint.fill, paint.border, ...(paint.gradient ?? []), ...Object.values(paint.ink ?? {}), ...Object.values(paint.bevel ?? {}).filter((v) => typeof v === "string")];
        for (const layer of paint.under ?? []) colours.push(layer.fill, layer.border, ...(layer.gradient ?? []));
        for (const colour of colours) if (colour !== undefined) expect(`${part}: ${colour}`).toMatch(new RegExp(`^${part.replace(".", "\\.")}: ${HEX.source.slice(1)}`, "i"));
        // the core draws bevels square: a part that rounds its corners cannot also bevel them
        if (paint.bevel) expect(paint.radius ?? 0).toBe(0);
      }
    }
  });

  test("its palette is complete and its text reads on its grounds", () => {
    for (const [name, value] of Object.entries(theme.color)) expect(`${name}: ${value}`).toMatch(/^[a-zA-Z]+: #[0-9a-f]{6}([0-9a-f]{2})?$/i);
    expect(contrast(theme.color.text, theme.color.surface)).toBeGreaterThan(7);
    expect(contrast(theme.color.text, theme.color.canvas)).toBeGreaterThan(7);
    expect(contrast(theme.color.muted, theme.color.surface)).toBeGreaterThan(4);
    for (const tone of ["accent", "good", "warn", "bad", "note"] as const) expect(contrast(theme.color[tone], theme.color.surface)).toBeGreaterThan(3);
  });

  test("what a part sets on its own ground can be read there", () => {
    // the parts that carry a label, in the states that change their ground
    const cases: [(typeof PARTS)[number], Partial<PartState>][] = [
      ["row", {}],
      ["row", { selected: true }],
      ["row", { selected: true, focused: true }],
      ["menu.item", {}],
      ["menu.item", { focused: true }],
      ["menu.item", { hovered: true }],
      ["menubar.item", { hovered: true }],
      ["row", { hovered: true }],
      ["section", { variant: "panel" }],
      ["picker", {}],
      ["menu.item", { selected: true }],
      ["button", { variant: "filled" }],
      ["button", { variant: "filled", pressed: true }],
      ["button", { variant: "filled", tone: "bad" }],
      ["button", { variant: "tinted" }],
      ["button", { variant: "tinted", tone: "bad" }],
      ["bar.button", {}],
      ["bar.button", { selected: true }],
      ["caption", {}],
      ["dialog.caption", {}],
      ["section", {}],
      ["badge", { tone: "warn" }],
      ["tooltip", {}],
      ["tooltip", { tone: "bad" }],
      ["drag", {}],
      ["bubble", { variant: "self" }],
      ["status", {}],
      ["menubar.item", { selected: true }],
      ["segment", { selected: true }],
    ];
    for (const [part, partial] of cases) {
      const state = { ...REST, ...partial };
      const paint = theme.paint(part, state);
      const behind = grounds(paint);
      if (behind.length === 0) behind.push(part === "row" || part === "menu.item" || part === "section" ? theme.color.surface : theme.color.canvas);
      // the tone the kit sets a label in for that part
      const tone = part === "bar.button" ? "accent" : part === "badge" ? state.tone : state.tone === "bad" && part === "button" ? undefined : undefined;
      const ink = inkOf(tone, paint.ink, theme.color);
      for (const ground of behind) expect(`${part} ${JSON.stringify(partial)}: ${contrast(ink, ground) >= 3 ? "reads" : `${ink} on ${ground}`}`).toBe(`${part} ${JSON.stringify(partial)}: reads`);
    }
  });

  test("its metrics size things a finger can hit, and its marks fit their boxes", () => {
    for (const metric of [theme.metric, theme.compact]) {
      expect(metric.target).toBeGreaterThanOrEqual(20);
      expect(metric.bar).toBeGreaterThanOrEqual(20);
      expect(metric.control).toBeGreaterThanOrEqual(20);
      if (theme.traits.scroll === "strip") expect(metric.scrollbar).toBeGreaterThanOrEqual(12);
      if (theme.traits.caption) expect(metric.caption).toBeGreaterThanOrEqual(metric.captionButton[1]);
    }
    for (const name of GLYPHS) {
      for (const variant of [undefined, "caption", "toggle", "scroll"]) {
        const art = theme.glyph(name, 10, { ...REST, variant }) ?? stockGlyph(name, 10);
        expect(art.w).toBeLessThanOrEqual(14);
        expect(art.h).toBeLessThanOrEqual(14);
        for (const shape of art.shapes) {
          expect(shape.w).toBeGreaterThan(0);
          expect(shape.h).toBeGreaterThan(0);
        }
      }
    }
  });
});

/** The points of a layer's four rounded corners, the layer resolved in a part `W` by `H`. The core rounds a box by at most half its shorter side. */
function cornerPoints(layer: NonNullable<Paint["under"]>[number], W: number, H: number): [number, number][] {
  const w = layer.w ?? W - (layer.l ?? 0) - (layer.r ?? 0);
  const h = layer.h ?? (layer.hFrac !== undefined ? Math.round(H * layer.hFrac) : H - (layer.t ?? 0) - (layer.b ?? 0));
  const x = layer.l !== undefined ? layer.l : layer.r !== undefined ? W - layer.r - w : 0;
  const y = layer.t !== undefined ? layer.t : layer.b !== undefined ? H - layer.b - h : 0;
  const r = Math.max(0, Math.min(layer.radius ?? 0, w / 2, h / 2));
  const out: [number, number][] = [];
  for (const [cx, cy, from] of [[x + r, y + r, 180], [x + w - r, y + r, 270], [x + w - r, y + h - r, 0], [x + r, y + h - r, 90]] as const) {
    for (let step = 0; step <= 9; step++) {
      const angle = ((from + step * 10) * Math.PI) / 180;
      out.push([cx + r * Math.cos(angle), cy + r * Math.sin(angle)]);
    }
  }
  return out;
}

describe("a rounded part's edge", () => {
  // Found on a device: the lights of a gel are rounded boxes of their own,
  // squarer than the capsule they sit in, and where they were set too near
  // its rim their corners painted the rim out on the diagonals. Whatever a
  // theme paints under a rounded part's content stays inside its edge.
  test.each(THEMES.map((theme) => [theme.id, theme] as const))("nothing the %s theme paints under a rounded part crosses its rim", (_id, theme: Theme) => {
    const crossed: string[] = [];
    for (const part of PARTS) {
      for (const partial of STATES) {
        const paint = theme.paint(part, { ...REST, ...partial });
        const R = paint.radius ?? 0;
        if (R < 4 || !paint.under || paint.border === undefined) continue;
        const inner = R - (paint.borderWidth ?? 1);
        for (const [W, H] of [[72, Math.max(2 * R, theme.metric.control)], [200, 44], [2 * R, 2 * R]] as const) {
          for (const layer of paint.under) {
            for (const [px, py] of cornerPoints(layer, W, H)) {
              // the part's corner this point is in, if it is in one
              const cx = px < R ? R : px > W - R ? W - R : null;
              const cy = py < R ? R : py > H - R ? H - R : null;
              if (cx === null || cy === null) continue;
              const reach = Math.hypot(px - cx, py - cy);
              if (reach > inner + 0.05) crossed.push(`${part} ${JSON.stringify(partial)} at ${W}x${H}: a layer reaches ${reach.toFixed(2)} of ${inner}`);
            }
          }
        }
      }
    }
    expect([...new Set(crossed)].slice(0, 6)).toEqual([]);
  });
});

describe("themes", () => {
  test("are found by id, and an unknown id is the default", () => {
    expect(themeById("aqua").id).toBe("aqua");
    expect(themeById("nope").id).toBe("pocket");
    expect(new Set(THEMES.map((theme) => theme.id)).size).toBe(THEMES.length);
  });

  test("differ in arrangement, not only in paint", () => {
    const by = (id: string) => themeById(id).traits;
    expect(by("pocket").caption).toBe(false);
    expect(by("classic").caption).toBe(true);
    expect(by("classic").commands).toBe("menubar");
    expect(by("aqua").commands).toBe("bar");
    expect(by("aqua").captionControls).toBe("leading");
    expect(by("luna").captionControls).toBe("trailing");
    expect(by("aqua").defaultLast).toBe(true);
    expect(by("classic").defaultLast).toBe(false);
    expect(by("pocket").picker).toBe("row");
    expect(by("aqua").picker).toBe("popup");
    expect(by("pocket").actions).toBe("heading");
    expect(by("luna").actions).toBe("footer");
    expect(by("aqua").unifiedBars).toBe(true);
    // a scroll bar is a thumb over the content in every shipped theme: a strip takes width and wants a pointer
    for (const theme of THEMES) expect(theme.traits.scroll).toBe("overlay");
  });
});

describe("marks", () => {
  test("a bitmap is one rectangle per run of ink", () => {
    const art = bitmap(["##..#", ".###."]);
    expect(art.w).toBe(5);
    expect(art.h).toBe(2);
    expect(art.shapes).toEqual([
      { x: 0, y: 0, w: 2, h: 1, color: undefined },
      { x: 4, y: 0, w: 1, h: 1, color: undefined },
      { x: 1, y: 1, w: 3, h: 1, color: undefined },
    ]);
    expect(bitmap(["#"], 2).shapes[0]).toEqual({ x: 0, y: 0, w: 2, h: 2, color: undefined });
  });

  test("every mark has stock art, and no art draws nothing", () => {
    for (const name of GLYPHS) expect(stockGlyph(name, 10).shapes.length).toBeGreaterThan(0);
    expect(NO_GLYPH.shapes.length).toBe(0);
  });
});
