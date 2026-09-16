// Prepare external acceptance assets. The font and document never enter the PAK.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { bakeFontArchive } from "../framework/compiler/font-archive.ts";
const out = resolve(Bun.argv[2] ?? ".pocket-build/text-lab");
const revision = "f8d157532fbfaeda587e826d4cd5b21a49186f7c";
const sha = "68a3fc98800b2a27b371f2fb79991daf3633bd89309d4ffaa6946fd587f375b5";
await mkdir(join(out, "fonts"), { recursive: true });
const source = join(out, "NotoSansCJKjp-Regular.otf");
let font: Uint8Array;
try {
  font = await readFile(source);
} catch {
  const response = await fetch(
    `https://raw.githubusercontent.com/notofonts/noto-cjk/${revision}/Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf`,
  );
  if (!response.ok) throw new Error(`Font download failed: ${response.status}`);
  font = new Uint8Array(await response.arrayBuffer());
}
if (createHash("sha256").update(font).digest("hex") !== sha)
  throw new Error("Font source checksum mismatch");
await writeFile(source, font);
const archive = await bakeFontArchive({
  font: source,
  slots: [0, 2, 4],
  onStrike: (slot, count) => console.log(`slot ${slot}: ${count} glyphs`),
});
await writeFile(join(out, "fonts/cjk.pjfa"), archive);
const documents = {
  "common.txt": "的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其然前外天政四日社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处理世车价歌曲读书春风夜雨海云花光梦声音乐文件章节" ,
  "songs.txt": [
    "01 - 龘靐齉 / 𠮷野の夜.flac\t4:32\tNight Sessions",
    "02 - 気迫、東京と大阪.mp3\t3:48\tCity Lights",
    "03 - 春風と麤い雨 [现场版].ogg\t5:16\tLive at Riverside",
    "04 - 読書の時間：珈琲と檸檬.m4a\t2:57\tQuiet Hours",
    "05 - 重复歌名／重复歌名／長いファイル名.wav\t6:04\tLost & Found",
    "06 - 夜航——山川、星空与海洋.flac\t4:21\tNight Sessions",
  ].join("\n"),
  "chapter-1.txt": [
    "第一章　夜航",
    "江边的旧书店关门后，少年把一张写着龘、靐、齉的纸夹进小说。他并不认识这些字，却记得远方朋友说过，名字与故事一样，应该完整地出现。",
    "窗外细雨落在石桥上。𠮷野从东京寄来一封信，信中写着気迫二字，还有珈琲、檸檬与麤石铺成的小路。读到这里，他停下音乐，把那首长歌名抄在纸上。",
    "船经过山谷、田野与森林。灯光照着玻璃，水面倒映星空。风吹过桥头，云从月亮旁边移开，街道尽头传来钟声。有人走进房间，放下行李，翻开另一页。",
    "这一章的后半段还没有上屏，但它的字形已经和前半段一起预加载。翻页不会逐字补齐，也不需要再次访问字库。雨停了，故事仍在继续。",
  ].join("\n"),
  "chapter-2.txt": [
    "第二章　山中的来信",
    "篝火映照嶙峋的岩壁，苔藓覆盖蜿蜒的小径。鹧鸪掠过藤蔓，蜻蜓停在芦苇尖端。旅人收起罗盘，凝视溪流里斑驳的倒影。",
    "匣中的笺纸写满陌生词语：饕餮、魑魅、踌躇、蹉跎、璀璨、旖旎、氤氲。她逐行读下去，发现所谓秘笈其实是祖父记录四季的日记。",
    "春有桃杏，夏有芙蕖，秋有丹桂，冬有腊梅。骤雨冲刷屋檐，晨曦越过山峦，黄昏笼罩村落。故事中的每个名字，都随着同一批文字一起呈现。",
  ].join("\n"),
};
for (const [name, text] of Object.entries(documents)) {
  if (Buffer.byteLength(text) > 1536) throw new Error(`${name} exceeds the local text page budget`);
  await writeFile(join(out, name), text);
}
await writeFile(
  join(out, "fonts/LICENSE-NotoSansCJK.txt"),
  await readFile(
    new URL("../assets/fonts/LICENSE-NotoSansCJK.txt", import.meta.url),
  ),
);
console.log(
  `Copy fonts/ and *.txt from ${out} to ms0:/PSP/COMMON/pocketjs/`,
);
console.log(
  `Archive: ${archive.length} bytes, SHA256 ${createHash("sha256").update(archive).digest("hex")}`,
);
