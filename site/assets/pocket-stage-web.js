// Browser adapter for a Pocket Stage package. The native pocket-stage process
// owns the macOS/wgpu shell; this adapter deliberately reuses the package data
// and contracts while mapping them onto DOM input + demand-rendered WebGL.

import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { BTN, PocketHost } from "../playground/host.js";
import {
  POCKET_SECTION,
  decodePocketPackage,
  findSection,
  findVariant,
} from "../../contracts/spec/pocket-package.ts";

// Re-exported for the local/CI browser verifier (site/verify.ts): the
// app-switch protocol is testable headlessly through PocketHost alone,
// where WebGL (the 3D shell) may be unavailable, and the .pocket decode
// path is exercised with the same helpers the adapter uses.
export { BTN, PocketHost, POCKET_SECTION, decodePocketPackage, findSection, findVariant };

const STAGE_ROOT = "/stage/";
const FRONT_SNAP_RADIANS = THREE.MathUtils.degToRad(2);
const ORBIT_YAW_LIMIT = 0.85;
const ORBIT_PITCH_LIMIT = 0.5;

const BUTTON_BITS = {
  up: BTN.UP,
  right: BTN.RIGHT,
  down: BTN.DOWN,
  left: BTN.LEFT,
  l: BTN.LTRIGGER,
  r: BTN.RTRIGGER,
  triangle: BTN.TRIANGLE,
  circle: BTN.CIRCLE,
  cross: BTN.CROSS,
  square: BTN.SQUARE,
  select: BTN.SELECT,
  start: BTN.START,
};

function failResponse(response) {
  if (!response.ok) throw new Error(`${response.url}: HTTP ${response.status}`);
  return response;
}

function semantic(material, key) {
  return material?.userData?.[key];
}

function applyMonochrome(material) {
  if (semantic(material, "pocket3d_base_color_mode") !== "monochrome") return material;
  const copy = material.clone();
  copy.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "diffuseColor *= sampledDiffuseColor;",
      `diffuseColor *= sampledDiffuseColor;
       float pocketMonochrome = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
       diffuseColor.rgb = vec3(pocketMonochrome);`,
    );
  };
  copy.customProgramCacheKey = () => "pocket-stage-monochrome-v1";
  copy.needsUpdate = true;
  return copy;
}

function canonicalizeModel(rawScene, profile) {
  const degrees = profile.rotation_degrees ?? [0, 0, 0];
  rawScene.rotation.set(...degrees.map(THREE.MathUtils.degToRad));
  rawScene.updateMatrixWorld(true);
  if (profile.coordinate_system === "authored_mm") return rawScene;

  const oriented = new THREE.Box3().setFromObject(rawScene);
  const size = oriented.getSize(new THREE.Vector3());
  const center = oriented.getCenter(new THREE.Vector3());
  if (!(size.x > 0)) throw new Error("stage model has a degenerate canonical width");

  // Matches the native package transform: orient, center, then scale to the
  // profile's canonical millimetre width. Interaction proxies are already in
  // this resulting coordinate system.
  rawScene.position.copy(center).multiplyScalar(-1);
  const canonical = new THREE.Group();
  canonical.name = "pocket-stage-canonical-model";
  canonical.scale.setScalar(profile.target_width_mm / size.x);
  canonical.add(rawScene);
  canonical.updateMatrixWorld(true);
  return canonical;
}

