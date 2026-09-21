use std::path::{Path, PathBuf};
use std::{env, fs};

fn positive_dimension(name: &str, fallback: u32) -> u32 {
    match env::var(name) {
        Ok(value) => value
            .parse::<u32>()
            .ok()
            .filter(|value| *value > 0)
            .unwrap_or_else(|| panic!("{name} must be a positive integer, got {value:?}")),
        Err(_) => fallback,
    }
}

fn main() {
    let dev_plan = env::var("POCKETJS_VITA_PLAN").unwrap_or_default();
    let plan_json = if dev_plan.is_empty() {
        "null".into()
    } else {
        println!("cargo:rerun-if-changed={dev_plan}");
        fs::read_to_string(&dev_plan).expect("read Vita debug build plan")
    };
    for key in [
        "POCKETJS_VITA_PLAN",
        "POCKETJS_VITA_TITLE_ID",
        "POCKETJS_NATIVE_BUILD",
    ] {
        println!("cargo:rerun-if-env-changed={key}");
    }
    let title_id = env::var("POCKETJS_VITA_TITLE_ID").unwrap_or_default();
    let native_build = env::var("POCKETJS_NATIVE_BUILD").unwrap_or_else(|_| "external".into());
    fs::write(PathBuf::from(env::var("OUT_DIR").unwrap()).join("dev_identity.rs"), format!(
        "pub const PLAN: &str = {plan_json:?};\npub const TITLE_ID: &str = {title_id:?};\npub const NATIVE_BUILD: &str = {native_build:?};\n"
    )).unwrap();
    println!("cargo:rustc-link-lib=SceAppMgr_stub");
    if env::var_os("CARGO_FEATURE_USB_DEBUG").is_some() {
        println!("cargo:rustc-link-lib=taihen_stub_weak");
        println!("cargo:rustc-link-lib=SceVshBridge_stub");
    }
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
    let target = env::var("POCKETJS_TARGET").unwrap_or_else(|_| "vita".into());
    assert_eq!(target, "vita", "Vita host requires POCKETJS_TARGET=vita");
    let host_abi = env::var("POCKETJS_HOST_ABI").unwrap_or_else(|_| "2".into());
    assert_eq!(host_abi, "2", "Vita host requires POCKETJS_HOST_ABI=2");
    let dist = env::var_os("POCKETJS_OUTPUT_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("../../dist"));
    let out_dir = env::var("OUT_DIR").unwrap();

    // The resolved build plan supplies the logical/physical viewports. Vita's
    // The resolved plan keeps PSP-compatible layout while independently
    // specifying physical presentation and target raster density.
    let logical_width = positive_dimension("POCKETJS_LOGICAL_WIDTH", 480);
    let logical_height = positive_dimension("POCKETJS_LOGICAL_HEIGHT", 272);
    let physical_width = positive_dimension("POCKETJS_PHYSICAL_WIDTH", 960);
    let physical_height = positive_dimension("POCKETJS_PHYSICAL_HEIGHT", 544);
    let raster_density = positive_dimension("POCKETJS_RASTER_DENSITY", 2);
    let presentation = env::var("POCKETJS_PRESENTATION").unwrap_or_else(|_| "integer-fit".into());
    assert_eq!(
        (logical_width, logical_height),
        (480, 272),
        "Vita host requires the PSP-compatible 480x272 logical viewport"
    );
    assert_eq!(
        (physical_width, physical_height),
        (960, 544),
        "Vita host requires the native 960x544 physical viewport"
    );
    assert_eq!(
        presentation, "integer-fit",
        "Vita host currently supports only integer-fit presentation"
    );
    assert_eq!(raster_density, 2, "Vita host requires raster density 2");
    assert!(
        physical_width % logical_width == 0 && physical_height % logical_height == 0,
        "Vita host requires an integer-fit logical viewport"
    );
    let scale_x = physical_width / logical_width;
    let scale_y = physical_height / logical_height;
    assert_eq!(
        scale_x, scale_y,
        "Vita host requires one uniform fullscreen scale"
    );
    fs::write(
        Path::new(&out_dir).join("build_plan.rs"),
        format!(
            "pub const LOGICAL_W: i32 = {logical_width};\n\
             pub const LOGICAL_H: i32 = {logical_height};\n\
             pub const PHYSICAL_W: i32 = {physical_width};\n\
             pub const PHYSICAL_H: i32 = {physical_height};\n\
             pub const INTEGER_SCALE: usize = {scale_x};\n\
             pub const RASTER_DENSITY: u32 = {raster_density};\n\
             pub const SCALE: f32 = {scale_x} as f32;\n"
        ),
    )
    .unwrap();

    // One generated table shape serves both the classic single-app host and
    // the launcher. Multi-app mode embeds target-thinned `.pocket` files
    // verbatim; the runtime's switch module extracts their Vita js/pak slices
    // zero-copy. Keep this ABI lockstep with hosts/psp/build.rs.
    struct Embed {
        output: String,
        id: String,
        title: String,
        js: String,
        pak: Vec<u8>,
    }

    let read_bundle = |output: &str| -> (String, Vec<u8>) {
        let js_path = dist.join(format!("{output}.js"));
        let pak_path = dist.join(format!("{output}.pak"));
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

    let embed = if embed_app {
        let (js, pak) = read_bundle(&app);
        Embed {
            output: app.clone(),
            id: String::new(),
            title: String::new(),
            js,
            pak,
        }
    } else {
        Embed {
            output: app.clone(),
            id: String::new(),
            title: String::new(),
            js: String::new(),
            pak: Vec::new(),
        }
    };

    // Build identity for debugStats: FNV-1a64 over the embedded js+pak (the
    // PSP host's stale-embed tripwire, verbatim math).
    let bundle_hash = {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for &b in embed.js.as_bytes().iter().chain(embed.pak.iter()) {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        format!("{h:016x}")
    };
    println!("cargo:rustc-env=POCKETJS_APP_NAME={app}");
    println!("cargo:rustc-env=POCKETJS_BUNDLE_HASH={bundle_hash}");

    let registry = env::var("POCKETJS_LAUNCHER_REGISTRY").unwrap_or_default();
    let packages_dir = env::var_os("POCKETJS_LAUNCHER_PACKAGES")
        .map(PathBuf::from)
        .unwrap_or_default();
    let mut pockets: Vec<(String, String, String, Vec<u8>)> = Vec::new();
    if !registry.is_empty() {
        assert!(
            embed_app,
            "POCKETJS_LAUNCHER_REGISTRY requires POCKETJS_EMBED_APP=1 (launcher is app 0)"
        );
        assert!(
            !packages_dir.as_os_str().is_empty(),
            "POCKETJS_LAUNCHER_REGISTRY requires POCKETJS_LAUNCHER_PACKAGES"
        );
        println!("cargo:rerun-if-changed={registry}");
        let read_pocket = |output: &str| -> Vec<u8> {
            let path = packages_dir.join(format!("{output}.pocket"));
            println!("cargo:rerun-if-changed={}", path.display());
            fs::read(&path).unwrap_or_else(|e| {
                panic!(
                    "could not read {} (run: bun tools/launcher.ts pack --target vita): {e}",
                    path.display()
                )
            })
        };
        // App 0 is always the launcher. Its display metadata comes from its
        // own guest bundle; it is intentionally absent from the deck registry.
        pockets.push((app.clone(), String::new(), String::new(), read_pocket(&app)));
        let tsv = fs::read_to_string(&registry)
            .unwrap_or_else(|e| panic!("could not read {registry}: {e}"));
        for (lineno, line) in tsv.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let mut cols = line.split('\t');
            let (output, id, title) = match (cols.next(), cols.next(), cols.next()) {
                (Some(output), Some(id), Some(title)) if cols.next().is_none() => {
                    (output.to_string(), id.to_string(), title.to_string())
                }
                _ => panic!("{registry}:{}: expected output\\tid\\ttitle", lineno + 1),
            };
            assert_ne!(
                output, app,
                "{registry}: registry lists the launcher itself ({app})"
            );
            let bytes = read_pocket(&output);
            pockets.push((output, id, title, bytes));
        }
        assert!(
            pockets.len() > 1,
            "{registry}: no apps — a launcher VPK with nothing to launch"
        );
    }

    let mut apps_rs = String::from(
        "// GENERATED by build.rs — the embedded app table (LAUNCHER.md).\n\
         pub struct EmbeddedApp {\n\
             pub output: &'static str,\n\
             pub id: &'static str,\n\
             pub title: &'static str,\n\
             /// NUL-terminated for JS_Eval (eval with len - 1); empty when\n\
             /// `pocket` carries the bundle instead.\n\
             pub js: &'static str,\n\
             pub pak: &'static [u8],\n\
             /// A verbatim .pocket package, or empty in single-app mode.\n\
             pub pocket: &'static [u8],\n\
         }\n\
         #[repr(align(16))]\n\
         struct Align16<const N: usize>([u8; N]);\n\
         pub static APPS: &[EmbeddedApp] = &[\n",
    );
    fs::write(Path::new(&out_dir).join("empty.bin"), []).unwrap();
    if !pockets.is_empty() {
        for (index, (output, id, title, bytes)) in pockets.iter().enumerate() {
            fs::write(
                Path::new(&out_dir).join(format!("app{index}.pocket")),
                bytes,
            )
            .unwrap();
            // Container payload offsets are 16-aligned relative to the file;
            // anchor include_bytes! itself so those alignments survive in
            // .rodata on ARM too.
            apps_rs.push_str(&format!(
                "    EmbeddedApp {{ output: {output:?}, id: {id:?}, title: {title:?}, \
                 js: \"\", pak: &[], \
                 pocket: {{ static A{index}: Align16<{len}> = \
                 Align16(*include_bytes!(concat!(env!(\"OUT_DIR\"), \"/app{index}.pocket\"))); \
                 &A{index}.0 }} }},\n",
                len = bytes.len(),
            ));
        }
    } else {
        let mut js = embed.js.clone();
        js.push('\0');
        fs::write(Path::new(&out_dir).join("app0.js"), js).unwrap();
        fs::write(Path::new(&out_dir).join("app0.pak"), &embed.pak).unwrap();
        apps_rs.push_str(&format!(
            "    EmbeddedApp {{ output: {output:?}, id: {id:?}, title: {title:?}, \
             js: include_str!(concat!(env!(\"OUT_DIR\"), \"/app0.js\")), \
             pak: include_bytes!(concat!(env!(\"OUT_DIR\"), \"/app0.pak\")), \
             pocket: include_bytes!(concat!(env!(\"OUT_DIR\"), \"/empty.bin\")) }},\n",
            output = embed.output,
            id = embed.id,
            title = embed.title,
        ));
    }
    apps_rs.push_str("];\n");
    fs::write(Path::new(&out_dir).join("apps.rs"), apps_rs).unwrap();

    // Legacy outputs keep the current single-app main and external hosts
    // compiling during the runtime migration. They deliberately remain the
    // launcher bundle in multi-app mode; switch.rs consumes apps.rs instead.
    let mut legacy_js = embed.js.clone();
    legacy_js.push('\0');
    fs::write(Path::new(&out_dir).join("game.js"), legacy_js).unwrap();
    fs::write(Path::new(&out_dir).join("app.pak"), &embed.pak).unwrap();

    let capture_input = env::var("POCKETJS_CAPTURE_INPUT").unwrap_or_default();
    let capture_touch = env::var("POCKETJS_CAPTURE_TOUCH").unwrap_or_default();
    let capture_frames = env::var("POCKETJS_CAPTURE_FRAMES").unwrap_or_default();
    let capture_dir = env::var("POCKETJS_CAPTURE_DIR")
        .unwrap_or_else(|_| String::from("ux0:data/pocketjs-captures"));

    println!("cargo:rustc-env=POCKETJS_TARGET={target}");
    println!("cargo:rustc-env=POCKETJS_HOST_ABI={host_abi}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_INPUT={capture_input}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_TOUCH={capture_touch}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_FRAMES={capture_frames}");
    println!("cargo:rustc-env=POCKETJS_CAPTURE_DIR={capture_dir}");

    println!("cargo:rerun-if-env-changed=POCKETJS_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_APP_OUTPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_EMBED_APP");
    println!("cargo:rerun-if-env-changed=POCKETJS_OUTPUT_DIR");
    println!("cargo:rerun-if-env-changed=POCKETJS_LAUNCHER_REGISTRY");
    println!("cargo:rerun-if-env-changed=POCKETJS_LAUNCHER_PACKAGES");
    println!("cargo:rerun-if-env-changed=POCKETJS_TARGET");
    println!("cargo:rerun-if-env-changed=POCKETJS_HOST_ABI");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_LOGICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_WIDTH");
    println!("cargo:rerun-if-env-changed=POCKETJS_PHYSICAL_HEIGHT");
    println!("cargo:rerun-if-env-changed=POCKETJS_PRESENTATION");
    println!("cargo:rerun-if-env-changed=POCKETJS_RASTER_DENSITY");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_INPUT");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_FRAMES");
    println!("cargo:rerun-if-env-changed=POCKETJS_CAPTURE_DIR");
}
