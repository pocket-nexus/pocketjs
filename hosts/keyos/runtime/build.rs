// Compiles the KeyOS libc shim for armv7a-unknown-xous-elf. Other targets
// link QuickJS against their own C library and build nothing here.
//
// The shim reads QuickJS's dtoa.h for strtod and diagnostics formatting;
// POCKET_KEYOS_QUICKJS_INCLUDE names that directory (tools/keyos.ts sets it to
// the rquickjs-sys sources Cargo resolved). The compiler and its flags come
// from cc's CC_<target> and CFLAGS_<target>, the same variables rquickjs-sys
// compiles QuickJS with.

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=../libc");
    println!("cargo:rerun-if-env-changed=POCKET_KEYOS_QUICKJS_INCLUDE");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("xous") {
        return;
    }
    let quickjs = env::var("POCKET_KEYOS_QUICKJS_INCLUDE")
        .expect("POCKET_KEYOS_QUICKJS_INCLUDE must name the QuickJS source directory");
    let libc = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap()).join("../libc");
    cc::Build::new()
        .file(libc.join("libc.c"))
        .include(quickjs)
        .warnings(true)
        .compile("pocket_keyos_libc");
}
