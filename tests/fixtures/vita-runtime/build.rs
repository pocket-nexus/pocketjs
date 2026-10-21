fn main() {
    let root = std::path::Path::new("../../..");
    println!("cargo:rerun-if-env-changed=POCKET_QJS_SOURCE");
    let headers =
        std::env::var("POCKET_QJS_SOURCE").expect("runner resolves pinned Bellard headers");
    for source in [
        "engine/guest-quickjs/src",
        "engine/guest-quickjs/include",
        "contracts/generated",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(source).display());
    }
    cc::Build::new()
        .file(root.join("engine/guest-quickjs/src/guest.c"))
        .include(root.join("engine/guest-quickjs/include"))
        .include(root.join("contracts/generated"))
        .include(headers)
        .define("POCKET_QJS_BELLARD", None)
        .define("JS_NO_NAN_BOXING", None)
        .flag_if_supported("-std=c11")
        .flag_if_supported("-Wno-unused-parameter")
        .compile("pocket_guest_quickjs");
}
