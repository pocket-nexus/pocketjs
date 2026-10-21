fn main() {
    println!("cargo:rerun-if-changed=Cargo.toml");
    embuild::espidf::sysenv::output();
}
