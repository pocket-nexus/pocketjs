// apps/pocket-chan/chan.ts — Pocket Chan's character sheet, in the three
// languages she speaks.
//
// One row per clip. `sprite` names the atlas `tools/pocket-chan/bake.py` wrote
// next to this file; `sprites.json` carries its grid and frame step, so the
// app never restates them. Keep the `key` values in step with
// `tools/pocket-chan/poses.py` — the baker names the files from them.

export type Lang = 0 | 1 | 2; // 0 en, 1 ja, 2 zh

/** en / ja / zh, in that order. */
export type Say = readonly [string, string, string];

export interface Pose {
  readonly key: string;
  readonly set: number;
  readonly sprite: string;
  readonly name: Say;
  readonly lines: readonly Say[];
}

export const LANG_NAME: Say = ["EN", "日本語", "中文"];

export const SET_NAME: readonly Say[] = [
  ["EMOTIONS", "表情", "表情"],
  ["ACTIONS", "しぐさ", "小动作"],
  ["TURNAROUND", "三面図", "三视图"],
];

export const UI = {
  subtitle: ["character sheet", "キャラクター表", "角色设定集"] as Say,
  set: ["SET", "セット", "分组"] as Say,
  pose: ["POSE", "ポーズ", "姿势"] as Say,
  talk: ["TALK", "はなす", "说话"] as Say,
  lang: ["LANG", "ことば", "语言"] as Say,
  sheet: ["SHEET", "設定", "设定"] as Say,
  palette: ["PALETTE", "配色", "配色"] as Say,
  build: ["BUILD", "ビルド", "构建"] as Say,
  close: ["CLOSE", "とじる", "关闭"] as Say,
};

export const POSES: readonly Pose[] = [
  {
    key: "smile",
    set: 0,
    sprite: "chan-smile.png",
    name: ["Hello", "ごきげん", "微笑"],
    lines: [
      ["I am Pocket Chan.", "ポケットちゃんです。", "我是 Pocket Chan。"],
      ["This handheld is from 2005.", "この機械は2005年製。", "这台掌机是 2005 年的。"],
    ],
  },
  {
    key: "happy",
    set: 0,
    sprite: "chan-happy.png",
    name: ["Delighted", "うれしい", "开心"],
    lines: [
      ["Same JavaScript, smaller world.", "同じJavaScript、小さな世界。", "一样的 JavaScript。"],
      ["Rust draws every frame.", "描画はRustの仕事。", "每一帧由 Rust 绘制。"],
    ],
  },
  {
    key: "think",
    set: 0,
    sprite: "chan-think.png",
    name: ["Thinking", "かんがえ中", "思考"],
    lines: [
      ["Layout, damage, draw.", "配置、差分、描画。", "布局、差分、绘制。"],
      ["Where did that frame go?", "あのフレームはどこ？", "那一帧去哪了？"],
    ],
  },
  {
    key: "nap",
    set: 0,
    sprite: "chan-nap.png",
    name: ["Idle", "ひとやすみ", "摸鱼"],
    lines: [
      ["No change, no redraw.", "変化なし、再描画なし。", "没有变化就不重绘。"],
      ["Wake me on the next button.", "次のボタンで起こして。", "下次按键再叫我。"],
    ],
  },
  {
    key: "code",
    set: 1,
    sprite: "chan-code.png",
    name: ["Shipping", "コーディング", "敲代码"],
    lines: [
      ["TSX in, native code out.", "TSXから native へ。", "写 TSX，出原生代码。"],
      ["MicroTS compiles my views.", "MicroTSがビューを変換。", "MicroTS 编译我的视图。"],
    ],
  },
  {
    key: "hug",
    set: 1,
    sprite: "chan-hug.png",
    name: ["Holding", "ぎゅっ", "抱紧"],
    lines: [
      ["This mark is my hairpin.", "このマークは髪どめ。", "这个标志也是我的发夹。"],
      ["Pink dot, cyan bar.", "ピンクの点、シアンの棒。", "粉点、青条。"],
    ],
  },
  {
    key: "proud",
    set: 1,
    sprite: "chan-proud.png",
    name: ["Ta-dah", "どやっ", "得意"],
    lines: [
      ["Nine clips, one pak file.", "9つの動き、パックは1つ。", "九段动画，一个 pak。"],
      ["Eight frames, looped by the core.", "それぞれ8コマ。", "每段八帧，核心循环。"],
    ],
  },
  {
    key: "go",
    set: 1,
    sprite: "chan-go.png",
    name: ["Heading out", "しゅっぱつ", "出发"],
    lines: [
      ["PSP, GBA, 3DS, phones.", "PSP、GBA、3DS、スマホ。", "PSP、GBA、3DS、手机。"],
      ["One app, many screens.", "1つのアプリ、多くの画面。", "一个应用，很多屏幕。"],
    ],
  },
  {
    key: "spin",
    set: 2,
    sprite: "chan-spin.png",
    name: ["Turnaround", "三面図", "三视图"],
    lines: [
      ["Front, side, back, side.", "正面、横、後ろ、横。", "正面、侧面、背面。"],
      ["One rig, four facings.", "同じリグで4方向。", "同一套骨架，四个朝向。"],
    ],
  },
];

export interface Swatch {
  readonly hex: string;
  /** A FULL class literal — the style compiler resolves classes at build time,
   *  so a swatch cannot interpolate its own hex into one. */
  readonly dot: string;
  readonly name: Say;
}

/** The hues the rig paints with (tools/pocket-chan/rig.py). */
export const PALETTE: readonly Swatch[] = [
  { hex: "FFD400", dot: "w-[16] h-[16] rounded-md bg-[#FFD400]", name: ["hair", "かみ", "头发"] },
  { hex: "FF3D8B", dot: "w-[16] h-[16] rounded-md bg-[#FF3D8B]", name: ["pink", "ピンク", "粉色"] },
  { hex: "35C8E8", dot: "w-[16] h-[16] rounded-md bg-[#35C8E8]", name: ["cyan", "シアン", "青色"] },
  { hex: "1B1A26", dot: "w-[16] h-[16] rounded-md bg-[#1B1A26]", name: ["cloth", "ふく", "衣服"] },
  { hex: "FFE3CF", dot: "w-[16] h-[16] rounded-md bg-[#FFE3CF]", name: ["skin", "はだ", "皮肤"] },
  { hex: "F8F8FC", dot: "w-[16] h-[16] rounded-md bg-[#F8F8FC]", name: ["inner", "インナー", "内衬"] },
];
