fn main() {
    // SceShaccCg (libshacccg.suprx) is not part of the firmware's loaded
    // module set. Weak imports let the process start without it; the
    // runtime compiler loads the module from ur0:data before first use.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("vita")
        && std::env::var_os("CARGO_FEATURE_RUNTIME_COMPILER").is_some()
    {
        println!("cargo:rustc-link-lib=static=SceShaccCg_stub_weak");
    }
}
