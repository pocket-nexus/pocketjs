#!/usr/bin/env bun

// Pocket Studio on the TrimUI Smart Pro (programs/trimui-smart-pro,
// apps/studio-handheld, engine/arcade):
//
//   bun tools/trimui-smart-pro.ts build                     -> .pocket-build/trimui-smart-pro/
//   bun tools/trimui-smart-pro.ts room --studio <checkout>  bake the room from a Pocket Studio checkout
//   bun tools/trimui-smart-pro.ts asr                       fetch sherpa-onnx and the Paraformer model
//   bun tools/trimui-smart-pro.ts install                   build, then push the app over adb
//   bun tools/trimui-smart-pro.ts auth [--proxy URL]        copy ~/.codex/auth.json, and write config.json
//   bun tools/trimui-smart-pro.ts run                       start the app in MainUI's place, logging to /tmp/studio.log
//   bun tools/trimui-smart-pro.ts stop                      stop the app; MainUI returns
//   bun tools/trimui-smart-pro.ts ctl '<line>'              send a line to the app's validation pipe
//   bun tools/trimui-smart-pro.ts shot <out.png>            pull a screenshot of the running app
//
// build    the profile, the package, and the program for aarch64 Linux against
//          glibc 2.33 (the firmware's; needs cargo-zigbuild and zig). libGLESv2,
//          libEGL and libasound are link-time stubs: the device's own load at run time.
// install  everything goes under /mnt/UDISK/pocket-studio; a launcher entry goes
//          in /mnt/UDISK/Apps, internal storage MainUI scans with or without an SD card.

import { $ } from "bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const out = join(root, ".pocket-build", "trimui-smart-pro");
const config = "programs/trimui-smart-pro/pocket.host.config.ts";
const profileRs = join(out, "profile", "pocket_profile.rs");
const pocket = join(out, "studio.pocket");
const TARGET = "aarch64-unknown-linux-gnu";
const GLIBC = "2.33";
const program = join(out, "cargo", TARGET, "release", "pocket-trimui-smart-pro");
const stubs = join(out, "stubs");
const room = join(out, "assets", "room.pak");
const asrDir = join(out, "asr");
const DATA = "/mnt/UDISK/pocket-studio";
const SHERPA = "v2.0.1";
const MODEL = "sherpa-onnx-paraformer-zh-small-2024-03-09";

const STUB_SYMBOLS: Record<string, { soname: string; names: string[] }> = {
  "libGLESv2.so": {
    soname: "libGLESv2.so.2",
    names: `glActiveTexture glAttachShader glBindAttribLocation glBindBuffer glBindFramebuffer glBindRenderbuffer glBindTexture glBindVertexArray glBlendFunc glBlendFuncSeparate glBufferData glBufferSubData glCheckFramebufferStatus glClear glClearColor glColorMask glCompileShader glCompressedTexImage2D glCreateProgram glCreateShader glDeleteBuffers glDeleteFramebuffers glDeleteProgram glDeleteRenderbuffers glDeleteShader glDeleteTextures glDeleteVertexArrays glDepthFunc glDepthMask glDisable glDisableVertexAttribArray glDrawArrays glDrawElements glDrawElementsInstanced glEnable glEnableVertexAttribArray glFinish glFlush glFramebufferRenderbuffer glFramebufferTexture2D glGenBuffers glGenFramebuffers glGenRenderbuffers glGenTextures glGenVertexArrays glGenerateMipmap glGetError glGetIntegerv glGetProgramInfoLog glGetProgramiv glGetShaderInfoLog glGetShaderiv glGetUniformLocation glLinkProgram glPixelStorei glPolygonOffset glReadPixels glRenderbufferStorage glScissor glShaderSource glTexImage2D glTexParameteri glTexSubImage2D glUniform1f glUniform1i glUniform2f glUniform3f glUniform4f glUniformMatrix4fv glUseProgram glVertexAttrib4f glVertexAttribDivisor glVertexAttribPointer glViewport`.split(" "),
  },
  "libasound.so": {
    soname: "libasound.so.2",
    names: `snd_pcm_close snd_pcm_drain snd_pcm_drop snd_pcm_open snd_pcm_recover snd_pcm_set_params snd_pcm_wait snd_pcm_writei snd_strerror`.split(" "),
  },
  "libEGL.so": {
    soname: "libEGL.so.1",
    names: `eglBindAPI eglChooseConfig eglCreateContext eglCreateWindowSurface eglGetDisplay eglGetError eglInitialize eglMakeCurrent eglQuerySurface eglSwapBuffers eglSwapInterval`.split(" "),
  },
};

const argv = process.argv.slice(2);
const option = (name: string) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

