fn main() {
    for name in ["POCKET_PSP_CC", "POCKET_PSP_AR"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    cc::Build::new()
        .compiler(std::env::var("POCKET_PSP_CC").expect("POCKET_PSP_CC"))
        .archiver(std::env::var("POCKET_PSP_AR").expect("POCKET_PSP_AR"))
        .no_default_flags(true)
        .flag("--no-default-config")
        .flag("--target=mipsel-sony-psp")
        .flag("-march=mips2")
        .flag("-mno-abicalls")
        .flag("-fno-pic")
        .flag("-G0")
        .flag("-mabi=o32")
        .flag("-mhard-float")
        .flag("-mfp32")
        .flag("-O2")
        .file("fpu.c")
        .compile("pocket_psp_fpu");
    println!("cargo:rerun-if-changed=fpu.c");
}
