//! Embeds the built app bundle(s) + asset pack(s) into the EBOOT at build
//! time. Pattern copied from the dreamcart runtime (runtime/build.rs, the
//! PSPJS_GAME pattern), with app selection separated from embed ownership.
//!
//! The stock backend sets `POCKETJS_APP_OUTPUT` and `POCKETJS_EMBED_APP=1`.
//! Custom native hosts consume the same output name but leave embedding to
//! their own primary crate, so this runtime remains a reusable dependency.
//! `POCKETJS_APP=<name>` remains a legacy shorthand that implies embedding.
//!
//! Both embeds have EMPTY fallbacks so include_str!/include_bytes! in main.rs
//! always resolve — an EBOOT built with no app boots to the JS-error screen
//! rather than failing the build.
//!
//! Multi-app mode (docs/LAUNCHER.md): `POCKETJS_LAUNCHER_REGISTRY=<path to the
//! launcher-registry.tsv tools/launcher.ts emits>` embeds app 0 = the
//! selected app (the launcher) PLUS one entry per registry line. Every mode
//! generates $OUT_DIR/apps.rs — a single-app build is simply a table of one,
//! so main.rs has exactly one shape to consume.

use std::path::{Path, PathBuf};
use std::{env, fs};

fn dimension(name: &str, fallback: u32) -> u32 {
    env::var(name)
        .unwrap_or_else(|_| fallback.to_string())
        .parse()
        .unwrap_or_else(|_| panic!("{name} must be a positive integer"))
}

