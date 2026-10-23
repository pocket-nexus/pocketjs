//! Places the profile `pocket build` exported for this program in OUT_DIR.
fn main() {
    pocket_profile_build::emit(pocket_profile_build::Export::Required);
}
