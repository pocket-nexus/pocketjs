fn main() {
    println!("cargo:rerun-if-changed=src/rkrga_shim.c");
    println!("cargo:rerun-if-env-changed=POCKET_RKRGA_SDK");

    if std::env::var_os("CARGO_FEATURE_RKRGA").is_none() {
        return;
    }

    let sdk = std::env::var("POCKET_RKRGA_SDK")
        .expect("the rkrga feature requires POCKET_RKRGA_SDK=/path/to/linux-rga");
    cc::Build::new()
        .file("src/rkrga_shim.c")
        .include(&sdk)
        .include(format!("{sdk}/include"))
        .include(format!("{sdk}/im2d_api"))
        .define("LINUX", None)
        .compile("pocketjs_rkrga_shim");
    println!("cargo:rustc-link-lib=dl");
}
