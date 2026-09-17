fn main() {
    println!("cargo:rerun-if-changed=src/freetype.c");
    if std::env::var("CARGO_CFG_TARGET_ARCH").unwrap() == "wasm32" {
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
