import { readFileSync } from "node:fs";

export const variants = [
  { id: "enamel", letter: "A", name: "温润珐琅", english: "Warm enamel", note: "细暖金边框，奶油色按键。保留老图标的温度，收掉三色之间的争抢。", top: "#40344c", bottom: "#191522", rim: "#b9a589", shell: "#edc675", dot: "#f5e8cb", bar: "#f5e8cb", gloss: .19 },
  { id: "graphite", letter: "B", name: "深紫磨砂", english: "Plum graphite", note: "深紫底与银白标志。只有一层柔光，四个方案里最安静。", top: "#393343", bottom: "#201b2b", rim: "#82798b", shell: "#e7e0ee", dot: "#e7e0ee", bar: "#e7e0ee", gloss: .07 },
  { id: "brass", letter: "C", name: "暖金徽章", english: "Brass badge", note: "把主页的黄色移到整块底面，以深紫标志压住亮度。像一枚小金属徽章。", top: "#e6c977", bottom: "#b18b41", rim: "#f1dbaa", shell: "#312638", dot: "#312638", bar: "#312638", gloss: .20 },
  { id: "arcade", letter: "D", name: "克制三色", english: "Quiet arcade", note: "保留黄、粉、青的品牌关系，降低饱和度；用连续柔光替换硬边高光。", top: "#3a304d", bottom: "#191424", rim: "#9b91a4", shell: "#efce77", dot: "#dc91ad", bar: "#83c6d0", gloss: .12 },
] as const;
export type Variant = (typeof variants)[number];

// Mount the existing brand drawing; color studies never redraw its geometry.
const brand = readFileSync(new URL("../../site/assets/favicon.svg", import.meta.url), "utf8");
const start = brand.indexOf('  <rect x="2"');
if (start < 0 || !brand.includes("</svg>")) throw new Error("Pocket mark source changed");
const mark = brand.slice(start, brand.indexOf("</svg>", start));

export function artwork(v: Variant, platform: "ios" | "3ds", size: number): string {
  const ios = platform === "ios";
  const small = size === 24;
  const body = ios
    ? `<g transform="translate(14.68 16) scale(2.645)">${mark.replaceAll("#ffd23f", v.shell).replaceAll("#ff5f9e", v.dot).replaceAll("#3fd0e8", v.bar)}</g>`
    // At 24/48 px use integral stroke edges and slightly more space between
    // the keys. These are optical-size drawings, not downscaled iOS artwork.
    : small
      ? `<rect x="3" y="5" width="18" height="14" rx="4" fill="none" stroke="${v.shell}" stroke-width="2"/><circle cx="8" cy="12" r="2" fill="${v.dot}"/><rect x="12" y="9" width="6" height="2" rx="1" fill="${v.bar}"/><rect x="12" y="13" width="4" height="2" rx="1" fill="${v.dot}"/>`
      : `<rect x="5.5" y="9.5" width="37" height="29" rx="8" fill="none" stroke="${v.shell}" stroke-width="3"/><circle cx="16" cy="24" r="4" fill="${v.dot}"/><rect x="24" y="19" width="12" height="3" rx="1.5" fill="${v.bar}"/><rect x="24" y="26" width="8" height="3" rx="1.5" fill="${v.dot}"/>`;
  const units = ios ? 114 : size;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${units} ${units}">
  <defs>
    <linearGradient id="base" x2="0" y2="1"><stop stop-color="${v.top}"/><stop offset="1" stop-color="${v.bottom}"/></linearGradient>
    <radialGradient id="light" cx=".38" cy="0" r=".9"><stop stop-color="#fff" stop-opacity="${v.gloss}"/><stop offset=".8" stop-color="#fff" stop-opacity="0"/></radialGradient>
    <linearGradient id="edge" x2="0" y2="1"><stop stop-color="${v.rim}"/><stop offset=".45" stop-color="${v.bottom}"/><stop offset="1" stop-color="${v.rim}"/></linearGradient>
  </defs>
  ${ios ? "" : `<rect width="${units}" height="${units}" fill="${v.bottom}"/>`}
  ${ios ? `<rect x=".75" y=".75" width="112.5" height="112.5" rx="22" fill="url(#edge)"/>
  <rect x="2.25" y="2.25" width="109.5" height="109.5" rx="20.5" fill="url(#base)"/>
  <rect x="2.25" y="2.25" width="109.5" height="109.5" rx="20.5" fill="url(#light)"/>
  <rect x="3.25" y="3.25" width="107.5" height="107.5" rx="19.5" fill="none" stroke="${v.rim}" stroke-opacity=".18"/>` : `<rect width="${units}" height="${units}" fill="${v.id === "brass" ? "#d6b55f" : v.bottom}"/>`}
  ${body}
  </svg>`;
}
