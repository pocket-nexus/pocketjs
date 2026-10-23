//! Compatibility conversion for pre-package Apple entry points. Admission,
//! section layout and hashes remain owned by pocket-package.
use super::{bridge::Bridge, Configuration};
use pocket_package::embedded::{self, EmbeddedPackage};
use pocket_runtime::{Cow, InputClasses, Profile};

/// No exported profile names this embedding; the synthesized package and the
/// runtime share the all-zero hash.
pub(crate) const PROFILE_HASH: [u8; 32] = [0; 32];

/// The configured identity and tick rate with the bridge's one viewport.
pub(crate) fn profile(config: &Configuration, bridge: &Bridge) -> Profile {
    let [width, height] = bridge.logical;
    Profile {
        id: Cow::Owned(config.host.clone()),
        tick_hz: config.hz,
        viewport: [width * bridge.density, height * bridge.density],
        logical_viewports: Cow::Owned(vec![[width, height]]),
        dynamic_viewport: None,
        auxiliary: None,
        auxiliary_logical: Cow::Borrowed(&[]),
        density: bridge.density,
        required_inputs: InputClasses::CONTACT,
    }
}

pub(crate) fn encode(
    config: &Configuration,
    bridge: &Bridge,
    code: &[u8],
) -> Result<Vec<u8>, String> {
    let [width, height] = bridge.logical;
    let plan = format!(
        r#"{{"features":{{"input.touch":true,"text.glyphs.baked":true}},"viewport":{{"logical":[{width},{height}],"rasterDensity":{}}}}}"#,
        bridge.density
    );
    let identity = embedded::identity(
        "embedded",
        "dev.pocketjs.apple.embedded",
        "Apple embedded guest",
    )
    .map_err(|e| format!("{e:?}"))?;
    embedded::encode(EmbeddedPackage {
        target: &config.host,
        host_abi: config.abi,
        profile_hash: PROFILE_HASH,
        identity: &identity,
        plan: plan.as_bytes(),
        code,
        pak: &config.pak,
    })
    .map_err(|e| format!("{e:?}"))
}