function bindPackageMaterials(model, profile, screenTexture, auxiliaryTexture) {
  let screens = 0;
  let auxiliaryScreens = 0;
  const suppressedProfiles = profile.suppressed_materials ?? [];
  const suppressedCounts = new Map(suppressedProfiles.map((entry) => [entry, 0]));

  const configure = (material) => {
    const role = semantic(material, "pocket3d_role");
    if (auxiliaryTexture && role === "dynamic_screen_auxiliary") {
      auxiliaryScreens++;
      return new THREE.MeshBasicMaterial({ name: material.name, map: auxiliaryTexture, toneMapped: false });
    }
    const screenMatch = role === profile.screen.material_role ||
      material.name?.startsWith(profile.screen.material_name_prefix);
    if (screenMatch) {
      screens++;
      const screen = new THREE.MeshBasicMaterial({
        name: material.name,
        map: screenTexture,
        color: 0xffffff,
        side: THREE.DoubleSide,
        toneMapped: false,
        transparent: false,
        depthWrite: true,
      });
      screen.userData = { ...material.userData };
      return screen;
    }

    const suppressedMatch = suppressedProfiles.find((entry) =>
      role === entry.material_role || material.name?.startsWith(entry.material_name_prefix),
    );
    if (suppressedMatch) {
      suppressedCounts.set(suppressedMatch, suppressedCounts.get(suppressedMatch) + 1);
      return new THREE.MeshBasicMaterial({
        name: material.name,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        colorWrite: false,
      });
    }
    return applyMonochrome(material);
  };

  model.traverse((object) => {
    if (!object.isMesh) return;
    object.material = Array.isArray(object.material)
      ? object.material.map(configure)
      : configure(object.material);
  });

  if (screens !== profile.screen.expected_primitives) {
    throw new Error(`stage screen matched ${screens} primitives; expected ${profile.screen.expected_primitives}`);
  }
  if (auxiliaryTexture && auxiliaryScreens !== 1) throw new Error("stage requires one auxiliary screen");
  for (const entry of suppressedProfiles) {
    const matches = suppressedCounts.get(entry);
    if (matches !== entry.expected_primitives) {
      throw new Error(`stage suppressed material matched ${matches} primitives; expected ${entry.expected_primitives}`);
    }
  }
}

function buildPickProxies(profile) {
  const group = new THREE.Group();
  group.name = "pocket-stage-interaction-proxies";
  for (const part of profile.parts ?? []) {
    if (!part.button && !part.touch_surface && part.name !== "screen" && part.name !== "nub") continue;
    const [hx, hy, hz] = part.half_extents_mm;
    const geometry = part.touch_surface
      ? new THREE.PlaneGeometry(hx * 2, hy * 2)
      : new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    // Layer 2 is raycast-only: the camera never draws these proxy boxes.
    const proxy = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    proxy.layers.set(2);
    proxy.position.fromArray(part.center_mm);
    proxy.userData.stagePart = part;
    group.add(proxy);
  }
  return group;
}

function pose(camera, controls) {
  return {
    position: camera.position.clone(),
    target: controls.target.clone(),
  };
}

function easeInOut(t) {
  return t * t * (3 - 2 * t);
}

/**
 * Mount the authored PSP model around a PocketHost framebuffer.
 *
 * The homepage owns its launcher host, while the Playground supplies the host
 * that already owns the live-compiled app. Keeping both paths here means the
 * GLB, screen material, camera, and authored button hit regions stay identical.
 */