async function linkStubs(): Promise<void> {
  mkdirSync(stubs, { recursive: true });
  for (const [file, { soname, names }] of Object.entries(STUB_SYMBOLS)) {
    const source = join(stubs, `${file}.c`);
    writeFileSync(source, names.map((name) => `void ${name}(void) {}`).join("\n") + "\n");
    await $`zig cc -target aarch64-linux-gnu.${GLIBC} -shared -Wl,-soname,${soname} -o ${join(stubs, file)} ${source}`.env({ ...process.env, ZIG_GLOBAL_CACHE_DIR: join(out, "zig-cache") }).quiet();
  }
}

async function compile(): Promise<void> {
  await $`bun tools/pocket.ts host export --config ${config} --out ${join(out, "profile")}`.cwd(root).quiet();
  await $`bun tools/pocket.ts compile --manifest apps/studio-handheld/pocket.app.json --project-root . --host-config ${config} --plan-dir ${join(out, "plan")} --output ${pocket}`.cwd(root).quiet();
}

async function build(): Promise<void> {
  await linkStubs();
  await compile();
  await $`cargo zigbuild --release -p pocket-trimui-smart-pro --target ${TARGET}.${GLIBC} --target-dir ${join(out, "cargo")}`
    .cwd(root)
    .env({ ...process.env, POCKETJS_PROFILE_RS: profileRs, TRIMUI_LINK_STUBS: stubs });
  console.log(`trimui-smart-pro: ${program}\ntrimui-smart-pro: ${pocket}`);
}

async function bakeRoom(): Promise<void> {
  const studio = option("--studio") ?? process.env.POCKET_STUDIO_DIR;
  if (!studio) throw new Error("room needs --studio <pocket-studio checkout> or $POCKET_STUDIO_DIR");
  await $`bun ${join(import.meta.dir, "trimui-smart-pro/bake-room.ts")} --studio ${studio} --out ${room}`;
}

async function fetchAsr(): Promise<void> {
  mkdirSync(asrDir, { recursive: true });
  const runtime = `sherpa-onnx-${SHERPA}-linux-aarch64-shared-cpu`;
  if (!existsSync(join(asrDir, runtime))) {
    await $`curl -sSL -o ${join(asrDir, `${runtime}.tar.bz2`)} https://github.com/k2-fsa/sherpa-onnx/releases/download/${SHERPA}/${runtime}.tar.bz2`;
    await $`tar xjf ${join(asrDir, `${runtime}.tar.bz2`)} -C ${asrDir}`;
  }
  if (!existsSync(join(asrDir, MODEL))) {
    await $`curl -sSL -o ${join(asrDir, `${MODEL}.tar.bz2`)} https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2`;
    await $`tar xjf ${join(asrDir, `${MODEL}.tar.bz2`)} -C ${asrDir}`;
  }
}

const LAUNCH = `#!/bin/sh
echo 1 > /tmp/stay_awake
export LD_LIBRARY_PATH=/usr/lib
cd ${DATA}
[ -p /tmp/pocket-studio.ctl ] || mkfifo /tmp/pocket-studio.ctl
./pocket-trimui-smart-pro >/tmp/studio.log 2>&1
rm -f /tmp/stay_awake
`;
const LAUNCHER_CONFIG = JSON.stringify({
  label: "Pocket Studio",
  "label.ch.lang": "Pocket Studio",
  icon: "icon.png",
  iconsel: "icon.png",
  launch: "launch.sh",
  description: "Make 3D games by talking to your console",
  "description.ch.lang": "对掌机说话，就能做 3D 小游戏",
}, null, 2);

async function pushAsr(): Promise<void> {
  if (!existsSync(join(asrDir, MODEL))) return;
  const runtime = join(asrDir, `sherpa-onnx-${SHERPA}-linux-aarch64-shared-cpu`);
  await $`adb shell mkdir -p ${DATA}/asr/lib ${DATA}/asr/model`;
  await $`adb push ${join(runtime, "bin/sherpa-onnx-offline-websocket-server")} ${DATA}/asr/`.quiet();
  await $`adb push ${join(runtime, "lib/libonnxruntime.so")} ${DATA}/asr/lib/`.quiet();
  await $`adb push ${join(runtime, "lib/libsherpa-onnx-c-api.so")} ${DATA}/asr/lib/`.quiet();
  await $`adb push ${join(asrDir, MODEL, "model.int8.onnx")} ${DATA}/asr/model/`.quiet();
  await $`adb push ${join(asrDir, MODEL, "tokens.txt")} ${DATA}/asr/model/`.quiet();
  await $`adb shell chmod +x ${DATA}/asr/sherpa-onnx-offline-websocket-server`;
}

