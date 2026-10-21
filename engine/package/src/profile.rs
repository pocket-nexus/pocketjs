//! Validation of independently supplied program profile build inputs.
//! Environment lookup belongs to the program call site, not this library.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ProfileError {
    MissingInput,
    InvalidHash,
    HashMismatch,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BuildProfile<'a> {
    pub json: &'a [u8],
    pub hash: [u8; 32],
}

/// Programs pass their own `option_env!` values here. Both values must be
/// present together. The JSON is the exported canonical seven-field profile;
/// its exact UTF-8 bytes, without a BOM or newline, define the SHA-256 identity.
/// Runtime validates the profile's JSON and device requirements.
pub fn from_build_inputs<'a>(
    json: Option<&'a str>,
    hash: Option<&str>,
) -> Result<Option<BuildProfile<'a>>, ProfileError> {
    let (json, hash) = match (json, hash) {
        (None, None) => return Ok(None),
        (Some(json), Some(hash)) => (json, hash),
        _ => return Err(ProfileError::MissingInput),
    };
    let hex = hash
        .strip_prefix("sha256:")
        .ok_or(ProfileError::InvalidHash)?;
    if hex.len() != 64 {
        return Err(ProfileError::InvalidHash);
    }
    let nibble = |byte| match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        _ => Err(ProfileError::InvalidHash),
    };
    let mut digest = [0; 32];
    for (out, pair) in digest.iter_mut().zip(hex.as_bytes().as_chunks::<2>().0) {
        *out = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    if crate::sha256::sha256(json.as_bytes()) != digest {
        return Err(ProfileError::HashMismatch);
    }
    Ok(Some(BuildProfile {
        json: json.as_bytes(),
        hash: digest,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_build_inputs_are_checked_without_package_data() {
        let hash = "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";
        assert_eq!(from_build_inputs(None, None), Ok(None));
        assert_eq!(
            from_build_inputs(Some("{}"), None),
            Err(ProfileError::MissingInput)
        );
        assert_eq!(
            from_build_inputs(None, Some(hash)),
            Err(ProfileError::MissingInput)
        );
        let profile = from_build_inputs(Some("{}"), Some(hash)).unwrap().unwrap();
        assert_eq!(profile.json, b"{}");
        assert_eq!(profile.hash, crate::sha256::sha256(b"{}"));
        assert_eq!(
            from_build_inputs(Some("{}\n"), Some(hash)),
            Err(ProfileError::HashMismatch)
        );
        assert_eq!(
            from_build_inputs(Some("{}"), Some(&hash.to_uppercase())),
            Err(ProfileError::InvalidHash)
        );
    }
}
