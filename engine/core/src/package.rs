//! `.pocket` package reader — the device side of the container format.
//! contracts/spec/pocket-package.ts is the format authority; both implementations are
//! pinned to the SAME committed fixture (tests/fixtures/packages/), so they
//! cannot drift apart silently.
//!
//! Zero-copy by design: every accessor returns borrowed slices of the input
//! bytes. An EBOOT embeds `.pocket` files verbatim in .rodata and boots a
//! guest straight out of them — the js section carries its QuickJS NUL
//! terminator (eval with len - 1), the pak section feeds pak::feed as-is.

use core::str;

use crate::package_format::{
    OFFSET_SECTION_OFFSET, OFFSET_SECTION_SIZE, OFFSET_VARIANT_HASH, OFFSET_VARIANT_HOST_ABI,
    OFFSET_VARIANT_SECTIONS_OFFSET, OFFSET_VARIANT_SECTION_COUNT,
};
use crate::package_format::{
    POCKET_ALIGN as ALIGN, POCKET_HEADER_SIZE as HEADER_SIZE, POCKET_SECTION_SIZE as SECTION_SIZE,
    POCKET_TARGET_BYTES as TARGET_BYTES, POCKET_VARIANT_SIZE as VARIANT_SIZE,
};
pub use crate::package_format::{POCKET_MAGIC as MAGIC, POCKET_VERSION as VERSION};

/// Section kinds (append-only; skip what you do not know).
pub mod section {
    pub use crate::package_format::{
        SECTION_COVER as COVER, SECTION_IDENTITY as IDENTITY, SECTION_JS as JS, SECTION_PAK as PAK,
        SECTION_PLAN as PLAN,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError {
    Truncated,
    BadMagic,
    BadVersion,
    HashMismatch,
    BadUtf8,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestError {
    Package(PackageError),
    MissingVariant,
    HostAbiMismatch,
    MissingIdentity,
    MissingPlan,
    MissingJavaScript,
    JavaScriptNotTerminated,
}

impl From<PackageError> for GuestError {
    fn from(value: PackageError) -> Self {
        Self::Package(value)
    }
}

#[derive(Debug)]
pub struct Package<'a> {
    bytes: &'a [u8],
    manifest_len: usize,
    variant_count: usize,
    table_off: usize,
}

#[derive(Clone, Copy)]
pub struct Variant<'a> {
    bytes: &'a [u8],
    pub target: &'a str,
    pub host_abi: u32,
    pub variant_hash: u64,
    section_count: usize,
    sections_off: usize,
}

pub struct Identity<'a> {
    pub output: &'a str,
    pub id: &'a str,
    pub title: &'a str,
}

/// A filesystem package admitted for one native host. The package allocation
/// must outlive these slices; native runtimes keep it until guest teardown.
pub struct Guest<'a> {
    /// The variant identity's application id (`app.id` of its plan).
    pub id: &'a str,
    pub js: &'a [u8],
    pub pak: &'a [u8],
    pub plan: &'a [u8],
    pub package_hash: u64,
    pub variant_hash: u64,
}

fn u32_at(bytes: &[u8], off: usize) -> Result<u32, PackageError> {
    let s = bytes.get(off..off + 4).ok_or(PackageError::Truncated)?;
    Ok(u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
}

fn u64_at(bytes: &[u8], off: usize) -> Result<u64, PackageError> {
    let s = bytes.get(off..off + 8).ok_or(PackageError::Truncated)?;
    Ok(u64::from_le_bytes([
        s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7],
    ]))
}

