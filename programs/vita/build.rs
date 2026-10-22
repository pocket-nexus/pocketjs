use std::path::{Path, PathBuf};
use std::{env, fs};

#[path = "../../tools/build/embedded-apps.rs"]
mod embed;

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
    println!("cargo:rerun-if-env-changed=POCKET_QJS_SOURCE");
    let quickjs = PathBuf::from(env::var_os("POCKET_QJS_SOURCE")
        .expect("POCKET_QJS_SOURCE must name the resolved libquickjs-sys embed/quickjs directory; tools/vita.ts resolves it from cargo metadata"));
    assert!(
        quickjs.join("quickjs.h").is_file(),
        "POCKET_QJS_SOURCE has no quickjs.h"
    );
    for source in [
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
    cc::Build::new()
        .file("../../engine/guest-quickjs/src/guest.c")
        .include("../../engine/guest-quickjs/include")
        .include("../../contracts/generated")
        .include(quickjs)
        .define("POCKET_QJS_BELLARD", None)
        .define("JS_NO_NAN_BOXING", None)
        .flag_if_supported("-std=c11")
        .flag_if_supported("-Wno-unused-parameter")
        .compile("pocket_guest_quickjs");
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
    // The generic runtime (feature `runtime`) carries no game: it reads
    // app0:app.pocket at startup (src/package_file.rs).
    if env::var_os("CARGO_FEATURE_RUNTIME").is_some() {
        assert!(
            !embed_app,
            "the runtime feature builds an eboot without an app: set POCKETJS_EMBED_APP=0"
        );
        assert!(
            env::var("POCKETJS_LAUNCHER_REGISTRY")
                .unwrap_or_default()
                .is_empty(),
            "the runtime feature cannot embed a launcher registry"
        );
    }
    let target = env::var("POCKETJS_TARGET").unwrap_or_else(|_| "vita".into());
    assert_eq!(target, "vita", "Vita host requires POCKETJS_TARGET=vita");
    let host_abi = env::var("POCKETJS_HOST_ABI")
        .unwrap_or_else(|_| pocket_spec::BINDING_GENERATION.to_string());
    assert_eq!(
        host_abi.parse::<u32>().ok(),
        Some(pocket_spec::BINDING_GENERATION),
        "POCKETJS_HOST_ABI must match this build's binding generation"
    );
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

    let registry = env::var_os("POCKETJS_LAUNCHER_REGISTRY")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let packages = env::var_os("POCKETJS_LAUNCHER_PACKAGES")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    assert!(
        registry.is_none() || packages.is_some(),
        "POCKETJS_LAUNCHER_REGISTRY requires POCKETJS_LAUNCHER_PACKAGES"
    );
    let generated = embed::generate(embed::Config {
        identity: embed::Identity::LegacyBundle,
        output: &app,
        enabled: embed_app,
        dist: &dist,
        out: Path::new(&out_dir),
        package: None,
        registry: registry.as_deref(),
        packages: packages.as_deref(),
    })
    .unwrap_or_else(|error| panic!("Vita embed: {error}"));
    println!("cargo:rustc-env=POCKETJS_APP_NAME={app}");
    println!("cargo:rustc-env=POCKETJS_BUNDLE_HASH={}", generated.hash);
    for path in generated.inputs {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rerun-if-changed=../../tools/build/embedded-apps.rs");

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
