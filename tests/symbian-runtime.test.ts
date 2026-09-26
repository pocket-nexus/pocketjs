import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveModality } from "../contracts/spec/modality.ts";
import { POCKET_TARGETS } from "../contracts/spec/platforms.ts";
import {
  SYMBIAN_E7_DEV_CONTRACTS,
  SYMBIAN_E7_DEV_HOST_ABI,
  SYMBIAN_E7_DEV_TARGET_ID,
  resolveSymbianE7BuildPlan,
} from "../tools/symbian-profile.ts";
import {
  encodeSymbianCatalog,
  includeExternalManifests,
  launcherGeneratedSources,
  needsLauncherCompile,
  scanRegistry,
  withLauncherSourceLock,
  type SymbianCatalogEntry,
} from "../tools/launcher.ts";
import { validateAndResolveBuildPlan } from "../framework/src/manifest/resolve.ts";

const repository = new URL("..", import.meta.url).pathname;

describe("experimental Nokia E7 runtime profile", () => {
  test("maps the E7 scan matrix without changing unrelated keys", () => {
    const compiler = Bun.which("cc");
    expect(
      compiler,
      "cc is required to validate the Symbian key mapper",
    ).toBeTruthy();
    if (!compiler) return;
    const root = mkdtempSync(join(tmpdir(), "pocketjs-e7-key-map-"));
    try {
      const executable = join(root, "symbian-key-map-test");
      const compiled = Bun.spawnSync([
        compiler,
        "-std=c11",
        "-Wall",
        "-Wextra",
        "-Werror",
        join(
          repository,
          "tests/fixtures/symbian-key-normalization-test.c",
        ),
        "-o",
        executable,
      ], { cwd: repository });
      expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);

      // Managed macOS hosts can attach provenance to a freshly linked
      // temporary executable and hold its first launch beyond Bun's timeout.
      // This file is built above from the committed hermetic fixture.
      if (process.platform === "darwin") {
        const xattr = Bun.which("xattr");
        if (xattr) {
          Bun.spawnSync([
            xattr,
            "-d",
            "com.apple.provenance",
            executable,
          ]);
        }
      }
      const ran = Bun.spawnSync([executable], { cwd: repository });
      expect(ran.exitCode, ran.stderr.toString()).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("serializes the shared launcher source tree across targets", async () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-launcher-source-lock-"));
    try {
      const env = { POCKET_STACK_CACHE_DIR: join(root, "cache") };
      let active = 0;
      let maxActive = 0;
      const build = () => withLauncherSourceLock(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(20);
        active -= 1;
      }, env);
      await Promise.all([build(), build()]);
      expect(maxActive).toBe(1);

      const launcher = readFileSync(
        join(repository, "tools/launcher.ts"),
        "utf8",
      );
      const sourceLock = launcher.indexOf(
        "await withLauncherSourceLock(async () =>",
      );
      const outputLock = launcher.indexOf(
        "await withSymbianBuildTransaction(paths.output",
        sourceLock,
      );
      expect(sourceLock).toBeGreaterThan(-1);
      expect(outputLock).toBeGreaterThan(sourceLock);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("never reuses stale Symbian guests and requires both cached outputs elsewhere", () => {
    const root = mkdtempSync(join(tmpdir(), "pocketjs-launcher-freshness-"));
    try {
      writeFileSync(join(root, "probe.js"), "js");
      writeFileSync(join(root, "probe.pak"), "pak");
      expect(
        needsLauncherCompile("probe", SYMBIAN_E7_DEV_TARGET_ID, root, false),
      ).toBe(true);
      expect(needsLauncherCompile("probe", "psp", root, false)).toBe(false);
      rmSync(join(root, "probe.pak"));
      expect(needsLauncherCompile("probe", "psp", root, false)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("encodes an aligned verbatim package catalog for the Qt host", () => {
    const entry = (
      output: string,
      id: string,
      title: string,
      bytes: number[],
      liveViewport: boolean,
    ): SymbianCatalogEntry => ({
      plan: {
        app: {
          output,
          id,
          title,
          version: "0.1.0",
          entry: "app.tsx",
          framework: "solid",
        },
        presentation: { id: "default", entry: "app.tsx" },
        target: { id: SYMBIAN_E7_DEV_TARGET_ID, hostAbi: SYMBIAN_E7_DEV_HOST_ABI },
        viewport: {
          logical: liveViewport ? [640, 360] : [480, 272],
          physical: liveViewport ? [640, 360] : [480, 272],
          presentation: "native",
          rasterDensity: 1,
          policy: liveViewport ? "dynamic" : "fixed",
        },
        modality: deriveModality(SYMBIAN_E7_DEV_CONTRACTS.targets[SYMBIAN_E7_DEV_TARGET_ID]),
        features: {},
        companions: [],
        planHash: `sha256:${"0".repeat(64)}`,
      },
      packageBytes: new Uint8Array(bytes),
      liveViewport,
    });
    const launcher = entry(
      "launcher-main",
      "dev.pocket-stack.launcher",
      "PocketJS: Launcher",
      [1, 2, 3],
      false,
    );
    const hero = entry(
      "hero-main",
      "dev.pocket-stack.hero",
      "PocketJS: Hero",
      [4, 5],
      true,
    );
    const catalog = encodeSymbianCatalog([launcher, hero]);
    expect(new TextDecoder().decode(catalog.index)).toBe(
      "launcher-main\tdev.pocket-stack.launcher\tPocketJS: Launcher\t0\t3\t480\t272\tfixed\n" +
        "hero-main\tdev.pocket-stack.hero\tPocketJS: Hero\t16\t2\t640\t360\tlive\n",
    );
    expect([...catalog.blob.subarray(0, 3)]).toEqual([1, 2, 3]);
    expect([...catalog.blob.subarray(3, 16)]).toEqual(new Array(13).fill(0));
    expect([...catalog.blob.subarray(16)]).toEqual([4, 5]);
  });

  test("keeps the experimental E7 target out of the production registry", () => {
    expect(Object.keys(POCKET_TARGETS)).toEqual([
      "psp",
      "vita",
      "pocketbook",
      "macos-widget",
      "macos-app",
      "linux-app",
      "web-app",
    ]);
    expect(POCKET_TARGETS).not.toHaveProperty(SYMBIAN_E7_DEV_TARGET_ID);
    expect(SYMBIAN_E7_DEV_HOST_ABI).toBe(4);
  });

  test("launcher admission includes only genuine E7 live-viewport apps", () => {
    const outputs = scanRegistry(
      new Set(),
      SYMBIAN_E7_DEV_TARGET_ID,
    ).apps.map((app) => app.output);
    expect(outputs).toEqual(["note-main", "hero-main"]);
    expect(outputs).not.toContain("cafe-main");
    expect(outputs).not.toContain("launcher-main");
  });

  test("thins the E7 launcher source to admitted Cover Flow textures", () => {
    const registry = scanRegistry(new Set(), SYMBIAN_E7_DEV_TARGET_ID);
    const generated = launcherGeneratedSources(registry);
    expect(generated.registryTs).toContain("cover-note-main.png");
    expect(generated.registryTs).toContain("cover-hero-main.png");
    expect(generated.registryTs).not.toContain("cover-cafe-main.png");
    expect(generated.registryTs).toContain("refl-note-main.png");
    expect(JSON.parse(generated.imagesJson)).toEqual({
      "covers/launcher-bg.png": { linear: true },
      "covers/cover-note-main.png": { linear: true },
      "covers/refl-note-main.png": { linear: true },
      "covers/cover-hero-main.png": { linear: true },
      "covers/refl-hero-main.png": { linear: true },
    });
  });

  test("adds explicit external manifests without leaking paths or dirtying sources", () => {
    const external = mkdtempSync(join(tmpdir(), "pocketjs-launcher-external-"));
    const registrySource = join(
      repository,
      "apps/launcher/registry.generated.ts",
    );
    const imagesSource = join(repository, "apps/launcher/images.json");
    const registryBefore = readFileSync(registrySource);
    const imagesBefore = readFileSync(imagesSource);
    const emittedPaths = [
      join(
        repository,
        "dist/launcher/symbian/launcher-registry.json",
      ),
      join(
        repository,
        "dist/launcher/symbian/launcher-registry.tsv",
      ),
    ];
    const emittedBefore = emittedPaths.map((path) =>
      existsSync(path) ? readFileSync(path) : undefined
    );
    try {
      const manifest = JSON.parse(
        readFileSync(join(repository, "apps/hero/pocket.json"), "utf8"),
      );
      manifest.id = "dev.pocket-stack.external-probe";
      manifest.name = "external-probe";
      manifest.title = "External Probe";
      manifest.app.entry = "app.tsx";
      manifest.app.output = "external-probe";
      delete manifest.app.viewport.fixed;
      const externalManifest = join(external, "pocket.json");
      writeFileSync(externalManifest, JSON.stringify(manifest, null, 2));
      writeFileSync(join(external, "app.tsx"), "export default function App() {}\n");

      const scanned = Bun.spawnSync([
        "bun",
        "tools/launcher.ts",
        "scan",
        "--target",
        "symbian",
        "--include-manifest",
        externalManifest,
      ], { cwd: repository });
      expect(scanned.exitCode).toBe(0);
      expect(readFileSync(registrySource)).toEqual(registryBefore);
      expect(readFileSync(imagesSource)).toEqual(imagesBefore);

      const emitted = JSON.parse(readFileSync(
        join(
          repository,
          "dist/launcher/symbian/launcher-registry.json",
        ),
        "utf8",
      )) as {
        apps: Array<Record<string, unknown>>;
      };
      const app = emitted.apps.find(
        (entry) => entry.output === "external-probe",
      );
      expect(app).toMatchObject({
        id: "dev.pocket-stack.external-probe",
        manifest: "pocket.json",
      });
      expect(app).not.toHaveProperty("projectRoot");
      expect(JSON.stringify(emitted)).not.toContain(external);
    } finally {
      emittedPaths.forEach((path, index) => {
        const previous = emittedBefore[index];
        if (previous) writeFileSync(path, previous);
        else rmSync(path, { force: true });
      });
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("external manifests cannot replace the launcher identity", () => {
    const external = mkdtempSync(join(tmpdir(), "pocketjs-launcher-collision-"));
    try {
      const manifest = JSON.parse(
        readFileSync(join(repository, "apps/launcher/pocket.json"), "utf8"),
      );
      manifest.app.entry = "app.tsx";
      manifest.app.viewport.dynamic = {
        default: [640, 360],
        min: [360, 360],
        max: [640, 640],
      };
      const manifestPath = join(external, "pocket.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(join(external, "app.tsx"), "export default function App() {}\n");
      expect(() =>
        includeExternalManifests(
          scanRegistry(new Set(), SYMBIAN_E7_DEV_TARGET_ID),
          [manifestPath],
          new Set(),
          SYMBIAN_E7_DEV_TARGET_ID,
        )
      ).toThrow("external output launcher-main duplicates");
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  test("selects the Hero's dynamic E7 viewport without changing its PSP viewport", () => {
    const manifest = JSON.parse(
      readFileSync(join(repository, "apps/hero/pocket.json"), "utf8"),
    );
    const plan = resolveSymbianE7BuildPlan(manifest);
    expect(plan.target).toEqual({
      id: SYMBIAN_E7_DEV_TARGET_ID,
      hostAbi: SYMBIAN_E7_DEV_HOST_ABI,
    });
    expect(plan.viewport).toEqual({
      logical: [640, 360],
      physical: [640, 360],
      presentation: "native",
      rasterDensity: 1,
      policy: "dynamic",
    });
    expect(plan.features["display.viewport.live"]).toBe(true);
    expect(plan.planHash).toMatch(/^sha256:[a-f0-9]{64}$/);

    const psp = validateAndResolveBuildPlan(manifest, { target: "psp" });
    expect(psp.ok).toBe(true);
    if (!psp.ok) return;
    expect(psp.plan.viewport).toEqual({
      logical: [480, 272],
      physical: [480, 272],
      presentation: "integer-fit",
      rasterDensity: 1,
      policy: "fixed",
    });
    expect(psp.plan.features["display.viewport.live"]).toBe(false);
  });

  test("publishes only capabilities implemented by the first E7 host", () => {
    const target = SYMBIAN_E7_DEV_CONTRACTS.targets[SYMBIAN_E7_DEV_TARGET_ID];
    expect(target.form).toBe("window");
    expect(target.display.dynamicViewport).toEqual({
      min: [360, 360],
      max: [640, 640],
    });
    expect(target.capabilities).toEqual([
      "input.buttons",
      "input.touch",
      "display.viewport.live",
      "text.glyphs.baked",
    ]);
  });

  test("keeps the Hero's horizontal regions wrap-safe in portrait", () => {
    const hero = readFileSync(join(repository, "apps/hero/Hero.tsx"), "utf8");
    expect(hero).toMatch(
      /debugName="Header"\s+class="flex-row flex-wrap items-center justify-between"/,
    );
    expect(hero).toContain('class="flex-row flex-wrap items-center justify-between"');
    expect(hero).toMatch(
      /debugName="Description"\s+class="flex-row flex-wrap gap-1"/,
    );
    expect(hero).toContain('"flex-row flex-wrap items-center gap-4"');
  });

  test("binds the strict target contract, live viewport, and E7 input", () => {
    const runtime = readFileSync(
      join(repository, "hosts/nokia-e7/runtime/main.cpp"),
      "utf8",
    );
    const project = readFileSync(
      join(repository, "hosts/nokia-e7/runtime/pocketjs-e7-runtime.pro"),
      "utf8",
    );
    const resources = readFileSync(
      join(repository, "hosts/nokia-e7/runtime/pocketjs-runtime.qrc"),
      "utf8",
    );
    const coreHeader = readFileSync(
      join(repository, "hosts/nokia-e7/runtime/pocketjs_symbian_core.h"),
      "utf8",
    );
    const coreCargo = readFileSync(
      join(repository, "engine/ui-cabi/Cargo.toml"),
      "utf8",
    );
    const coreSource = readFileSync(
      join(repository, "engine/ui-cabi/src/lib.rs"),
      "utf8",
    );
    const extensionHeader = readFileSync(
      join(repository, "hosts/nokia-e7/runtime/pocketjs_symbian_extension.h"),
      "utf8",
    );
    const keyHeader = readFileSync(
      join(repository, "hosts/nokia-e7/runtime/pocketjs_symbian_keys.h"),
      "utf8",
    );
    const orchestrator = readFileSync(
      join(repository, "tools/symbian.ts"),
      "utf8",
    );
    const buildApp = readFileSync(
      join(repository, "tools/symbian/container/pocketjs-symbian-build-app"),
      "utf8",
    );

    expect(runtime).toContain('JS_NewString(context, "symbian-e7-dev")');
    expect(runtime).toContain('"__hostAbi"');
    expect(runtime).toContain("JS_NewInt32(context, POCKETJS_HOST_ABI)");
    expect(runtime).toContain("JS_ExecutePendingJob");
    expect(runtime).toContain("#if POCKETJS_FRAME_RATE <= 0");
    expect(runtime).toContain("#elif (60 % POCKETJS_FRAME_RATE) != 0");
    expect(runtime).toContain(
      "const int kCoreTicksPerFrame = 60 / POCKETJS_FRAME_RATE;",
    );
    expect(runtime).toContain(
      "for (int tick = 0; tick < kCoreTicksPerFrame; ++tick)",
    );
    expect(runtime.match(/ui_tick\(\);/g)).toHaveLength(1);
    expect(runtime).toContain("#include <QtOpenGL/QGLWidget>");
    expect(runtime).toContain("class PocketJsRuntime : public QGLWidget");
    expect(runtime).toContain("QGLFormat pocketJsGlFormat()");
    expect(runtime).toContain("format.setRedBufferSize(8)");
    expect(runtime).toContain("format.setGreenBufferSize(8)");
    expect(runtime).toContain("format.setBlueBufferSize(8)");
    expect(runtime).toContain("format.setAlphaBufferSize(0)");
    expect(runtime).toContain("format.setDoubleBuffer(true)");
    expect(runtime).toContain("format.setDepth(");
    expect(runtime).toContain(
      "extension->flags & POCKETJS_SYMBIAN_EXTENSION_DEPTH_BUFFER",
    );
    expect(runtime).toContain("format.setStencil(false)");
    expect(runtime).toContain("format.setSampleBuffers(false)");
    expect(runtime).toContain("QGLWidget(pocketJsGlFormat())");
    expect(runtime).toContain("glInitialized_ = ui_gl_initialize() != 0;");
    expect(runtime).toContain(
      "PocketJS could not obtain a valid OpenGL ES 2 context.",
    );
    expect(runtime).toContain("PocketJS lost its OpenGL ES 2 context.");
    expect(runtime).toContain("glInitialized_ && isValid()");
    expect(runtime).toContain("void PocketJsRuntime::paintGL()");
    expect(runtime).toContain("? ui_gl_render_over(");
    expect(runtime).toContain(": ui_gl_render(");
    expect(runtime).toContain("const QRect target = presentationRect();");
    expect(runtime).toContain("glReadPixels(");
    expect(runtime).toContain(
      "const QRect sourceRect = nativeSelf_ > 0 ? rect() : presentationRect().intersected(rect());",
    );
    expect(runtime).toContain("height() - sourceRect.y() - sourceRect.height()");
    expect(runtime).toContain("if (pendingApp_ >= 0 && pendingSummon_)");
    expect(runtime).not.toContain("grabFrameBuffer");
    expect(runtime).toContain("updateGL();");
    expect(runtime).not.toContain("QPainter");
    expect(runtime).not.toMatch(/\bQImage\s+framebuffer_\b/);
    expect(runtime).not.toContain("ui_render(");
    expect(runtime).toContain("delta_ms");
    expect(runtime).toContain("present_ms");
    expect(runtime).not.toContain("\\tgpu_ms");
    expect(runtime).toContain("perfSamples_.append(sample)");
    expect(runtime).toContain("0x80000000U |");
    expect(runtime).toContain("point.id()) & 0xff) << 20");
    expect(runtime).toContain("static_cast<uint32_t>(y) & 0x3ff) << 10");
    expect(runtime).toContain("static_cast<uint32_t>(x) & 0x3ff");
    expect(runtime).toContain("position.x() >= target.left() + target.width()");
    expect(runtime).toContain("event->isAutoRepeat()");
    expect(runtime).toContain("case Qt::Key_Select:");
    expect(runtime).toContain("case Qt::Key_Backspace:");
    expect(runtime).toContain("case Qt::Key_Q:");
    expect(runtime).toContain("return kButtonLeftTrigger;");
    expect(runtime).toContain("case Qt::Key_E:");
    expect(runtime).toContain("return kButtonRightTrigger;");
    expect(runtime).toContain("case Qt::Key_T:");
    expect(runtime).toContain("return kButtonTriangle;");
    expect(runtime).toContain("case Qt::Key_S:");
    expect(runtime).toContain("return kButtonSquare;");
    expect(runtime).toContain("POCKETJS_SYMBIAN_KEY_MOVE_FORWARD");
    expect(runtime).toContain("POCKETJS_SYMBIAN_KEY_LOOK_LEFT");
    expect(runtime).toContain("POCKETJS_SYMBIAN_KEY_RELOAD");
    expect(runtime.match(/pocketjsSymbianControlKey\(/g))
      .toHaveLength(2);
    expect(runtime.match(/event->nativeScanCode\(\)/g)).toHaveLength(2);
    expect(runtime).toContain("nativeKeys_ |= nativeKey");
    expect(runtime).toContain("nativeKeys_ &= ~nativeKey");
    expect(runtime).toContain("pressedNativeKeys_ |= nativeKey");
    expect(runtime).toContain(
      "const uint32_t frameNativeKeys = nativeKeys_ | pressedNativeKeys_;",
    );
    expect(runtime).toContain("int frameButtons = buttons_ | pressedButtons_;");
    expect(runtime).toContain("void PocketJsRuntime::clearInput()");
    expect(runtime).toContain("pressedButtons_ = 0;");
    expect(runtime).toContain("pressedNativeKeys_ = 0;");
    expect(keyHeader).toContain(
      "((key) >= 'a' && (key) <= 'z') ? ((key) - ('a' - 'A')) : (key)",
    );
    expect(keyHeader).toContain("pocketjsSymbianNormalizeKey");
    expect(keyHeader).toContain("pocketjsSymbianE7PhysicalKey");
    for (const [scan, control] of [
      ["1", "Q"],
      ["2", "W"],
      ["3", "E"],
      ["4", "R"],
      ["5", "T"],
      ["6", "Y"],
      ["7", "U"],
      ["8", "I"],
      ["9", "O"],
      ["0", "P"],
    ]) {
      expect(keyHeader).toContain(`case '${scan}': return '${control}';`);
    }
    expect(keyHeader).toContain("pocketjsSymbianControlKey");
    expect(runtime).toContain("setAttribute(Qt::WA_AutoOrientation, true)");
    expect(runtime).toContain(
      "setAttribute(Qt::WA_InputMethodEnabled, false)",
    );
    expect(runtime).toContain("Qt::WA_LockPortraitOrientation : Qt::WA_LockLandscapeOrientation");
    expect(runtime).toContain('"__pocketResizeViewport"');
    expect(runtime).toContain("queueViewport(event->size())");
    expect(runtime).toContain("queueViewport(size())");
    expect(runtime).not.toContain("kTouchCoordinateExtent");
    expect(runtime).toContain("QRect PocketJsRuntime::presentationRect() const");
    expect(runtime).toContain("viewportSize_.width() /");
    expect(runtime).toContain("viewportSize_.height() /");
    expect(runtime).not.toContain("kLogicalWidth");
    expect(runtime).not.toContain('"__textures"');
    expect(runtime).toContain("const uint32_t kPakMagic = 0x4b504344U;");
    expect(runtime).toContain("bool findPakEntry(");
    expect(runtime).toContain("rawBlobLength > static_cast<uint32_t>(");
    expect(runtime).toContain(
      "memcmp(pack.constData() + nameOffset, key, keyLength)",
    );
    expect(runtime).toContain("case HostLoadTileTexture:");
    expect(runtime).toContain("ui_upload_tileset_tile(");
    expect(runtime).toContain(
      'addHostOperation(context, ui, "loadTileTexture", 2, HostLoadTileTexture)',
    );
    expect(coreHeader).toContain("int32_t ui_upload_tileset_tile(");

    expect(project).toContain("QT += core gui opengl");
    expect(project).toContain("equals(POCKETJS_PERF_TRACE, 1): DEFINES += POCKETJS_PERF_TRACE");
    expect(project).toContain("TARGET.EPOCHEAPSIZE = 0x400000 0x4000000");
    expect(project).toContain(
      "DEPLOYMENT.display_name = $$POCKETJS_SYMBIAN_CAPTION",
    );
    expect(project).toContain(
      "isEmpty(POCKETJS_HOST_ABI): error(POCKETJS_HOST_ABI is required)",
    );
    expect(project).toContain("DEFINES += POCKETJS_HOST_ABI=$$POCKETJS_HOST_ABI");
    expect(project).toContain("QMAKE_LFLAGS += --whole-archive");
    expect(project).toContain("QMAKE_LFLAGS += --no-whole-archive");
    expect(project).toContain(
      "POCKETJS_INITIAL_LOGICAL_WIDTH=$$POCKETJS_INITIAL_LOGICAL_WIDTH",
    );
    expect(project).toContain(
      "POCKETJS_INITIAL_LOGICAL_HEIGHT=$$POCKETJS_INITIAL_LOGICAL_HEIGHT",
    );
    expect(buildApp).toContain(
      "initial_logical_width=$(jq -er '.viewport.logical[0]'",
    );
    expect(buildApp).toContain(
      '"POCKETJS_INITIAL_LOGICAL_WIDTH=$initial_logical_width"',
    );
    expect(buildApp).toContain(
      '"$quickjs_root/libquickjs-sys/embed/static-functions.c"',
    );
    expect(buildApp).toContain(
      "host_abi=$(jq -er '.target.hostAbi' \"$payload/plan.json\")",
    );
    expect(buildApp).toContain('"POCKETJS_HOST_ABI=$host_abi"');
    expect(buildApp).toContain("10#$initial_logical_width > 640");
    expect(buildApp).toContain("integer extents from 1 through 640");
    expect(resources).toContain('<file alias="app.js">app.js</file>');
    expect(resources).toContain('<file alias="app.pak">app.pak</file>');
    expect(resources).toContain('<file alias="catalog.tsv">catalog.tsv</file>');
    expect(resources).toContain('<file alias="catalog.bin">catalog.bin</file>');

    expect(coreHeader).toContain("int32_t ui_gl_initialize(void);");
    expect(coreHeader).toContain("void ui_gl_reset_resources(void);");
    expect(coreHeader).toContain("void ui_gl_shutdown(void);");
    expect(coreHeader).toContain("int32_t ui_gl_render(");
    expect(coreHeader).toContain("int32_t ui_gl_render_over(");
    expect(project).toContain("pocketjs_symbian_extension.h");

    expect(extensionHeader).toContain(
      "POCKETJS_SYMBIAN_EXTENSION_ABI_V1 = 1",
    );
    expect(extensionHeader).toContain(
      "POCKETJS_SYMBIAN_EXTENSION_DEPTH_BUFFER = 1u << 0",
    );
    expect(extensionHeader).toContain(
      "typedef struct PocketJsSymbianExtensionV1",
    );
    expect(extensionHeader).toContain(
      "void (*shutdown)(int32_t gl_context_current)",
    );
    expect(extensionHeader).toContain(
      "pocketjs_symbian_extension_v1(void)",
    );
    expect(extensionHeader).not.toContain("__attribute__((weak))");
    expect(extensionHeader).toContain(
      "explicit null provider avoids ELF weak relocations",
    );
    expect(coreCargo).toContain(
      'default = ["standalone-extension-provider"]',
    );
    expect(coreCargo).toContain('crate-type = ["rlib", "staticlib"]');
    expect(coreSource).toContain(
      '#[cfg(feature = "standalone-extension-provider")]',
    );
    expect(coreSource).toContain(
      "pub extern \"C\" fn pocketjs_symbian_extension_v1()",
    );
    const extensionRust = readFileSync(
      join(repository, "engine/ui-cabi/src/extension.rs"),
      "utf8",
    );
    for (const [cName, rustName, bit] of [
      ["POCKETJS_SYMBIAN_KEY_MOVE_FORWARD", "KEY_MOVE_FORWARD", 0],
      ["POCKETJS_SYMBIAN_KEY_MOVE_BACK", "KEY_MOVE_BACK", 1],
      ["POCKETJS_SYMBIAN_KEY_MOVE_LEFT", "KEY_MOVE_LEFT", 2],
      ["POCKETJS_SYMBIAN_KEY_MOVE_RIGHT", "KEY_MOVE_RIGHT", 3],
      ["POCKETJS_SYMBIAN_KEY_LOOK_UP", "KEY_LOOK_UP", 4],
      ["POCKETJS_SYMBIAN_KEY_LOOK_DOWN", "KEY_LOOK_DOWN", 5],
      ["POCKETJS_SYMBIAN_KEY_LOOK_LEFT", "KEY_LOOK_LEFT", 6],
      ["POCKETJS_SYMBIAN_KEY_LOOK_RIGHT", "KEY_LOOK_RIGHT", 7],
      ["POCKETJS_SYMBIAN_KEY_FIRE", "KEY_FIRE", 8],
      ["POCKETJS_SYMBIAN_KEY_JUMP", "KEY_JUMP", 9],
      ["POCKETJS_SYMBIAN_KEY_RELOAD", "KEY_RELOAD", 10],
      ["POCKETJS_SYMBIAN_KEY_WALK", "KEY_WALK", 11],
    ] as const) {
      expect(extensionHeader).toContain(`${cName} = 1u << ${bit}`);
      expect(extensionRust).toContain(
        `pub const ${rustName}: u32 = 1 << ${bit};`,
      );
    }
    expect(runtime).toContain(
      "extension->struct_size < sizeof(PocketJsSymbianExtensionV1)",
    );
    expect(runtime).toContain("sizeof(JSValue) == 8");
    expect(runtime).toContain("extension_->boot(");
    expect(runtime).toContain("JS_NewArrayBufferCopy(");
    expect(runtime).toContain(
      "extension_->shutdown(hasContext ? 1 : 0)",
    );
    expect(runtime).toContain("extension_->before_guest(");
    expect(runtime).toContain("extension_->after_guest(context_)");
    expect(runtime).toContain("extension_->resize(");
    expect(runtime).toContain("extension_->render(");
    expect(orchestrator).toContain("coreLibrary?: string;");
    expect(orchestrator).toContain("massStorageDataRoot?: string;");
    expect(orchestrator).toContain(
      'resolve(payload, "libpocketjs_symbian_core.a")',
    );
    expect(orchestrator).toContain(
      'coreLibrary: flagValue(args.slice(2), "--core-library")',
    );
    expect(orchestrator).toContain(
      '"--mass-storage-data-root"',
    );
    expect(orchestrator).toContain(
      "stageSymbianMassStorageData(massStorageDataRoot, payload)",
    );
    expect(orchestrator).toContain(
      "Symbian application-specific cores cannot be combined with a multi-app catalog",
    );

    const applyViewport = runtime.indexOf(
      "bool PocketJsRuntime::applyPendingViewport()",
    );
    const resizeCore = runtime.indexOf(
      "ui_set_viewport(viewport.width(), viewport.height());",
      applyViewport,
    );
    const callHook = runtime.indexOf("resizeViewport_,", resizeCore);
    const drainJobs = runtime.indexOf("if (!drainJobs()) return false;", callHook);
    const scheduleGl = runtime.indexOf("update();", drainJobs);
    expect(applyViewport).toBeGreaterThan(-1);
    expect(resizeCore).toBeGreaterThan(applyViewport);
    expect(callHook).toBeGreaterThan(resizeCore);
    expect(drainJobs).toBeGreaterThan(callHook);
    expect(scheduleGl).toBeGreaterThan(drainJobs);
  });

  test("embeds validated .pocket guests and cold-switches after presentation", () => {
    const runtime = readFileSync(
      join(repository, "hosts/nokia-e7/runtime/main.cpp"),
      "utf8",
    );

    expect(runtime).toContain("kPocketPackageMagic = 0x544b4350U");
    expect(runtime).toContain('target != "symbian-e7-dev"');
    expect(runtime).toContain(
      "hostAbi != static_cast<uint32_t>(POCKETJS_HOST_ABI)",
    );
    expect(runtime).toContain(
      "pocketHash(package, package.size() - 8) != storedHash",
    );
    expect(runtime).toContain(
      "embedded .pocket identity does not match its catalog row",
    );
    expect(runtime).toContain('"appTable"');
    expect(runtime).toContain('"appLaunch"');
    expect(runtime).toContain('"appShot"');
    expect(runtime).toContain("JS_SetContextOpaque(context, owner)");
    expect(runtime).toContain("frameButtons &= ~kButtonSelect");
    expect(runtime).toContain("selectPressed && !selectLatched_");

    const runFrame = runtime.indexOf(
      "void PocketJsRuntime::runFrame()",
    );
    const tick = runtime.indexOf("ui_tick();", runFrame);
    const present = runtime.indexOf("updateGL();", tick);
    const finish = runtime.indexOf("finishPendingSwitch();", present);
    const teardown = runtime.indexOf("destroyGuest();", finish);
    const reboot = runtime.indexOf(
      "if (!bootGuest(nextApp, size()))",
      teardown,
    );
    const recover = runtime.indexOf(
      "recoverGuestFailure(nextApp);",
      reboot,
    );
    expect(runFrame).toBeGreaterThan(-1);
    expect(tick).toBeGreaterThan(runFrame);
    expect(present).toBeGreaterThan(tick);
    expect(finish).toBeGreaterThan(present);
    expect(teardown).toBeGreaterThan(finish);
    expect(reboot).toBeGreaterThan(teardown);
    expect(recover).toBeGreaterThan(reboot);
    expect(runtime).toContain(
      "apps_.size() <= 1 || appIndex == 0",
    );

    const shutdownExtension = runtime.indexOf(
      "extension_->shutdown(hasContext ? 1 : 0);",
    );
    const freeContext = runtime.indexOf("JS_FreeContext(context_);");
    const freeRuntime = runtime.indexOf("JS_FreeRuntime(runtime_);", freeContext);
    const shutdownCore = runtime.indexOf("ui_shutdown();", freeRuntime);
    const clearPack = runtime.indexOf("appPack_.clear();", shutdownCore);
    expect(shutdownExtension).toBeGreaterThan(-1);
    expect(freeContext).toBeGreaterThan(shutdownExtension);
    expect(freeContext).toBeGreaterThan(-1);
    expect(freeRuntime).toBeGreaterThan(freeContext);
    expect(shutdownCore).toBeGreaterThan(freeRuntime);
    expect(clearPack).toBeGreaterThan(shutdownCore);

    const launcher = readFileSync(
      join(repository, "apps/launcher/app.tsx"),
      "utf8",
    );
    expect(launcher).toContain(
      'import { BTN, touches } from "@pocketjs/framework/input"',
    );
    expect(launcher).toContain("const third = viewport().w / 3");
    expect(launcher).toContain("pressed.x < third");
    expect(launcher).toContain("pressed.x >= third * 2");
    expect(launcher).toContain("launchApp(app.output)");
    expect(launcher).not.toContain('debugName="LauncherCanvas"');
    expect(launcher).not.toContain("canvasStyle");
    expect(launcher).toContain(
      '<Image class="absolute inset-0 w-full h-full" src="covers/launcher-bg.png"',
    );
    expect(launcher).toContain("const cardLeft = () => viewport().w / 2 - 96");
    expect(launcher).toContain(
      "Math.max(24, Math.round((viewport().h - 76 - 218) / 2))",
    );
    expect(launcher).toContain(
      'class="absolute left-0 right-0 bottom-8 flex-col items-center gap-1"',
    );
    expect(launcher).toContain(
      'class="absolute left-0 right-0 bottom-2 text-center',
    );
  });
});