/// FNV-1a64, lockstep with tools/bundle-hash.ts / hosts/psp/build.rs.
pub fn fnv1a64(chunks: &[&[u8]]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for chunk in chunks {
        for &b in *chunk {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
    }
    h
}

impl<'a> Package<'a> {
    /// Parse and (unless `skip_hash`) verify the footer hash. Embedded
    /// packages were hashed at build time — boot paths pass `skip_hash =
    /// true` and rely on the EBOOT's own build identity; filesystem loads
    /// (dynamic install) MUST verify.
    pub fn parse(bytes: &'a [u8], skip_hash: bool) -> Result<Self, PackageError> {
        if bytes.len() < HEADER_SIZE + 8 {
            return Err(PackageError::Truncated);
        }
        if u32_at(bytes, 0)? != MAGIC {
            return Err(PackageError::BadMagic);
        }
        if u32_at(bytes, 4)? != VERSION {
            return Err(PackageError::BadVersion);
        }
        if !skip_hash {
            let stored = u64_at(bytes, bytes.len() - 8)?;
            if stored != fnv1a64(&[&bytes[..bytes.len() - 8]]) {
                return Err(PackageError::HashMismatch);
            }
        }
        let manifest_len = u32_at(bytes, 8)? as usize;
        let variant_count = u32_at(bytes, 12)? as usize;
        let end = bytes.len() - 8;
        let manifest_end = HEADER_SIZE
            .checked_add(manifest_len)
            .ok_or(PackageError::Truncated)?;
        if manifest_end > end {
            return Err(PackageError::Truncated);
        }
        let table_off = manifest_end
            .checked_add(ALIGN - 1)
            .ok_or(PackageError::Truncated)?
            & !(ALIGN - 1);
        if table_off > end || variant_count > (end - table_off) / VARIANT_SIZE {
            return Err(PackageError::Truncated);
        }
        let package = Package {
            bytes,
            manifest_len,
            variant_count,
            table_off,
        };
        for i in 0..variant_count {
            let variant = package.variant(i)?;
            if variant.sections_off > end
                || variant.section_count > (end - variant.sections_off) / SECTION_SIZE
            {
                return Err(PackageError::Truncated);
            }
            for j in 0..variant.section_count {
                let section = variant.sections_off + j * SECTION_SIZE;
                let offset = u32_at(bytes, section + OFFSET_SECTION_OFFSET)? as usize;
                let length = u32_at(bytes, section + OFFSET_SECTION_SIZE)? as usize;
                if offset > end || length > end - offset {
                    return Err(PackageError::Truncated);
                }
            }
        }
        Ok(package)
    }

    /// pocket.json bytes, verbatim.
    pub fn manifest(&self) -> &'a [u8] {
        &self.bytes[HEADER_SIZE..HEADER_SIZE + self.manifest_len]
    }

    pub fn variant_count(&self) -> usize {
        self.variant_count
    }

    /// The verified footer value. `parse(..., false)` has already compared it
    /// with the bytes; embedded callers that skip verification use it only as
    /// an artifact identity.
    pub fn package_hash(&self) -> Result<u64, PackageError> {
        u64_at(self.bytes, self.bytes.len() - 8)
    }

    pub fn variant(&self, index: usize) -> Result<Variant<'a>, PackageError> {
        if index >= self.variant_count {
            return Err(PackageError::Truncated);
        }
        let entry = self.table_off + index * VARIANT_SIZE;
        let name = self
            .bytes
            .get(entry..entry + TARGET_BYTES)
            .ok_or(PackageError::Truncated)?;
        let len = name
            .iter()
            .position(|&b| b == 0)
            .ok_or(PackageError::BadUtf8)?;
        if len == 0 {
            return Err(PackageError::BadUtf8);
        }
        let target = str::from_utf8(&name[..len]).map_err(|_| PackageError::BadUtf8)?;
        Ok(Variant {
            bytes: self.bytes,
            target,
            host_abi: u32_at(self.bytes, entry + OFFSET_VARIANT_HOST_ABI)?,
            section_count: u32_at(self.bytes, entry + OFFSET_VARIANT_SECTION_COUNT)? as usize,
            sections_off: u32_at(self.bytes, entry + OFFSET_VARIANT_SECTIONS_OFFSET)? as usize,
            variant_hash: u64_at(self.bytes, entry + OFFSET_VARIANT_HASH)?,
        })
    }

    /// The variant for a target id, if the file carries one.
    pub fn find_variant(&self, target: &str) -> Result<Option<Variant<'a>>, PackageError> {
        for i in 0..self.variant_count {
            let v = self.variant(i)?;
            if v.target == target {
                return Ok(Some(v));
            }
        }
        Ok(None)
    }
}

/// Parse a package and admit its guest payload for an exact target/host ABI.
/// This is the shared boundary filesystem-loading hosts use before exposing
/// any package bytes to QuickJS or the retained UI core.
pub fn select_guest<'a>(
    bytes: &'a [u8],
    target: &str,
    host_abi: u32,
    skip_hash: bool,
) -> Result<Guest<'a>, GuestError> {
    let package = Package::parse(bytes, skip_hash)?;
    let variant = package
        .find_variant(target)?
        .ok_or(GuestError::MissingVariant)?;
    if variant.host_abi != host_abi {
        return Err(GuestError::HostAbiMismatch);
    }
    let identity = variant.identity()?.ok_or(GuestError::MissingIdentity)?;
    let plan = variant
        .section(section::PLAN)?
        .filter(|value| !value.is_empty())
        .ok_or(GuestError::MissingPlan)?;
    let js = variant
        .section(section::JS)?
        .filter(|value| !value.is_empty())
        .ok_or(GuestError::MissingJavaScript)?;
    if js.last() != Some(&0) {
        return Err(GuestError::JavaScriptNotTerminated);
    }
    let pak = variant.section(section::PAK)?.unwrap_or(&[]);
    Ok(Guest {
        id: identity.id,
        js,
        pak,
        plan,
        package_hash: package.package_hash()?,
        variant_hash: variant.variant_hash,
    })
}

