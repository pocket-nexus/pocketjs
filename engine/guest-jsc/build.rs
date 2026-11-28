fn main() {
    println!("cargo:rustc-check-cfg=cfg(pocket_guest_jsc_linux)");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    println!("cargo:rerun-if-env-changed=POCKET_JSC_LIB");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }

    if let Ok(lib) = std::env::var("POCKET_JSC_LIB") {
        if !lib.is_empty() {
            println!("cargo:rustc-link-lib={lib}");
            println!("cargo:rustc-cfg=pocket_guest_jsc_linux");
            return;
        }
    }

    for pkg in [
        "javascriptcoregtk-6.0",
        "javascriptcoregtk-4.1",
        "javascriptcoregtk-4.0",
    ] {
        let Ok(out) = std::process::Command::new("pkg-config")
            .args(["--libs-only-l", "--libs-only-L", pkg])
            .output()
        else {
            continue;
        };
        if !out.status.success() {
            continue;
        }
        let flags = String::from_utf8_lossy(&out.stdout);
        for tok in flags.split_whitespace() {
            if let Some(dir) = tok.strip_prefix("-L") {
                println!("cargo:rustc-link-search=native={dir}");
            } else if let Some(lib) = tok.strip_prefix("-l") {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        println!("cargo:rustc-cfg=pocket_guest_jsc_linux");
        return;
    }
}
