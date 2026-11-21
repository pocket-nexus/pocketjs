//! Places the stage profile `bun run widget` exports in OUT_DIR. A default
//! workspace build receives a stub, and the stage reports the missing profile
//! at startup.
fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Optional);
}