impl<'a> Variant<'a> {
    /// A section payload by kind (unknown kinds are simply never asked for —
    /// forward compatible by construction).
    pub fn section(&self, kind: u32) -> Result<Option<&'a [u8]>, PackageError> {
        for i in 0..self.section_count {
            let entry = self.sections_off + i * SECTION_SIZE;
            if u32_at(self.bytes, entry)? == kind {
                let off = u32_at(self.bytes, entry + OFFSET_SECTION_OFFSET)? as usize;
                let len = u32_at(self.bytes, entry + OFFSET_SECTION_SIZE)? as usize;
                return self
                    .bytes
                    .get(off..off + len)
                    .map(Some)
                    .ok_or(PackageError::Truncated);
            }
        }
        Ok(None)
    }

    /// The device registry line (kind 1) — output, id, title without any
    /// JSON parsing on the console.
    pub fn identity(&self) -> Result<Option<Identity<'a>>, PackageError> {
        let Some(bytes) = self.section(section::IDENTITY)? else {
            return Ok(None);
        };
        let mut off = 0usize;
        let mut fields = [""; 3];
        for slot in fields.iter_mut() {
            let len = bytes
                .get(off..off + 2)
                .map(|s| u16::from_le_bytes([s[0], s[1]]) as usize)
                .ok_or(PackageError::Truncated)?;
            off += 2;
            let raw = bytes.get(off..off + len).ok_or(PackageError::Truncated)?;
            *slot = str::from_utf8(raw).map_err(|_| PackageError::BadUtf8)?;
            off += len;
        }
        Ok(Some(Identity {
            output: fields[0],
            id: fields[1],
            title: fields[2],
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_malformed_corpus() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/fixtures/packages/corpus");
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|v| v.to_str()) != Some("pocket") {
                continue;
            }
            let expected = path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ok-");
            assert_eq!(
                Package::parse(&std::fs::read(&path).unwrap(), false).is_ok(),
                expected,
                "{}",
                path.display()
            );
        }
    }

    /// The SAME committed fixture tests/pocket-package.test.ts byte-compares
    /// against the TS encoder — the cross-implementation contract.
    static FIXTURE: &[u8] = include_bytes!("../../../tests/fixtures/packages/synthetic.pocket");

    #[test]
    fn parses_the_shared_fixture() {
        let pkg = Package::parse(FIXTURE, false).unwrap();
        assert_eq!(pkg.variant_count(), 3);
        let targets: alloc::vec::Vec<&str> =
            (0..3).map(|i| pkg.variant(i).unwrap().target).collect();
        assert_eq!(targets, ["macos-widget", "psp", "vita"]);
        assert!(core::str::from_utf8(pkg.manifest())
            .unwrap()
            .contains("synthetic"));

        let psp = pkg.find_variant("psp").unwrap().unwrap();
        assert_eq!(psp.host_abi, 1);
        let identity = psp.identity().unwrap().unwrap();
        assert_eq!(identity.output, "synthetic-main");
        assert_eq!(identity.title, "Synthetic");
        // The js section ends in the QuickJS NUL (zero-copy eval rule).
        let js = psp.section(section::JS).unwrap().unwrap();
        assert_eq!(*js.last().unwrap(), 0);
        // Target-flavored sections stay per-variant.
        assert_eq!(psp.section(section::PAK).unwrap().unwrap()[0], 10);
        let vita = pkg.find_variant("vita").unwrap().unwrap();
        assert_eq!(vita.section(section::PAK).unwrap().unwrap()[0], 20);
        let widget = pkg.find_variant("macos-widget").unwrap().unwrap();
        assert_eq!(widget.section(section::PAK).unwrap().unwrap()[0], 30);
        assert_eq!(widget.host_abi, 3);
    }

    #[test]
    fn tamper_trips_the_footer_hash() {
        let mut evil = FIXTURE.to_vec();
        let n = evil.len();
        evil[n - 20] ^= 0xff;
        assert_eq!(
            Package::parse(&evil, false).unwrap_err(),
            PackageError::HashMismatch
        );
        assert!(Package::parse(&evil, true).is_ok());
    }

    #[test]
    fn refuses_wrong_magic_and_truncation() {
        assert_eq!(
            Package::parse(&[0u8; 8], false).unwrap_err(),
            PackageError::Truncated
        );
        let mut bad = FIXTURE.to_vec();
        bad[0] ^= 0xff;
        assert_eq!(
            Package::parse(&bad, false).unwrap_err(),
            PackageError::BadMagic
        );
    }

    #[test]
    fn admits_a_complete_guest_for_an_exact_host() {
        let guest = select_guest(FIXTURE, "psp", 1, false).unwrap();
        assert_eq!(guest.js.last(), Some(&0));
        assert!(!guest.id.is_empty());
        assert!(!guest.plan.is_empty());
        assert_eq!(guest.pak[0], 10);
        assert_ne!(guest.package_hash, 0);
        assert_ne!(guest.variant_hash, 0);
    }

    #[test]
    fn rejects_target_and_host_abi_drift() {
        assert!(matches!(
            select_guest(FIXTURE, "3ds-dev", 8, false),
            Err(GuestError::MissingVariant)
        ));
        assert!(matches!(
            select_guest(FIXTURE, "psp", 8, false),
            Err(GuestError::HostAbiMismatch)
        ));
    }
}
