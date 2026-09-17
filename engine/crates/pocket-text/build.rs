fn main() {
    println!("cargo:rerun-if-changed=src/freetype.c");
    if std::env::var_os("CARGO_FEATURE_RUNTIME").is_none() {
        return;
    }
    if std::env::var("CARGO_CFG_TARGET_ARCH").unwrap() == "wasm32" {
        return;
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("psp") {
        println!("cargo:rerun-if-env-changed=POCKETJS_FREETYPE_INCLUDE");
        println!("cargo:rerun-if-env-changed=POCKETJS_FREETYPE_LIB");
        let include = std::env::var("POCKETJS_FREETYPE_INCLUDE")
            .expect("PSP FreeType headers missing; build through `bun tools/psp.ts`");
        let library = std::env::var("POCKETJS_FREETYPE_LIB")
            .expect("PSP FreeType O32 archive missing; build through `bun tools/psp.ts`");
        cc::Build::new()
            .file("src/freetype.c")
            .include(include)
            .compile("pocket_text_freetype");
        println!("cargo:rerun-if-changed={library}/libfreetype.a");
        println!("cargo:rustc-link-search=native={library}");
        println!("cargo:rustc-link-lib=static=freetype");
        return;
    }
    let library = pkg_config::Config::new()
        .atleast_version("2.10")
        .probe("freetype2")
        .expect("pocket-text native worker requires FreeType development headers and pkg-config");
    let mut build = cc::Build::new();
    build.file("src/freetype.c");
    for path in library.include_paths {
        build.include(path);
    }
    build.compile("pocket_text_freetype");
}
