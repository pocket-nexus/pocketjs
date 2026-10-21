//! Compatibility conversion for pre-package Apple entry points. Admission,
//! section layout and hashes remain owned by pocket-package.
use super::{bridge::Bridge, Configuration};
use pocket_package::embedded::{self, EmbeddedPackage};
use serde_json::json;

pub(crate) fn encode(
    config: &Configuration,
    bridge: &Bridge,
    code: &[u8],
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let [width, height] = bridge.logical;
    let profile = serde_json::to_vec(&json!({
        "id": config.host,
        "platform": "ios",
        "form": "embedded",
        "tickHz": config.hz,
        "display": {
            "physicalViewport": [width * bridge.density, height * bridge.density],
            "logicalViewports": [[width, height]],
            "rasterDensity": bridge.density
        },
        "capabilities": ["input.touch", "text.glyphs.baked"],
        "roleCapabilities": {}
    }))
    .map_err(|error| error.to_string())?;
    let plan = serde_json::to_vec(&json!({
        "viewport": {"logical": [width, height], "rasterDensity": bridge.density},
        "features": {"input.touch": true, "text.glyphs.baked": true}
    }))
    .map_err(|error| error.to_string())?;
    let identity = embedded::identity(
        "embedded",
        "dev.pocketjs.apple.embedded",
        "Apple embedded guest",
    )
    .map_err(|e| format!("{e:?}"))?;
    let package = embedded::encode(EmbeddedPackage {
        target: &config.host,
        host_abi: config.abi,
        profile_hash: pocket_package::sha256::sha256(&profile),
        identity: &identity,
        plan: &plan,
        code,
        pak: &config.pak,
    })
    .map_err(|e| format!("{e:?}"))?;
    Ok((profile, package))
}
