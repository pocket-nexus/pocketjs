//! Places the macos-widget profile `pocket build` (or `bun run note`) exports
//! in OUT_DIR. A default workspace build receives a stub, and the note reports
//! the missing profile at startup.
fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Optional);
}
