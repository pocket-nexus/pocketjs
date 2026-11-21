fn main() {
    println!("cargo:rerun-if-changed=clock.c");
    cc::Build::new().file("clock.c").compile("fixture_clock");
}