async function install(): Promise<void> {
  await build();
  await $`adb shell mkdir -p ${DATA}/assets /mnt/UDISK/Apps/PocketStudio`;
  await $`adb push ${program} ${DATA}/pocket-trimui-smart-pro`.quiet();
  await $`adb shell chmod +x ${DATA}/pocket-trimui-smart-pro`;
  await $`adb push ${pocket} ${DATA}/studio.pocket`.quiet();
  if (existsSync(room)) await $`adb push ${room} ${DATA}/assets/room.pak`.quiet();
  else console.warn("trimui-smart-pro: no baked room yet: run `room --studio <checkout>`");
  await pushAsr();
  const launcher = join(out, "launcher");
  mkdirSync(launcher, { recursive: true });
  writeFileSync(join(launcher, "launch.sh"), LAUNCH);
  writeFileSync(join(launcher, "config.json"), LAUNCHER_CONFIG);
  const { drawIcon } = await import("./companion/icon.ts");
  writeFileSync(join(launcher, "icon.png"), drawIcon(128, { tile: true }));
  await $`adb push ${join(launcher, "launch.sh")} ${join(launcher, "config.json")} ${join(launcher, "icon.png")} /mnt/UDISK/Apps/PocketStudio/`.quiet();
  await $`adb shell chmod +x /mnt/UDISK/Apps/PocketStudio/launch.sh`;
  console.log("trimui-smart-pro: installed; MainUI lists it after a restart");
}

async function auth(): Promise<void> {
  const source = join(homedir(), ".codex", "auth.json");
  if (!existsSync(source)) throw new Error(`${source}: sign in with the Codex CLI first`);
  await $`adb shell mkdir -p ${DATA}`;
  await $`adb push ${source} ${DATA}/auth.json`.quiet();
  await $`adb shell chmod 600 ${DATA}/auth.json`;
  const proxy = option("--proxy");
  const model = option("--model");
  const settings: Record<string, string> = { ...(proxy ? { proxy } : {}), ...(model ? { model } : {}), ...(option("--effort") ? { effort: option("--effort")! } : {}) };
  const file = join(out, "config.json");
  mkdirSync(out, { recursive: true });
  writeFileSync(file, JSON.stringify(settings, null, 2));
  await $`adb push ${file} ${DATA}/config.json`.quiet();
  const tokens = JSON.parse(readFileSync(source, "utf8")).tokens;
  const payload = JSON.parse(Buffer.from(tokens.access_token.split(".")[1], "base64url").toString());
  console.log(`trimui-smart-pro: sign-in copied; the access token lasts ${Math.round((payload.exp - Date.now() / 1000) / 3600)} more hours`);
}

/** runtrimui.sh deletes cmd_to_run.sh after the script it ran exits, so a running
 * app goes first and MainUI returns before the next script lands. */
async function run(): Promise<void> {
  const running = (await $`adb shell pidof pocket-trimui-smart-pro`.nothrow().text()).trim();
  if (running) {
    await $`adb shell killall -9 pocket-trimui-smart-pro`.nothrow().quiet();
    for (let i = 0; i < 100; i++) {
      if ((await $`adb shell pidof MainUI`.nothrow().text()).trim()) break;
      await Bun.sleep(100);
    }
  }
  const script = `#!/bin/sh
echo 1 > /tmp/stay_awake
export LD_LIBRARY_PATH=/usr/lib
cd ${DATA}
[ -p /tmp/pocket-studio.ctl ] || mkfifo /tmp/pocket-studio.ctl
./pocket-trimui-smart-pro >/tmp/studio.log 2>&1
echo exit=$? >> /tmp/studio.log
`;
  const file = join(out, "cmd_to_run.sh");
  writeFileSync(file, script);
  await $`adb push ${file} /tmp/cmd_to_run.sh`.quiet();
  await $`adb shell chmod +x /tmp/cmd_to_run.sh`;
  await $`adb shell killall -9 MainUI`.nothrow().quiet();
}

async function ctl(line: string): Promise<void> {
  // The app opens the pipe nonblocking; this write blocks only while it is not running.
  await $`adb shell ${`echo ${JSON.stringify(line)} > /tmp/pocket-studio.ctl`}`;
}

async function shot(path: string): Promise<void> {
  const remote = "/tmp/studio-shot.png";
  await $`adb shell rm -f ${remote}`.quiet();
  await ctl(`shot ${remote}`);
  for (let i = 0; i < 40; i++) {
    const size = (await $`adb shell ${`[ -s ${remote} ] && echo ready`}`.nothrow().text()).trim();
    if (size === "ready") break;
    await Bun.sleep(100);
  }
  await Bun.sleep(150);
  await $`adb pull ${remote} ${path}`.quiet();
  console.log(path);
}

switch (argv[0]) {
  case "build": await build(); break;
  case "room": await bakeRoom(); break;
  case "asr": await fetchAsr(); break;
  case "install": await install(); break;
  case "auth": await auth(); break;
  case "run": await run(); break;
  case "stop": await $`adb shell killall pocket-trimui-smart-pro`.nothrow(); break;
  case "ctl": await ctl(argv.slice(1).join(" ")); break;
  case "shot": await shot(argv[1] ?? join(out, "shot.png")); break;
  default:
    console.error("usage: bun tools/trimui-smart-pro.ts build|room|asr|install|auth|run|stop|ctl|shot");
    process.exit(2);
}