fn main() {
    println!("cargo:rerun-if-env-changed=POCKETJS_OFFLOAD_SLOT");
    let slot = env::var("POCKETJS_OFFLOAD_SLOT").unwrap_or_default();
    assert!(slot.is_empty() || (slot.len() == 16 && slot.bytes().all(|b| b.is_ascii_hexdigit())), "invalid offload slot");
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
    let target = env::var("POCKETJS_TARGET").unwrap_or_else(|_| "psp".into());
    let host_abi = env::var("POCKETJS_HOST_ABI").unwrap_or_else(|_| "1".into());
    // Fail HERE, not at boot: a garbage value would otherwise parse to 0 in
    // ffi.rs and brick every manifest bundle with an ABI-mismatch at mount.
    assert!(
        host_abi.parse::<i32>().map(|abi| abi > 0).unwrap_or(false),
        "POCKETJS_HOST_ABI must be a positive integer (got {host_abi:?})"
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
    assert_eq!(target, "psp", "pocketjs-psp requires target psp");
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

    // The embedded app table. Entry 0 is the selected app; multi-app builds
    // (POCKETJS_LAUNCHER_REGISTRY) append one entry per registry line.
    struct Embed {
        output: String,
        id: String,
        title: String,
        js: String, // NUL-terminated on write; hashed before the NUL
        pak: Vec<u8>,
    }

    let read_bundle = |output: &str| -> (String, Vec<u8>) {
        let js_path = dist.join(format!("{output}.js"));
        let pak_path = dist.join(format!("{output}.pak"));
        // Without this, cargo re-runs the script only on env changes — a
        // JS-only rebuild would ship the PREVIOUS bundle inside a freshly
        // linked PRX (observed on hardware; maddening to diagnose).
        println!("cargo:rerun-if-changed={}", js_path.display());
        println!("cargo:rerun-if-changed={}", pak_path.display());
        let js = fs::read_to_string(&js_path).unwrap_or_else(|e| {
            panic!(
                "could not read {} (compile the resolved plan first): {e}",
                js_path.display()
            )
        });
        (js, fs::read(&pak_path).unwrap_or_default())
    };

    let mut embeds: Vec<Embed> = Vec::new();
    if embed_app {
        let (js, pak) = read_bundle(&app);
        embeds.push(Embed {
            output: app.clone(),
            id: String::new(),
            title: String::new(),
            js,
            pak,
        });
    } else {
        embeds.push(Embed {
            output: app.clone(),
            id: String::new(),
            title: String::new(),
            js: String::new(),
            pak: Vec::new(),
        });
    }

    // Multi-app mode embeds `.pocket` PACKAGES (contracts/spec/pocket-package.ts)
    // verbatim — the device parses them at boot with the core reader
    // (engine/core/src/package.rs); js/pak are zero-copy slices into .rodata.
    let registry = env::var("POCKETJS_LAUNCHER_REGISTRY").unwrap_or_default();
    let mut pockets: Vec<(String, String, String, Vec<u8>)> = Vec::new(); // output, id, title, bytes
    if !registry.is_empty() {
        assert!(
            embed_app,
            "POCKETJS_LAUNCHER_REGISTRY requires POCKETJS_EMBED_APP=1 (the launcher is app 0)"
        );
        println!("cargo:rerun-if-changed={registry}");
        let packages_dir = dist.join("packages");
        let read_pocket = |output: &str| -> Vec<u8> {
            let path = packages_dir.join(format!("{output}.pocket"));
            println!("cargo:rerun-if-changed={}", path.display());
            fs::read(&path).unwrap_or_else(|e| {
                panic!(
                    "could not read {} (run: bun tools/launcher.ts pack): {e}",
                    path.display()
                )
            })
        };
        pockets.push((app.clone(), String::new(), String::new(), read_pocket(&app)));
        let tsv = fs::read_to_string(&registry)
            .unwrap_or_else(|e| panic!("could not read {registry}: {e}"));
        for (lineno, line) in tsv.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let mut cols = line.split('\t');
            let (output, id, title) = match (cols.next(), cols.next(), cols.next()) {
                (Some(o), Some(i), Some(t)) => (o.to_string(), i.to_string(), t.to_string()),
                _ => panic!("{registry}:{}: expected output\\tid\\ttitle", lineno + 1),
            };
            assert!(
                output != app,
                "{registry}: registry lists the launcher itself ({app})"
            );
            let bytes = read_pocket(&output);
            pockets.push((output, id, title, bytes));
        }
        assert!(
            pockets.len() > 1,
            "{registry}: no apps — a launcher EBOOT with nothing to launch"
        );
    }

    // Build identity: FNV-1a64 over exactly the bytes embedded — in package
    // mode the `.pocket` FILES in table order (each already carries its own
    // footer hash), in single-app mode the js (before its NUL) + pak.
    // tools/bundle-hash.ts is the host-side twin; the device reports this
    // through OP.debugStats and the PSPLINK bridge compares it against
    // local dist/ — a stale embed announces itself instead of silently
    // invalidating a round of on-device verification.
    let bundle_hash = if !pockets.is_empty() {
        let chunks: Vec<&[u8]> = pockets.iter().map(|(_, _, _, b)| b.as_slice()).collect();
        fnv1a64(&chunks)
    } else if embed_app {
        let chunks: Vec<&[u8]> = embeds
            .iter()
            .flat_map(|e| [e.js.as_bytes(), e.pak.as_slice()])
            .collect();
        fnv1a64(&chunks)
    } else {
        String::from("none")
    };
    println!("cargo:rustc-env=POCKETJS_BUNDLE_HASH={bundle_hash}");

    // The generated table (switch.rs include!s it). Package mode: every
    // entry is a verbatim `.pocket` (js/pak empty, extracted at boot by the
    // core reader). Single-app mode: the classic js/pak embed, an empty
    // pocket, and behavior byte-identical to before the table existed.
    let mut apps_rs = String::from(
        "// GENERATED by build.rs — the embedded app table (docs/LAUNCHER.md).\n\
         pub struct EmbeddedApp {\n\
             pub output: &'static str,\n\
             pub id: &'static str,\n\
             pub title: &'static str,\n\
             /// NUL-terminated for JS_Eval (eval with len - 1); empty when\n\
             /// `pocket` carries the bundle instead.\n\
             pub js: &'static str,\n\
             pub pak: &'static [u8],\n\
             /// A verbatim .pocket package (contracts/spec/pocket-package.ts), or empty.\n\
             pub pocket: &'static [u8],\n\
         }\n\
         pub static APPS: &[EmbeddedApp] = &[\n",
    );
    // Empty placeholders so include_bytes!/include_str! always resolve.
    fs::write(Path::new(&out_dir).join("empty.bin"), []).unwrap();
    if !pockets.is_empty() {
        for (i, (output, id, title, bytes)) in pockets.iter().enumerate() {
            fs::write(Path::new(&out_dir).join(format!("app{i}.pocket")), bytes).unwrap();
            // 16-align the embedded package: its internal payloads are
            // 16-aligned relative to the FILE start, and include_bytes!
            // alone guarantees nothing — MIPS faults on unaligned word
            // loads, so anchor the file itself.
            apps_rs.push_str(&format!(
                "    EmbeddedApp {{ output: {output:?}, id: {id:?}, title: {title:?}, \
                 js: \"\", pak: &[], \
                 pocket: {{ static A{i}: psp::Align16<[u8; {len}]> = \
                 psp::Align16(*include_bytes!(concat!(env!(\"OUT_DIR\"), \"/app{i}.pocket\"))); \
                 &A{i}.0 }} }},\n",
                len = bytes.len(),
            ));
        }
    } else {
        for (i, e) in embeds.iter().enumerate() {
            let mut js = e.js.clone();
            js.push('\0');
            fs::write(Path::new(&out_dir).join(format!("app{i}.js")), js).unwrap();
            fs::write(Path::new(&out_dir).join(format!("app{i}.pak")), &e.pak).unwrap();
            apps_rs.push_str(&format!(
                "    EmbeddedApp {{ output: {output:?}, id: {id:?}, title: {title:?}, \
                 js: include_str!(concat!(env!(\"OUT_DIR\"), \"/app{i}.js\")), \
                 pak: include_bytes!(concat!(env!(\"OUT_DIR\"), \"/app{i}.pak\")), \
                 pocket: include_bytes!(concat!(env!(\"OUT_DIR\"), \"/empty.bin\")) }},\n",
                output = e.output,
                id = e.id,
                title = e.title,
            ));
        }
    }
    apps_rs.push_str("];\n");
    fs::write(Path::new(&out_dir).join("apps.rs"), apps_rs).unwrap();

    // Legacy single-bundle embeds (main.rs consumed these before the table
    // existed; kept so a mid-migration checkout still links).
    let mut legacy = embeds[0].js.clone();
    legacy.push('\0');
    fs::write(Path::new(&out_dir).join("game.js"), legacy).unwrap();
    fs::write(Path::new(&out_dir).join("app.pak"), &embeds[0].pak).unwrap();

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

/// FNV-1a 64 as 16 hex digits — keep in lockstep with tools/bundle-hash.ts
/// (test vectors asserted there: "" = cbf29ce484222325, "a" = af63dc4c8601ec8c).
fn fnv1a64(chunks: &[&[u8]]) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for chunk in chunks {
        for &b in *chunk {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    format!("{h:016x}")
}
