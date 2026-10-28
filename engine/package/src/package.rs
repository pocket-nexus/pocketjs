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
    OFFSET_HEADER_STRING_TABLE_OFFSET, OFFSET_HEADER_STRING_TABLE_SIZE, OFFSET_SECTION_OFFSET,
    OFFSET_SECTION_SIZE, OFFSET_VARIANT_HASH, OFFSET_VARIANT_HOST_ABI, OFFSET_VARIANT_PROFILE_HASH,
    OFFSET_VARIANT_SECTIONS_OFFSET, OFFSET_VARIANT_SECTION_COUNT, OFFSET_VARIANT_TARGET_OFFSET,
    OFFSET_VARIANT_TARGET_SIZE,
};
use crate::package_format::{
    POCKET_ALIGN as ALIGN, POCKET_HEADER_SIZE as HEADER_SIZE, POCKET_SECTION_SIZE as SECTION_SIZE,
    POCKET_TARGET_MAX_BYTES as TARGET_MAX_BYTES, POCKET_VARIANT_SIZE as VARIANT_SIZE,
};
pub use crate::package_format::{POCKET_MAGIC as MAGIC, POCKET_VERSION as VERSION};

/// Section kinds (append-only; skip what you do not know).
pub mod section {
    pub use crate::package_format::{
        SECTION_COVER as COVER, SECTION_IDENTITY as IDENTITY, SECTION_JS as JS, SECTION_PAK as PAK,
        SECTION_PLAN as PLAN, SECTION_WORKER_JS as WORKER_JS,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackageError {
    Truncated,
    BadMagic,
    BadVersion,
    HashMismatch,
    BadUtf8,
    BadLayout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuestError {
    Package(PackageError),
    MissingVariant,
    HostAbiMismatch,
    ProfileHashMismatch,
    MissingIdentity,
    MissingPlan,
    MissingJavaScript,
    JavaScriptNotTerminated,
    /// The plan's `app.worker` and section 8 disagree: a declaration without
    /// a worker bundle, or a bundle without a declaration.
    WorkerSectionMismatch,
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
    /// Declared identity only. Admission compares it with an independent
    /// program profile; never derive the expected value from this field.
    pub profile_hash: [u8; 32],
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
    /// Section 8, the NUL-terminated worker bundle of a plan with
    /// `app.worker`; empty for a plan without one.
    pub worker_js: &'a [u8],
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

fn checked_end(offset: usize, size: usize, limit: usize) -> Result<usize, PackageError> {
    offset
        .checked_add(size)
        .filter(|&end| end <= limit)
        .ok_or(PackageError::Truncated)
}
fn aligned(value: usize) -> Result<usize, PackageError> {
    value
        .checked_add(ALIGN - 1)
        .map(|value| value & !(ALIGN - 1))
        .ok_or(PackageError::Truncated)
}
const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
fn fnv_continue(mut hash: u64, bytes: &[u8]) -> u64 {
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}
/// FNV-1a64, lockstep with tools/bundle-hash.ts / programs/psp/build.rs.
pub fn fnv1a64(chunks: &[&[u8]]) -> u64 {
    chunks
        .iter()
        .fold(FNV_OFFSET, |hash, bytes| fnv_continue(hash, bytes))
}

impl<'a> Package<'a> {
    /// Parse the canonical v2 layout and verify its footer and variant hashes.
    /// `skip_hash` skips only FNV checks, for metadata inspection after an
    /// independent integrity check. Runtime admission always verifies them.
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
        let end = bytes.len() - 8;
        if !skip_hash && u64_at(bytes, end)? != fnv1a64(&[&bytes[..end]]) {
            return Err(PackageError::HashMismatch);
        }
        if u32_at(bytes, 24)? != 0 || u32_at(bytes, 28)? != 0 {
            return Err(PackageError::BadLayout);
        }
        let manifest_len = u32_at(bytes, 8)? as usize;
        let variant_count = u32_at(bytes, 12)? as usize;
        let manifest_end = checked_end(HEADER_SIZE, manifest_len, end)?;
        let table_off = aligned(manifest_end)?;
        let table_size = variant_count
            .checked_mul(VARIANT_SIZE)
            .ok_or(PackageError::Truncated)?;
        let strings_off = checked_end(table_off, table_size, end)?;
        if u32_at(bytes, OFFSET_HEADER_STRING_TABLE_OFFSET)? as usize != strings_off {
            return Err(PackageError::BadLayout);
        }
        let strings_end = checked_end(
            strings_off,
            u32_at(bytes, OFFSET_HEADER_STRING_TABLE_SIZE)? as usize,
            end,
        )?;
        let package = Package {
            bytes,
            manifest_len,
            variant_count,
            table_off,
        };
        let mut next_string = strings_off;
        let mut next_table = aligned(strings_end)?;
        let mut previous_target: Option<&[u8]> = None;
        // Exact contiguous directories reject overlaps without allocating or
        // comparing every range against every other range.
        for i in 0..variant_count {
            let entry = table_off + i * VARIANT_SIZE;
            if u32_at(bytes, entry + 20)? != 0
                || u32_at(bytes, entry + OFFSET_VARIANT_TARGET_OFFSET)? as usize != next_string
            {
                return Err(PackageError::BadLayout);
            }
            let target_size = u32_at(bytes, entry + OFFSET_VARIANT_TARGET_SIZE)? as usize;
            if target_size == 0 || target_size > TARGET_MAX_BYTES {
                return Err(PackageError::BadUtf8);
            }
            let target_end = checked_end(next_string, target_size, strings_end)?;
            let target = &bytes[next_string..target_end];
            if target.contains(&0) {
                return Err(PackageError::BadUtf8);
            }
            str::from_utf8(target).map_err(|_| PackageError::BadUtf8)?;
            if previous_target.is_some_and(|previous| previous >= target) {
                return Err(PackageError::BadLayout);
            }
            previous_target = Some(target);
            next_string = target_end;
            let variant = package.variant(i)?;
            if variant.sections_off != next_table {
                return Err(PackageError::BadLayout);
            }
            let table_size = variant
                .section_count
                .checked_mul(SECTION_SIZE)
                .ok_or(PackageError::Truncated)?;
            next_table = checked_end(next_table, table_size, end)?;
        }
        if next_string != strings_end {
            return Err(PackageError::BadLayout);
        }
        let mut next_payload = aligned(next_table)?;
        for i in 0..variant_count {
            let variant = package.variant(i)?;
            let mut previous_kind = None;
            let mut hash = FNV_OFFSET;
            for j in 0..variant.section_count {
                let entry = variant.sections_off + j * SECTION_SIZE;
                let kind = u32_at(bytes, entry)?;
                if previous_kind.is_some_and(|previous| previous >= kind)
                    || u32_at(bytes, entry + 4)? != 0
                    || u32_at(bytes, entry + OFFSET_SECTION_OFFSET)? as usize != next_payload
                {
                    return Err(PackageError::BadLayout);
                }
                previous_kind = Some(kind);
                let payload_end = checked_end(
                    next_payload,
                    u32_at(bytes, entry + OFFSET_SECTION_SIZE)? as usize,
                    end,
                )?;
                if !skip_hash {
                    hash = fnv_continue(hash, &bytes[next_payload..payload_end]);
                }
                next_payload = aligned(payload_end)?;
            }
            if !skip_hash && hash != variant.variant_hash {
                return Err(PackageError::HashMismatch);
            }
        }
        if next_payload != end {
            return Err(PackageError::BadLayout);
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
        let target_off = u32_at(self.bytes, entry + OFFSET_VARIANT_TARGET_OFFSET)? as usize;
        let target_len = u32_at(self.bytes, entry + OFFSET_VARIANT_TARGET_SIZE)? as usize;
        let target_end = checked_end(target_off, target_len, self.bytes.len() - 8)?;
        let target = str::from_utf8(&self.bytes[target_off..target_end])
            .map_err(|_| PackageError::BadUtf8)?;
        let mut profile_hash = [0; 32];
        profile_hash.copy_from_slice(
            &self.bytes
                [entry + OFFSET_VARIANT_PROFILE_HASH..entry + OFFSET_VARIANT_PROFILE_HASH + 32],
        );
        Ok(Variant {
            bytes: self.bytes,
            target,
            profile_hash,
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

/// Parse a package and admit its guest payload for an exact target, host ABI
/// and independently supplied program profile hash.
/// This is the shared boundary filesystem-loading hosts use before exposing
/// any package bytes to QuickJS or the retained UI core.
pub fn select_guest<'a>(
    bytes: &'a [u8],
    target: &str,
    host_abi: u32,
    expected_profile_hash: &[u8; 32],
    skip_hash: bool,
) -> Result<Guest<'a>, GuestError> {
    let package = Package::parse(bytes, skip_hash)?;
    let variant = package
        .find_variant(target)?
        .ok_or(GuestError::MissingVariant)?;
    if variant.host_abi != host_abi {
        return Err(GuestError::HostAbiMismatch);
    }
    if variant.profile_hash != *expected_profile_hash {
        return Err(GuestError::ProfileHashMismatch);
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
    let worker_js = worker_payload(plan, variant.section(section::WORKER_JS)?)?;
    let pak = variant.section(section::PAK)?.unwrap_or(&[]);
    Ok(Guest {
        id: identity.id,
        js,
        worker_js,
        pak,
        plan,
        package_hash: package.package_hash()?,
        variant_hash: variant.variant_hash,
    })
}

/// The worker bundle a plan with `app.worker` requires, or an empty slice for
/// a plan without one. The bundle ends with NUL like the UI JavaScript.
fn worker_payload<'a>(plan: &[u8], worker: Option<&'a [u8]>) -> Result<&'a [u8], GuestError> {
    let declared = crate::plan_facts::worker_declared(plan)
        .map_err(|_| GuestError::Package(PackageError::BadLayout))?;
    match (declared, worker) {
        (false, None) => Ok(&[]),
        (true, Some(source)) if source.len() >= 2 && source.last() == Some(&0) => Ok(source),
        (true, Some(_)) => Err(GuestError::JavaScriptNotTerminated),
        _ => Err(GuestError::WorkerSectionMismatch),
    }
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
            .join("tests/fixtures/corpus");
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

    static FIXTURE: &[u8] = include_bytes!("../tests/fixtures/synthetic.pocket");

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
    fn a_changed_payload_byte_trips_the_variant_hash() {
        let package = Package::parse(FIXTURE, false).unwrap();
        let js = package.variant(0).unwrap().section(section::JS).unwrap().unwrap();
        let offset = js.as_ptr() as usize - FIXTURE.as_ptr() as usize;
        let mut evil = FIXTURE.to_vec();
        evil[offset] ^= 0x01;
        // Repair the footer so only the variant identity disagrees.
        let end = evil.len() - 8;
        let footer = fnv1a64(&[&evil[..end]]).to_le_bytes();
        evil[end..].copy_from_slice(&footer);
        assert_eq!(
            Package::parse(&evil, false).unwrap_err(),
            PackageError::HashMismatch
        );
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
        let guest = select_guest(FIXTURE, "psp", 1, &[0x11; 32], false).unwrap();
        assert_eq!(guest.js.last(), Some(&0));
        assert!(!guest.id.is_empty());
        assert!(!guest.plan.is_empty());
        assert!(guest.worker_js.is_empty());
    }

    #[test]
    fn rejects_target_and_host_abi_drift() {
        assert!(matches!(
            select_guest(FIXTURE, "3ds-dev", 8, &[0x11; 32], false),
            Err(GuestError::MissingVariant)
        ));
        assert!(matches!(
            select_guest(FIXTURE, "psp", 8, &[0x11; 32], false),
            Err(GuestError::HostAbiMismatch)
        ));
    }

    #[test]
    fn worker_payload_requires_matching_entry_feature_and_terminated_code() {
        let plan = br#"{"app":{"worker":{"entry":"worker.ts"}},"features":{"runtime.worker":true}}"#;
        assert_eq!(worker_payload(plan, Some(b"turn();\0")), Ok(&b"turn();\0"[..]));
        assert_eq!(worker_payload(plan, None), Err(GuestError::WorkerSectionMismatch));
        assert_eq!(worker_payload(plan, Some(b"\0")), Err(GuestError::JavaScriptNotTerminated));
        assert_eq!(worker_payload(plan, Some(b"turn();")), Err(GuestError::JavaScriptNotTerminated));
        assert_eq!(worker_payload(b"{}", Some(b"turn();\0")), Err(GuestError::WorkerSectionMismatch));
        assert_eq!(worker_payload(br#"{"features":{"runtime.worker":true}}"#, Some(b"turn();\0")), Err(GuestError::WorkerSectionMismatch));
        assert_eq!(worker_payload(br#"{"features":{"runtime.worker":true}}"#, None), Ok(&[][..]));
        assert_eq!(worker_payload(br#"{"app":{"worker":{"entry":"worker.ts"}}}"#, Some(b"turn();\0")), Err(GuestError::Package(PackageError::BadLayout)));
        assert_eq!(worker_payload(b"{}", None), Ok(&[][..]));
    }

    #[test]
    fn admission_refuses_required_worker_without_worker_section() {
        let identity = crate::embedded::identity("worker", "app.worker", "Worker").unwrap();
        let bytes = crate::embedded::encode(crate::embedded::EmbeddedPackage {
            target: "test-worker", host_abi: 7, profile_hash: [0x55; 32],
            identity: &identity,
            plan: br#"{"app":{"worker":{"entry":"worker.ts"}},"features":{"runtime.worker":true}}"#,
            code: b"globalThis.frame=()=>{}", pak: &[],
        }).unwrap();
        assert_eq!(select_guest(&bytes, "test-worker", 7, &[0x55; 32], false).err(),
            Some(GuestError::WorkerSectionMismatch));
    }
}
