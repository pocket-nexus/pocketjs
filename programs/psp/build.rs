//! Embeds the compiled application package(s) into the EBOOT at build time,
//! and the program's exported profile (`POCKETJS_PROFILE_RS`, see
//! engine/profile-build) as `$OUT_DIR/pocket_profile.rs`.
//!
//! The stock backend sets `POCKETJS_APP_OUTPUT`, `POCKETJS_EMBED_APP=1` and
//! `POCKETJS_EMBED_PACKAGE=<absolute .pocket path>`; the package bytes are
//! embedded verbatim. Custom native hosts consume the same output name but
//! leave embedding to their own primary crate, so this runtime remains a
//! reusable dependency. `POCKETJS_APP=<name>` remains a legacy shorthand that
//! implies embedding. Without embedding the table entry is empty and the EBOOT
//! reports that it carries no application.
//!
//! Multi-app mode (docs/LAUNCHER.md): `POCKETJS_LAUNCHER_REGISTRY=<path to the
//! launcher-registry.tsv tools/launcher.ts emits>` embeds app 0 = the
//! selected app (the launcher) PLUS one entry per registry line. Every mode
//! generates $OUT_DIR/apps.rs — a single-app build is simply a table of one,
//! so main.rs has exactly one shape to consume.

use std::path::{Path, PathBuf};
use std::{env, fs};

#[path = "../../tools/build/embedded-apps.rs"]
mod embed;

fn dimension(name: &str, fallback: u32) -> u32 {
    env::var(name)
        .unwrap_or_else(|_| fallback.to_string())
        .parse()
        .unwrap_or_else(|_| panic!("{name} must be a positive integer"))
}

fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Required);
    for name in [
        "POCKET_QJS_SOURCE",
        "POCKET_PSP_CC",
        "POCKET_PSP_AR",
        "PSP_SDK",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let quickjs =
        PathBuf::from(env::var_os("POCKET_QJS_SOURCE").expect(
            "POCKET_QJS_SOURCE must name the pinned libquickjs-sys embed/quickjs directory",
        ));
    let sdk = PathBuf::from(env::var_os("PSP_SDK").expect("PSP_SDK"));
    let compiler = env::var("POCKET_PSP_CC").expect("POCKET_PSP_CC");
    let mut bridge = cc::Build::new();
    bridge
        .compiler(&compiler)
        .archiver(env::var("POCKET_PSP_AR").expect("POCKET_PSP_AR"))
        .no_default_flags(true)
        .include("../../engine/guest-quickjs/include")
        .include("../../contracts/generated")
        .include(&quickjs)
        .include(sdk.join("psp/include"))
        .define("POCKET_QJS_BELLARD", None)
        .define("__PSP__", None)
        .flag("-std=gnu11")
        .flag("-O2")
        .flag("-funsigned-char")
        .flag("-Wno-unused-parameter")
        .flag("-march=mips2")
        .flag("-mno-abicalls")
        .flag("-fno-pic")
        .flag("-G0")
        .flag("-ffunction-sections")
        .flag("-fdata-sections");
    assert!(
        compiler.contains("clang"),
        "PSP guest bridge requires Clang"
    );
    bridge
        .flag("--no-default-config")
        .flag("--target=mipsel-sony-psp")
        .flag("-mabi=o32")
        .flag("-mhard-float")
        .flag("-mfp32");
    // Emit single-precision Allegrex instructions, then assemble with the O32
    // FP32 attribute used by the pinned Rust/QuickJS objects. Clang 23 marks a
    // direct -msingle-float object differently from those older LLVM builds.
    // This guest boundary passes integer/pointer/record values only: reals live
    // in PocketOpArg/PocketResult memory, never in by-value f64 C parameters.
    // Validate the assembly before assigning that existing archive attribute.
    let assembly = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("quickjs_bridge.s");
    let status = bridge
        .get_compiler()
        .to_command()
        .arg("-msingle-float")
        .arg("-S")
        .arg("src/quickjs_bridge.c")
        .arg("-o")
        .arg(&assembly)
        .status()
        .expect("compile PSP guest assembly");
    assert!(status.success(), "PSP guest assembly compilation failed");
    for line in fs::read_to_string(&assembly).unwrap().lines() {
        let instruction = line.trim().split_whitespace().next().unwrap_or("");
        assert!(
            !matches!(instruction, "ldc1" | "sdc1")
                && !instruction.split('.').skip(1).any(|part| part == "d"),
            "PSP guest contains a double-precision FPU instruction: {line}"
        );
    }
    cc::Build::new()
        .compiler(&compiler)
        .archiver(env::var("POCKET_PSP_AR").expect("POCKET_PSP_AR"))
        .no_default_flags(true)
        .flag("--no-default-config")
        .flag("--target=mipsel-sony-psp")
        .flag("-march=mips2")
        .flag("-mabi=o32")
        .flag("-mhard-float")
        .flag("-mfp32")
        .flag("-mno-abicalls")
        .flag("-fno-pic")
        .flag("-G0")
        .file(assembly)
        .compile("pocket_psp_guest");
    for source in [
        "src/quickjs_bridge.c",
        "../../engine/guest-quickjs/src/guest.c",
        "../../engine/guest-quickjs/src/generated_ops.h",
        "../../engine/guest-quickjs/include/pocket_guest_quickjs.h",
        "../../contracts/generated/pocket_runtime.h",
        "../../contracts/generated/pocket_drivers.h",
        "../../contracts/generated/pocket_spec.h",
    ] {
        println!("cargo:rerun-if-changed={source}");
    }
    println!(
        "cargo:rerun-if-changed={}",
        quickjs.join("quickjs.h").display()
    );

    println!("cargo:rerun-if-env-changed=POCKETJS_OFFLOAD_SLOT");
    let slot = env::var("POCKETJS_OFFLOAD_SLOT").unwrap_or_default();
    assert!(
        slot.is_empty() || (slot.len() == 16 && slot.bytes().all(|b| b.is_ascii_hexdigit())),
        "invalid offload slot"
    );
    println!("cargo:rustc-env=POCKETJS_OFFLOAD_SLOT={slot}");
    let legacy_app = env::var("POCKETJS_APP").unwrap_or_default();
    let app = env::var("POCKETJS_APP_OUTPUT").unwrap_or_else(|_| legacy_app.clone());
    let embed_app = match env::var("POCKETJS_EMBED_APP") {
        Ok(value) => match value.as_str() {
            "0" => false,
            "1" => true,
            _ => panic!("POCKETJS_EMBED_APP must be 0 or 1, got {value:?}"),
        },
        Err(_) => !legacy_app.is_empty(),
    };
    assert!(
        !embed_app || !app.is_empty(),
        "POCKETJS_EMBED_APP=1 requires POCKETJS_APP_OUTPUT"
    );
    // The generic runtime (feature `runtime`) carries no game: it reads
    // app.pocket beside the EBOOT at boot (src/package_file.rs).
    if env::var_os("CARGO_FEATURE_RUNTIME").is_some() {
        assert!(
            !embed_app,
            "the runtime feature builds an EBOOT without an app: set POCKETJS_EMBED_APP=0"
        );
        assert!(
            env::var("POCKETJS_LAUNCHER_REGISTRY")
                .unwrap_or_default()
                .is_empty(),
            "the runtime feature cannot embed a launcher registry"
        );
    }
    let target = env::var("POCKETJS_TARGET").unwrap_or_else(|_| "psp".into());
    let host_abi = env::var("POCKETJS_HOST_ABI")
        .unwrap_or_else(|_| pocket_spec::BINDING_GENERATION.to_string());
    assert_eq!(
        host_abi.parse::<u32>().ok(),
        Some(pocket_spec::BINDING_GENERATION),
        "POCKETJS_HOST_ABI must match this build's binding generation"
    );
    let logical = (
        dimension("POCKETJS_LOGICAL_WIDTH", 480),
        dimension("POCKETJS_LOGICAL_HEIGHT", 272),
    );
    let physical = (
        dimension("POCKETJS_PHYSICAL_WIDTH", 480),
        dimension("POCKETJS_PHYSICAL_HEIGHT", 272),
    );
    let presentation = env::var("POCKETJS_PRESENTATION").unwrap_or_else(|_| "native".into());
    let raster_density = dimension("POCKETJS_RASTER_DENSITY", 1);
    assert!(
        target == "psp"
            || (env::var_os("CARGO_FEATURE_RUNTIME").is_some() && target == "psp-runtime"),
        "pocketjs-psp requires psp or the psp-runtime program profile"
    );
    assert_eq!(logical, (480, 272), "PSP logical viewport must be 480x272");
    assert_eq!(
        physical,
        (480, 272),
        "PSP physical viewport must be 480x272"
    );
    assert!(
        matches!(presentation.as_str(), "native" | "integer-fit"),
        "PSP presentation must be native or integer-fit"
    );
    assert_eq!(raster_density, 1, "PSP raster density must be 1");
    let dist = env::var_os("POCKETJS_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../../dist"));
    let out_dir = env::var("OUT_DIR").unwrap();

    let package = env::var_os("POCKETJS_EMBED_PACKAGE")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let registry = env::var_os("POCKETJS_LAUNCHER_REGISTRY")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    // The runtime admits compiled packages only; a raw JS/pak bundle has no
    // plan, identity or profile hash to admit.
    assert!(
        !embed_app || package.is_some() || registry.is_some(),
        "POCKETJS_EMBED_APP=1 requires POCKETJS_EMBED_PACKAGE: embed a compiled .pocket"
    );
    let packages = env::var_os("POCKETJS_LAUNCHER_PACKAGES")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let generated = embed::generate(embed::Config {
        identity: embed::Identity::PackageTable,
        output: &app,
        enabled: embed_app,
        dist: &dist,
        out: Path::new(&out_dir),
        package: package.as_deref(),
        registry: registry.as_deref(),
        packages: packages.as_deref(),
    })
    .unwrap_or_else(|error| panic!("PSP embed: {error}"));
    println!("cargo:rustc-env=POCKETJS_BUNDLE_HASH={}", generated.hash);
    for path in generated.inputs {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-changed=../../tools/build/embedded-apps.rs");

    // Switch-veil logo (docs/PLATFORM.md): 128×128 RGBA baked by tools/psp.ts.
    // Empty fallback keeps custom-host builds (no backend env) linking; the
    // veil skips the mark when the blob is not exactly 128*128*4 bytes.
    let veil = env::var("POCKETJS_VEIL_LOGO")
        .ok()
        .filter(|p| !p.is_empty())
        .map(|p| {
            println!("cargo:rerun-if-changed={p}");
            fs::read(&p).unwrap_or_default()
        })
        .unwrap_or_default();
    fs::write(Path::new(&out_dir).join("veil.raw"), veil).unwrap();
    println!("cargo:rerun-if-env-changed=POCKETJS_VEIL_LOGO");

    // Scripted input for deterministic capture builds (tests/e2e/ppsspp.ts):
    // "frame:mask,frame:mask" baked into the EBOOT, consumed by main.rs only
    // under --features capture (same pattern as dreamcart runtime/build.rs
    // PSPJS_CAPTURE_INPUT).
    let capture_input = env::var("POCKETJS_CAPTURE_INPUT").unwrap_or_default();
    // Optional real-hardware boot trace. tools/hw.ts serves the build dir as
    // host0:, so main.rs can append trace lines to host0:/PocketJS-trace.txt.
    let trace = env::var("POCKETJS_TRACE").unwrap_or_default();
    // Per-demo capture window (frames dumped = cap_start..cap_start+cap_n);
    // empty -> main.rs defaults (16/32).
    let cap_start = env::var("POCKETJS_CAP_START").unwrap_or_default();
    let cap_n = env::var("POCKETJS_CAP_N").unwrap_or_default();
    // Optional bench-only knobs. POCKETJS_ARENA_BYTES caps the single arena so
    // tools/bench-ppsspp.ts can scan minimum viable heap sizes; empty keeps
    // the production "free memory minus margin" behavior. Bench runs can also
    // skip raw frame dumps while still using the capture window to exit.
    let arena_bytes = env::var("POCKETJS_ARENA_BYTES").unwrap_or_default();
    let bench_dump_frames = env::var("POCKETJS_BENCH_DUMP_FRAMES").unwrap_or_default();

    println!("cargo:rustc-env=POCKETJS_APP={app}");
    println!("cargo:rustc-env=POCKETJS_TARGET={target}");
    println!("cargo:rustc-env=POCKETJS_HOST_ABI={host_abi}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_INPUT={capture_input}");
    println!("cargo:rustc-env=POCKETJS_TRACE={trace}");
    println!("cargo:rustc-env=POCKETJS_CAP_START={cap_start}");
    println!("cargo:rustc-env=POCKETJS_CAP_N={cap_n}");
    println!("cargo:rustc-env=POCKETJS_ARENA_BYTES={arena_bytes}");
    println!("cargo:rustc-env=POCKETJS_BENCH_DUMP_FRAMES={bench_dump_frames}");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP_OUTPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_EMBED_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_EMBED_PACKAGE");
    println!("cargo:rerun-if-env-changed=POCKETJS_LAUNCHER_PACKAGES");
    println!("cargo:rerun-if-env-changed=POCKETJS_LAUNCHER_REGISTRY");
    println!("cargo:rerun-if-env-changed=POCKETJS_OUTPUT_DIR");
    println!("cargo:rerun-if-env-changed=POCKETJS_TARGET");
    println!("cargo:rerun-if-env-changed=POCKETJS_HOST_ABI");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_PRESENTATION");
    println!("cargo:rerun-if-env-changed=POCKETJS_RASTER_DENSITY");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_INPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_TRACE");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAP_START");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAP_N");
    println!("cargo:rerun-if-env-changed=POCKETJS_ARENA_BYTES");
    println!("cargo:rerun-if-env-changed=POCKETJS_BENCH_DUMP_FRAMES");
    if let Ok(entries) = fs::read_dir(&dist) {
        for e in entries.flatten() {
            println!("cargo:rerun-if-changed={}", e.path().display());
        }
    }
}