export async function mountPocketStage(root, options = {}) {
  const viewport = root.querySelector("[data-stage-viewport]");
  const canvas = root.querySelector("[data-stage-canvas]");
  const screenCanvas = root.querySelector("[data-stage-screen]");
  const status = root.querySelector("[data-stage-status]");
  if (!viewport || !canvas || !screenCanvas || !status) return;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
      premultipliedAlpha: true,
    });
  } catch (error) {
    root.classList.add("has-error");
    status.textContent = options.errorText ?? "Interactive 3D is unavailable in this browser.";
    console.error("Pocket Stage WebGL startup failed", error);
    return;
  }

  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;

  const scene = new THREE.Scene();
  // Placeholder framing until the package's authored view block loads; the
  // scene stays empty until then, so nothing renders from this pose.
  const camera = new THREE.PerspectiveCamera(30, 1, 1, 2000);
  camera.position.set(0, 46, 190);
  let focusDistanceMm = 98;
  let fitAspect = 0;
  scene.add(new THREE.HemisphereLight(0xe8f1ff, 0x151922, 2.4));
  const key = new THREE.DirectionalLight(0xffffff, 3.2);
  key.position.set(-90, 120, 180);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x8cc8ff, 1.1);
  rim.position.set(130, 20, -80);
  scene.add(rim);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 0, 0);
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.enableDamping = false;
  controls.rotateSpeed = 0.55;
  controls.minAzimuthAngle = -ORBIT_YAW_LIMIT;
  controls.maxAzimuthAngle = ORBIT_YAW_LIMIT;
  controls.minPolarAngle = Math.PI / 2 - ORBIT_PITCH_LIMIT;
  controls.maxPolarAngle = Math.PI / 2 + ORBIT_PITCH_LIMIT;
  controls.update();

  let host = null;
  let screenTexture = null;
  let auxiliaryTexture = null;
  let hinge = null;
  let lidAngle = 155;
  let hingeRaf = 0;
  let yawLimit = ORBIT_YAW_LIMIT;
  let pitchLimit = ORBIT_PITCH_LIMIT;
  let proxyGroup = null;
  let inViewport = true;
  let renderRaf = 0;
  let cameraRaf = 0;
  let renderCount = 0;
  let focused = false;
  let savedDeskPose = null;
  let pressed = null;
  let lastPressedPart = null;
  let cancelRelease = null;
  let wheelSnapTimer = 0;
  let ready = false;
  let screenUploads = 0;
  const suppliedHost = options.host ?? null;

  const renderNow = () => {
    renderRaf = 0;
    if (!inViewport || document.hidden) return;
    renderer.render(scene, camera);
    renderCount++;
    root.dataset.stageFrames = String(renderCount);
    if (host) {
      root.dataset.guestTicks = String(host.tickCount);
      root.dataset.screenFrames = String(host.blitCount);
    }
  };

  const invalidate = () => {
    if (!inViewport || document.hidden || renderRaf) return;
    renderRaf = requestAnimationFrame(renderNow);
  };

  const refreshScreen = () => {
    if (!screenTexture) return;
    screenTexture.needsUpdate = true;
    if (auxiliaryTexture) auxiliaryTexture.needsUpdate = true;
    screenUploads++;
    invalidate();
  };

  const resize = () => {
    const width = Math.max(1, viewport.clientWidth);
    const height = Math.max(1, viewport.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.zoom = fitAspect ? Math.min(1, camera.aspect / fitAspect) : 1;
    camera.updateProjectionMatrix();
    invalidate();
  };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(viewport);
  resize();

  const raycaster = new THREE.Raycaster();
  raycaster.layers.set(2);
  const pointer = new THREE.Vector2();
  const pick = (event) => {
    if (!proxyGroup) return null;
    const rect = canvas.getBoundingClientRect();
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    if ((hinge && lidAngle < 60) || raycaster.ray.direction.z >= 0) return null;
    const hit = raycaster.intersectObjects(proxyGroup.children, false)[0];
    return hit ? { ...hit.object.userData.stagePart, uv: hit.uv } : null;
  };

  const tweenPose = (destination, duration = 360) => {
    if (cameraRaf) cancelAnimationFrame(cameraRaf);
    const source = pose(camera, controls);
    const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    const span = reduced ? 0 : duration;
    controls.enabled = false;
    const step = (now) => {
      const t = span === 0 ? 1 : Math.min(1, (now - start) / span);
      const eased = easeInOut(t);
      camera.position.lerpVectors(source.position, destination.position, eased);
      controls.target.lerpVectors(source.target, destination.target, eased);
      camera.lookAt(controls.target);
      renderNow();
      if (t < 1 && inViewport && !document.hidden) {
        cameraRaf = requestAnimationFrame(step);
      } else {
        cameraRaf = 0;
        controls.enabled = !focused;
        controls.update();
      }
    };
    cameraRaf = requestAnimationFrame(step);
  };

  const snapFrontIfClose = () => {
    if (focused) return;
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    const pitch = spherical.phi - Math.PI / 2;
    if (Math.hypot(spherical.theta, pitch) > FRONT_SNAP_RADIANS) return;
    tweenPose({
      position: controls.target.clone().add(new THREE.Vector3(0, 0, spherical.radius)),
      target: controls.target.clone(),
    }, 180);
  };

  controls.addEventListener("change", invalidate);
  controls.addEventListener("end", snapFrontIfClose);

  // macOS trackpads deliver precise two-axis wheel deltas. Reserve that gesture
  // for a horizontal turn, but let ordinary vertical scrolling and browser
  // pinch-to-zoom pass through so the large hero never traps the page.
  canvas.addEventListener("wheel", (event) => {
    if (!ready || focused || event.ctrlKey) return;
    const horizontalOrbit = Math.abs(event.deltaX) > Math.abs(event.deltaY) * 1.15;
    const modifiedOrbit = event.altKey;
    if (!horizontalOrbit && !modifiedOrbit) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const offset = camera.position.clone().sub(controls.target);
    const spherical = new THREE.Spherical().setFromVector3(offset);
    spherical.theta = THREE.MathUtils.clamp(
      spherical.theta + event.deltaX * 0.0024,
      -yawLimit,
      yawLimit,
    );
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi + (modifiedOrbit ? event.deltaY : 0) * 0.0024,
      Math.PI / 2 - pitchLimit,
      Math.PI / 2 + pitchLimit,
    );
    camera.position.copy(controls.target).add(new THREE.Vector3().setFromSpherical(spherical));
    camera.lookAt(controls.target);
    controls.update();
    invalidate();
    window.clearTimeout(wheelSnapTimer);
    wheelSnapTimer = window.setTimeout(snapFrontIfClose, 120);
  }, { passive: false, capture: true });

  const releaseButton = () => {
    if (!pressed || !host) return;
    cancelRelease?.();
    cancelRelease = null;
    const active = pressed;
    pressed = null;
    if (active.touch) host.touch(active.part.touch_surface, null);
    else host.press(active.bit, false);
    root.dataset.pressedPart = "";
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (!ready || pressed || event.button !== 0) return;
    const part = pick(event);
    const bit = BUTTON_BITS[part?.button];
    if (!bit && !part?.touch_surface) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    pressed = { bit, touch: !!part.touch_surface, part, pointerId: event.pointerId, tickAtPress: host.tickCount };
    lastPressedPart = part.name;
    root.dataset.pressedPart = part.name;
    canvas.setPointerCapture(event.pointerId);
    if (pressed.touch) {
      const [w,h] = part.logical_size;
      host.touch(part.touch_surface, [part.uv.x * w, (1-part.uv.y) * h]);
    } else host.press(bit, true);
  }, true);

  const finishPointer = (event) => {
    if (!pressed || pressed.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    // Wall-clock delays can fire before a throttled rAF. Hold the bit until
    // the guest has demonstrably consumed at least one fixed-timestep turn.
    if (host.tickCount > pressed.tickAtPress) releaseButton();
    else if (!cancelRelease) cancelRelease = host.afterNextTick(releaseButton);
  };
  canvas.addEventListener("pointerup", finishPointer, true);
  canvas.addEventListener("pointercancel", finishPointer, true);
  window.addEventListener("blur", releaseButton);

  canvas.addEventListener("pointermove", (event) => {
    if (!ready) return;
    if (pressed?.touch) {
      const part = pick(event);
      if (part?.touch_surface === pressed.part.touch_surface) {
        const [w,h] = part.logical_size;
        host.touch(part.touch_surface, [part.uv.x * w, (1-part.uv.y) * h]);
      }
      return;
    }
    if (pressed) return;
    const part = pick(event);
    canvas.style.cursor = part?.button || part?.touch_surface || part?.name === "screen" ? "pointer" : "grab";
  });

  canvas.addEventListener("dblclick", (event) => {
    if (!ready || pick(event)?.name !== "screen") return;
    event.preventDefault();
    if (!focused) {
      savedDeskPose = pose(camera, controls);
      focused = true;
      root.dataset.focused = "true";
      const screenPart = proxyGroup.children.find((child) => child.userData.stagePart.name === "screen")
        ?.userData.stagePart;
      const target = new THREE.Vector3().fromArray(screenPart.center_mm);
      tweenPose({ position: target.clone().add(new THREE.Vector3(0, 0, focusDistanceMm)), target });
    } else if (savedDeskPose) {
      focused = false;
      root.dataset.focused = "false";
      tweenPose(savedDeskPose);
    }
  });

  const setVisible = (visible) => {
    inViewport = visible;
    if (!visible || document.hidden) {
      releaseButton();
      // A supplied host belongs to the Playground compiler lifecycle. The
      // shell may pause its own WebGL work, but it must not stop an app that
      // has just been reset or started outside this adapter.
      if (!suppliedHost) host?.stop();
      if (renderRaf) cancelAnimationFrame(renderRaf);
      renderRaf = 0;
      if (cameraRaf) cancelAnimationFrame(cameraRaf);
      cameraRaf = 0;
      controls.enabled = !focused;
      return;
    }
    if (!suppliedHost) host?.wake();
    invalidate();
  };

  const visibilityObserver = new IntersectionObserver(
    ([entry]) => setVisible(entry.isIntersecting),
    { threshold: 0.05 },
  );
  visibilityObserver.observe(root);
  document.addEventListener("visibilitychange", () => setVisible(inViewport));

  try {
    const stageHost = suppliedHost ?? new PocketHost();
    host = stageHost;
    if (suppliedHost) {
      const onSuppliedHostError = stageHost.onError;
      stageHost.onError = (error) => {
        releaseButton();
        onSuppliedHostError(error);
      };
    }
    const hostReady = suppliedHost
      ? Promise.resolve(stageHost)
      : stageHost.mount(screenCanvas, {
          wasmUrl: "/pg/pocketjs.wasm",
          keyboardTarget: canvas,
          showHud: false,
          idleAfterMs: 1200,
          onBlit: refreshScreen,
          onError: (error) => {
            releaseButton();
            root.classList.add("has-error");
            status.textContent = "The Pocket app stopped unexpectedly.";
            console.error("Pocket Stage guest failed", error);
          },
        });

    const profileUrl = options.profileUrl ?? STAGE_ROOT + "psp-profile.json";
    const profileResponse = await fetch(profileUrl).then(failResponse);
    const profile = await profileResponse.json();
    const modelUrl = new URL(profile.lods.orbit, new URL(profileUrl, location.href)).pathname;
    // The package's view block is the same camera authority the native
    // pocket-stage runtime reads; the adapter carries no model facts.
    const view = profile.view ?? {};
    fitAspect = view.fit_aspect ?? 0;
    if (profile.coordinate_system === "authored_mm") {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const room = new RoomEnvironment();
      scene.environment = pmrem.fromScene(room, .04).texture;
      scene.environmentIntensity = .35;
      room.dispose();
      pmrem.dispose();
    }
    if (view.full_orbit) {
      yawLimit = Infinity;
      pitchLimit = Math.PI / 2 - .02;
      controls.minAzimuthAngle = -Infinity;
      controls.maxAzimuthAngle = Infinity;
      controls.minPolarAngle = .02;
      controls.maxPolarAngle = Math.PI - .02;
    }
    camera.fov = view.fov_y_degrees ?? camera.fov;
    camera.updateProjectionMatrix();
    camera.position.fromArray(options.deskPositionMm ?? view.desk_position_mm ?? [0, 0, 190]);
    controls.target.fromArray(view.desk_target_mm ?? [0, 0, 0]);
    resize();
    controls.update();
    focusDistanceMm = view.focus_distance_mm ?? focusDistanceMm;
    const loader = new GLTFLoader();
    let model;
    let registry = null;
    let fetchBundle = null;
    let launcherBundle = null;
    if (suppliedHost) {
      [model] = await Promise.all([
        loader.loadAsync(modelUrl),
        hostReady,
      ]);
    } else {
      // Without a supplied host the stage boots a package of its own: the
      // Pocket Launcher deck (docs/LAUNCHER.md) by default, or whatever
      // options.bootApp names, which is how the homepage boots one app
      // directly. The Playground skips this branch because its supplied host
      // already owns the live-compiled app.
      const bundleCache = new Map();
      fetchBundle = async (output) => {
        if (!bundleCache.has(output)) {
          bundleCache.set(
            output,
            fetch(STAGE_ROOT + "apps/" + output + ".pocket")
              .then(failResponse)
              .then((r) => r.arrayBuffer())
              .then((buffer) => {
                const pkg = decodePocketPackage(new Uint8Array(buffer));
                const variant = findVariant(pkg, "psp");
                if (!variant) throw new Error(output + ".pocket has no psp variant");
                const js = findSection(variant, POCKET_SECTION.js);
                const pak = findSection(variant, POCKET_SECTION.pak) ?? new Uint8Array(0);
                // The js section carries its QuickJS NUL — strip it for eval-
                // by-source; copy the pak out of the shared package buffer.
                return {
                  js: new TextDecoder().decode(js.subarray(0, js.length - 1)),
                  pak: pak.slice().buffer,
                };
              }),
          );
        }
        return bundleCache.get(output);
      };
      const [loadedModel, registryResponse, loadedLauncher] = await Promise.all([
        loader.loadAsync(modelUrl),
        fetch(STAGE_ROOT + "apps/apps.json").then(failResponse),
        fetchBundle(options.bootApp ?? "launcher-main"),
        hostReady,
      ]);
      model = loadedModel;
      registry = await registryResponse.json();
      launcherBundle = loadedLauncher;
      stageHost.enableAppSwitching({
        launcher: "launcher-main",
        apps: registry.apps,
        fetchBundle,
        onSwitch: () => invalidate(),
      });
    }

    screenTexture = new THREE.CanvasTexture(screenCanvas);
    screenTexture.colorSpace = THREE.SRGBColorSpace;
    screenTexture.flipY = false;
    screenTexture.generateMipmaps = false;
    screenTexture.minFilter = THREE.LinearFilter;
    screenTexture.magFilter = THREE.LinearFilter;
    const auxiliaryCanvas = root.querySelector("[data-stage-auxiliary]");
    if (auxiliaryCanvas) {
      auxiliaryTexture = new THREE.CanvasTexture(auxiliaryCanvas);
      auxiliaryTexture.colorSpace = THREE.SRGBColorSpace;
      auxiliaryTexture.flipY = false;
      auxiliaryTexture.generateMipmaps = false;
      auxiliaryTexture.minFilter = THREE.LinearFilter;
    }

    const canonical = canonicalizeModel(model.scene, profile);
    bindPackageMaterials(canonical, profile, screenTexture, auxiliaryTexture);
    hinge = profile.hinge ? canonical.getObjectByName(profile.hinge.node) : null;
    if (profile.hinge && !hinge) throw new Error("stage hinge node is missing");
    lidAngle = profile.hinge?.default_angle_degrees ?? lidAngle;
    if (hinge) hinge.rotation.x = THREE.MathUtils.degToRad(180 - lidAngle);
    scene.add(canonical);
    proxyGroup = buildPickProxies(profile);
    scene.add(proxyGroup);

    if (launcherBundle) {
      const { js: appSource, pak } = launcherBundle;
      stageHost.runIIFE(appSource, pak);
    }
    refreshScreen();
    ready = true;
    root.dataset.ready = "true";
    root.classList.add("is-ready");
    status.textContent = options.readyText ?? "Pocket Stage ready";
    if ((!inViewport || document.hidden) && !suppliedHost) stageHost.stop();
    invalidate();

    // Warm the deck's apps once the hero is up: sequential, idle-priority —
    // a launch then swaps instantly instead of showing a fetch hold.
    if (registry && fetchBundle) {
      const prefetch = async () => {
        for (const app of registry.apps) {
          try {
            await fetchBundle(app.output);
          } catch {
            // offline or trimmed deploy — the launch path will surface it
          }
        }
      };
      ("requestIdleCallback" in window ? requestIdleCallback : setTimeout)(prefetch);
    }

    // Exposed only as a receipt for the local/CI browser verifier.
    const receiptName = options.receiptName ?? "__pocketStageReceipt";
    globalThis[receiptName] = () => ({
      ready,
      stageFrames: renderCount,
      guestTicks: stageHost.tickCount,
      screenFrames: stageHost.blitCount,
      screenUploads,
      screenCanvasId: screenCanvas.id || null,
      profileUrl,
      modelUrl,
      focused,
      pressedPart: root.dataset.pressedPart || null,
      lastPressedPart,
      lidAngle: hinge ? lidAngle : null,
    });
    const setLidAngle = (degrees, animate = true) => {
      if (!hinge) return;
      cancelAnimationFrame(hingeRaf);
      releaseButton();
      const from = lidAngle;
      const to = THREE.MathUtils.clamp(degrees, profile.hinge.min_angle_degrees, profile.hinge.max_angle_degrees);
      const start = performance.now();
      const duration = animate && !matchMedia("(prefers-reduced-motion: reduce)").matches ? 650 : 0;
      const step = (now) => {
        const t = duration ? Math.min(1, (now-start)/duration) : 1;
        lidAngle = THREE.MathUtils.lerp(from, to, easeInOut(t));
        hinge.rotation.x = THREE.MathUtils.degToRad(180-lidAngle);
        root.dataset.lidAngle = String(Math.round(lidAngle));
        invalidate();
        if (t < 1) hingeRaf = requestAnimationFrame(step);
        else hingeRaf = 0;
      };
      step(start);
    };
    const setView = (name) => {
      releaseButton();
      focused = false;
      savedDeskPose = null;
      root.dataset.focused = "false";
      const target = new THREE.Vector3().fromArray(view.desk_target_mm ?? [0,0,0]);
      const offset = name === "rear" ? [0,35,-view.distance_mm] : name === "detail"
        ? [view.distance_mm*.35,-view.distance_mm*.4,view.distance_mm*.8]
        : view.desk_position_mm.map((v,i) => v-target.getComponent(i));
      tweenPose({ target, position: target.clone().add(new THREE.Vector3(...offset)) });
    };
    return { refreshScreen, releaseInput: releaseButton, setLidAngle, setView };
  } catch (error) {
    root.classList.add("has-error");
    status.textContent = options.errorText ?? "Pocket Stage could not be loaded.";
    console.error("Pocket Stage load failed", error);
  }
}
