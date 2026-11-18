//! Bundle reader — the device side of the bundle format: one compiled
//! application for one host contract. contracts/spec/bundle.ts is the format
//! authority; both implementations read the same committed corpus
//! (tests/fixtures/bundles/), so they cannot drift apart.
//!
//! Zero-copy by design: every accessor returns borrowed slices of the input
//! bytes. A program embeds a `.pkb` verbatim in .rodata and boots a guest out
//! of it — the js section carries its QuickJS NUL terminator (eval with
//! len - 1), the pak section feeds pak::feed as-is.
//!
//! A host that keeps applications in a container of its own states where the
//! same sections lie through `PackageSource::sections`;
//! `crate::source::admit_stated` applies the admission and section checks of
//! [`admit_bundle`] to them.

use core::str;

use crate::admission::{admit_plan, HostFacts, Mismatch, Timing};

use crate::package_format::{
    BUNDLE_ALIGN as ALIGN, BUNDLE_HEADER_SIZE as HEADER_SIZE, BUNDLE_SECTION_SIZE as SECTION_SIZE,
    OFFSET_HEADER_HOST_ABI, OFFSET_HEADER_PAYLOAD_HASH, OFFSET_HEADER_PROFILE_HASH,
    OFFSET_HEADER_RESERVED, OFFSET_HEADER_SECTION_COUNT, OFFSET_SECTION_OFFSET,
    OFFSET_SECTION_SIZE,
};
pub use crate::package_format::{
    BUNDLE_FOOTER_SIZE as FOOTER_SIZE, BUNDLE_MAGIC as MAGIC, BUNDLE_VERSION as VERSION,
};

/// Section kinds (append-only; skip what you do not know).
pub mod section {
    pub use crate::package_format::{
        SECTION_BYTECODE as BYTECODE, SECTION_HOST_INPUTS as HOST_INPUTS, SECTION_ICON as ICON,
        SECTION_IDENTITY as IDENTITY, SECTION_JS as JS, SECTION_PAK as PAK, SECTION_PLAN as PLAN,
        SECTION_WORKER_BYTECODE as WORKER_BYTECODE, SECTION_WORKER_JS as WORKER_JS,
    };
}

/// Why bytes are not a bundle.
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
    /// The host's facts do not admit the plan; the items it fails
    /// (`crate::admission`).
    NotAdmitted(Mismatch),
    MissingIdentity,
    MissingJavaScript,
    JavaScriptNotTerminated,
    /// The plan's `domains.worker` and sections 8 and 9 disagree: a declaration
    /// without a worker bundle, or a bundle without a declaration.
    WorkerSectionMismatch,
    /// Section 6 or 9 is not a bytecode envelope (`crate::bytecode`).
    BadBytecode,
}

impl From<PackageError> for GuestError {
    fn from(value: PackageError) -> Self {
        Self::Package(value)
    }
}

/// A parsed bundle. The header fields are read once; sections are looked up
/// in the table on demand.
#[derive(Debug, Clone, Copy)]
pub struct Bundle<'a> {
    bytes: &'a [u8],
    section_count: usize,
    /// The binding generation the code was compiled for.
    pub host_abi: u32,
    /// FNV-1a64 over the section payloads in table order.
    pub payload_hash: u64,
    /// The footer: FNV-1a64 over every byte before it.
    pub bundle_hash: u64,
    /// The host contract hash the plan was resolved against. Provenance:
    /// admission compares the plan with the host's facts, never this hash.
    pub profile_hash: [u8; 32],
}

pub struct Identity<'a> {
    pub output: &'a str,
    pub id: &'a str,
    pub title: &'a str,
}

/// A program admitted for one host. The bytes must outlive these slices;
/// native runtimes keep them until guest teardown.
#[derive(Clone, Copy, Debug)]
pub struct Guest<'a> {
    /// The application id: the identity section's id in a bundle, the
    /// plan's `app.id` for stated sections.
    pub id: &'a str,
    /// The application rate and the host cadence it runs at.
    pub timing: Timing,
    /// Section 3, the NUL-terminated UI bundle; empty when the program
    /// carries the bundle as bytecode alone.
    pub js: &'a [u8],
    /// Section 8, the NUL-terminated worker bundle of a plan with
    /// `domains.worker`; empty for a plan without one, or one whose worker
    /// bundle is bytecode alone.
    pub worker_js: &'a [u8],
    /// Section 6, the UI bundle as a bytecode envelope (`crate::bytecode`),
    /// when the program carries one.
    pub bytecode: Option<&'a [u8]>,
    /// Section 9, the worker bundle as a bytecode envelope.
    pub worker_bytecode: Option<&'a [u8]>,
    pub pak: &'a [u8],
    pub plan: &'a [u8],
    /// The bundle's footer hash; zero for stated sections.
    pub package_hash: u64,
    /// The bundle's payload hash; zero for stated sections.
    pub payload_hash: u64,
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

impl<'a> Bundle<'a> {
    /// Parse a bundle and verify its footer and payload hashes. `skip_hash`
    /// skips only the FNV checks, for metadata inspection after an
    /// independent integrity check. Runtime admission verifies them unless
    /// the owner of transferred storage did (`PackageSource::verified`).
    pub fn parse(bytes: &'a [u8], skip_hash: bool) -> Result<Self, PackageError> {
        if bytes.len() < HEADER_SIZE + FOOTER_SIZE {
            return Err(PackageError::Truncated);
        }
        if u32_at(bytes, 0)? != MAGIC {
            return Err(PackageError::BadMagic);
        }
        if u32_at(bytes, 4)? != VERSION {
            return Err(PackageError::BadVersion);
        }
        let end = bytes.len() - FOOTER_SIZE;
        let bundle_hash = u64_at(bytes, end)?;
        if !skip_hash && bundle_hash != fnv1a64(&[&bytes[..end]]) {
            return Err(PackageError::HashMismatch);
        }
        if u32_at(bytes, OFFSET_HEADER_RESERVED)? != 0
            || u32_at(bytes, OFFSET_HEADER_RESERVED + 4)? != 0
        {
            return Err(PackageError::BadLayout);
        }
        let section_count = u32_at(bytes, OFFSET_HEADER_SECTION_COUNT)? as usize;
        let table_size = section_count
            .checked_mul(SECTION_SIZE)
            .ok_or(PackageError::Truncated)?;
        let table_end = checked_end(HEADER_SIZE, table_size, end)?;
        // An exact contiguous layout rejects overlaps without comparing
        // every range against every other range.
        let mut next_payload = aligned(table_end)?;
        let mut previous_kind = None;
        let mut hash = FNV_OFFSET;
        for index in 0..section_count {
            let entry = HEADER_SIZE + index * SECTION_SIZE;
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
        let payload_hash = u64_at(bytes, OFFSET_HEADER_PAYLOAD_HASH)?;
        if !skip_hash && hash != payload_hash {
            return Err(PackageError::HashMismatch);
        }
        if next_payload != end {
            return Err(PackageError::BadLayout);
        }
        let mut profile_hash = [0; 32];
        profile_hash
            .copy_from_slice(&bytes[OFFSET_HEADER_PROFILE_HASH..OFFSET_HEADER_PROFILE_HASH + 32]);
        Ok(Bundle {
            bytes,
            section_count,
            host_abi: u32_at(bytes, OFFSET_HEADER_HOST_ABI)?,
            payload_hash,
            bundle_hash,
            profile_hash,
        })
    }

    pub fn section_count(&self) -> usize {
        self.section_count
    }

    /// The kind and payload of the table's `index`th section.
    pub fn section_at(&self, index: usize) -> Result<(u32, &'a [u8]), PackageError> {
        if index >= self.section_count {
            return Err(PackageError::Truncated);
        }
        let entry = HEADER_SIZE + index * SECTION_SIZE;
        let off = u32_at(self.bytes, entry + OFFSET_SECTION_OFFSET)? as usize;
        let len = u32_at(self.bytes, entry + OFFSET_SECTION_SIZE)? as usize;
        let payload = self
            .bytes
            .get(off..checked_end(off, len, self.bytes.len())?)
            .ok_or(PackageError::Truncated)?;
        Ok((u32_at(self.bytes, entry)?, payload))
    }

    /// A section payload by kind. Unknown kinds are data a reader never
    /// asks for, which keeps the table forward compatible.
    pub fn section(&self, kind: u32) -> Result<Option<&'a [u8]>, PackageError> {
        for index in 0..self.section_count {
            let (found, payload) = self.section_at(index)?;
            if found == kind {
                return Ok(Some(payload));
            }
        }
        Ok(None)
    }

    /// The identity section (kind 1): output, id and title, read without
    /// JSON parsing.
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

/// The `GuestError` of a plan the host's facts do not admit.
pub(crate) fn not_admitted((items, capability): (u32, crate::admission::Name)) -> GuestError {
    GuestError::NotAdmitted(Mismatch { items, capability })
}

/// Parse a bundle and admit its plan against the host's facts
/// (`crate::admission`), then check its identity and code sections. This is
/// the boundary filesystem-loading hosts use before exposing any bundle
/// bytes to QuickJS or the retained UI core.
pub fn admit_bundle<'a, S: AsRef<str>>(
    bytes: &'a [u8],
    host: &HostFacts<'_, S>,
    skip_hash: bool,
) -> Result<Guest<'a>, GuestError> {
    let bundle = Bundle::parse(bytes, skip_hash)?;
    let plan = bundle.section(section::PLAN)?;
    let timing = admit_plan(host, bundle.host_abi, plan).map_err(not_admitted)?;
    let identity = bundle.identity()?.ok_or(GuestError::MissingIdentity)?;
    // Admission read this section; it is present and non-empty.
    let plan = plan.unwrap_or(&[]);
    let (js, worker_js, bytecode, worker_bytecode) = guest_sections(
        plan,
        bundle.section(section::JS)?,
        bundle.section(section::BYTECODE)?,
        bundle.section(section::WORKER_JS)?,
        bundle.section(section::WORKER_BYTECODE)?,
    )?;
    let pak = bundle.section(section::PAK)?.unwrap_or(&[]);
    Ok(Guest {
        id: identity.id,
        timing,
        js,
        worker_js,
        bytecode,
        worker_bytecode,
        pak,
        plan,
        package_hash: bundle.bundle_hash,
        payload_hash: bundle.payload_hash,
    })
}

/// The checks every program's code sections pass, whichever container held
/// them: bytecode sections are envelopes, the UI bundle is NUL-terminated or
/// replaced by bytecode, and the worker bundle matches the plan's
/// `domains.worker`. Returns the UI bundle, the worker bundle and the two
/// envelopes; an absent bundle is an empty slice.
#[allow(clippy::type_complexity)]
pub(crate) fn guest_sections<'a>(
    plan: &[u8],
    js: Option<&'a [u8]>,
    bytecode: Option<&'a [u8]>,
    worker_js: Option<&'a [u8]>,
    worker_bytecode: Option<&'a [u8]>,
) -> Result<(&'a [u8], &'a [u8], Option<&'a [u8]>, Option<&'a [u8]>), GuestError> {
    let bytecode = envelope_section(bytecode)?;
    let js = match (js.filter(|value| !value.is_empty()), bytecode) {
        (Some(js), _) if js.last() != Some(&0) => return Err(GuestError::JavaScriptNotTerminated),
        (Some(js), _) => js,
        (None, Some(_)) => &[],
        (None, None) => return Err(GuestError::MissingJavaScript),
    };
    let worker_bytecode = envelope_section(worker_bytecode)?;
    let worker_js = worker_payload(plan, worker_js, worker_bytecode.is_some())?;
    Ok((js, worker_js, bytecode, worker_bytecode))
}

/// A bytecode section, checked to be an envelope.
fn envelope_section(bytes: Option<&[u8]>) -> Result<Option<&[u8]>, GuestError> {
    match bytes {
        Some(bytes) => crate::bytecode::parse(bytes)
            .map(|_| Some(bytes))
            .map_err(|_| GuestError::BadBytecode),
        None => Ok(None),
    }
}

/// The worker bundle a plan with `domains.worker` requires, or an empty slice
/// for a plan without one, or for one whose bundle is bytecode alone
/// (`has_bytecode`). The bundle ends with NUL like the UI JavaScript.
fn worker_payload<'a>(
    plan: &[u8],
    worker: Option<&'a [u8]>,
    has_bytecode: bool,
) -> Result<&'a [u8], GuestError> {
    let declared = crate::plan_facts::worker_declared(plan)
        .map_err(|_| GuestError::Package(PackageError::BadLayout))?;
    match (declared, worker) {
        (false, None) if !has_bytecode => Ok(&[]),
        (true, Some(source)) if source.len() >= 2 && source.last() == Some(&0) => Ok(source),
        (true, Some(_)) => Err(GuestError::JavaScriptNotTerminated),
        (true, None) if has_bytecode => Ok(&[]),
        _ => Err(GuestError::WorkerSectionMismatch),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_malformed_corpus() {
        let directory =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/corpus");
        let mut count = 0;
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|v| v.to_str()) != Some("pkb") {
                continue;
            }
            count += 1;
            let expected = path
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .starts_with("ok-");
            assert_eq!(
                Bundle::parse(&std::fs::read(&path).unwrap(), false).is_ok(),
                expected,
                "{}",
                path.display()
            );
        }
        assert!(count >= 10);
    }

    static FIXTURE: &[u8] = include_bytes!("../tests/fixtures/synthetic.pkb");

    #[test]
    fn bytecode_sections_admit_beside_or_instead_of_source() {
        use crate::admission::testing::{host, PLAN};
        use crate::embedded::{encode_sections, identity};
        let identity = identity("app", "test.app", "App").unwrap();
        let envelope = crate::bytecode::encode(&[0x11; 32], &[25, 7, 7]);
        let js: &[u8] = b"globalThis.frame=()=>{}\0";
        let encode = |sections: &[(u32, &[u8])]| encode_sections(1, [0x11; 32], sections).unwrap();
        let both = encode(&[
            (section::IDENTITY, &identity),
            (section::PLAN, PLAN),
            (section::JS, js),
            (section::PAK, b""),
            (section::BYTECODE, &envelope),
        ]);
        let guest = admit_bundle(&both, &host(1, [0x11; 32]), false).unwrap();
        assert_eq!(guest.js, js);
        assert_eq!(guest.bytecode, Some(&envelope[..]));
        assert_eq!(guest.worker_bytecode, None);
        let alone = encode(&[
            (section::IDENTITY, &identity),
            (section::PLAN, PLAN),
            (section::PAK, b""),
            (section::BYTECODE, &envelope),
        ]);
        let guest = admit_bundle(&alone, &host(1, [0x11; 32]), false).unwrap();
        assert!(guest.js.is_empty());
        assert_eq!(guest.bytecode, Some(&envelope[..]));
        let neither = encode(&[
            (section::IDENTITY, &identity),
            (section::PLAN, PLAN),
            (section::PAK, b""),
        ]);
        assert_eq!(
            admit_bundle(&neither, &host(1, [0x11; 32]), false)
                .err()
                .unwrap(),
            GuestError::MissingJavaScript
        );
        let damaged = encode(&[
            (section::IDENTITY, &identity),
            (section::PLAN, PLAN),
            (section::JS, js),
            (section::BYTECODE, &envelope[..crate::bytecode::HEADER_SIZE]),
        ]);
        assert_eq!(
            admit_bundle(&damaged, &host(1, [0x11; 32]), false)
                .err()
                .unwrap(),
            GuestError::BadBytecode
        );
        // A worker bundle as bytecode needs the plan's declaration, as source does.
        let undeclared = encode(&[
            (section::IDENTITY, &identity),
            (section::PLAN, PLAN),
            (section::JS, js),
            (section::WORKER_BYTECODE, &envelope),
        ]);
        assert_eq!(
            admit_bundle(&undeclared, &host(1, [0x11; 32]), false)
                .err()
                .unwrap(),
            GuestError::WorkerSectionMismatch
        );
    }

    #[test]
    fn tamper_trips_the_footer_hash() {
        let mut evil = FIXTURE.to_vec();
        let n = evil.len();
        evil[n - 20] ^= 0xff;
        assert_eq!(
            Bundle::parse(&evil, false).unwrap_err(),
            PackageError::HashMismatch
        );
        assert!(Bundle::parse(&evil, true).is_ok());
    }

    #[test]
    fn a_changed_payload_byte_trips_the_payload_hash() {
        let bundle = Bundle::parse(FIXTURE, false).unwrap();
        let js = bundle.section(section::JS).unwrap().unwrap();
        let offset = js.as_ptr() as usize - FIXTURE.as_ptr() as usize;
        let mut evil = FIXTURE.to_vec();
        evil[offset] ^= 0x01;
        // Repair the footer so only the payload hash disagrees.
        let end = evil.len() - 8;
        let footer = fnv1a64(&[&evil[..end]]).to_le_bytes();
        evil[end..].copy_from_slice(&footer);
        assert_eq!(
            Bundle::parse(&evil, false).unwrap_err(),
            PackageError::HashMismatch
        );
    }

    #[test]
    fn header_fields_and_sections_read_back() {
        let identity = crate::embedded::identity("app", "test.app", "App").unwrap();
        let bytes = crate::embedded::encode_sections(
            7,
            [0x55; 32],
            &[(section::IDENTITY, &identity), (section::ICON, b"png")],
        )
        .unwrap();
        let bundle = Bundle::parse(&bytes, false).unwrap();
        assert_eq!(bundle.host_abi, 7);
        assert_eq!(bundle.profile_hash, [0x55; 32]);
        assert_eq!(bundle.payload_hash, fnv1a64(&[&identity, b"png"]));
        assert_eq!(bundle.section_count(), 2);
        assert_eq!(bundle.section_at(1).unwrap(), (section::ICON, &b"png"[..]));
        assert_eq!(bundle.section(section::JS).unwrap(), None);
        assert_eq!(bundle.identity().unwrap().unwrap().id, "test.app");
    }

    #[test]
    fn refuses_wrong_magic_and_truncation() {
        assert_eq!(
            Bundle::parse(&[0u8; 8], false).unwrap_err(),
            PackageError::Truncated
        );
        let mut bad = FIXTURE.to_vec();
        bad[0] ^= 0xff;
        assert_eq!(
            Bundle::parse(&bad, false).unwrap_err(),
            PackageError::BadMagic
        );
    }

    use crate::admission::testing::host;
    use crate::admission::{HostFacts, Timing};

    const PLAN: &[u8] = br#"{"animation":"composited","features":{"input.buttons":true},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;

    fn bundle(generation: u32, hash: [u8; 32], plan: &[u8]) -> std::vec::Vec<u8> {
        let identity = crate::embedded::identity("app", "test.app", "App").unwrap();
        crate::embedded::encode(crate::embedded::EmbeddedPackage {
            host_abi: generation,
            profile_hash: hash,
            identity: &identity,
            plan,
            code: b"globalThis.frame=()=>{}",
            pak: &[],
        })
        .unwrap()
    }

    #[test]
    fn admits_a_complete_guest_for_a_satisfying_host() {
        // The host contract hash is provenance: another one still admits.
        let bytes = bundle(12, [0x22; 32], PLAN);
        let guest = admit_bundle(&bytes, &host(12, [0x11; 32]), false).unwrap();
        assert_eq!(guest.js.last(), Some(&0));
        assert_eq!(guest.id, "test.app");
        assert_eq!(guest.plan, PLAN);
        assert!(guest.worker_js.is_empty());
        assert_eq!(
            guest.timing,
            Timing {
                tick_hz: 60,
                cadence_hz: 60
            }
        );
    }

    #[test]
    fn reports_binding_generation_drift() {
        let bytes = bundle(11, [0x11; 32], PLAN);
        match admit_bundle(&bytes, &host(12, [0x11; 32]), false) {
            Err(GuestError::NotAdmitted(mismatch)) => {
                assert_eq!(mismatch.items, crate::admission::item::BINDING_GENERATION)
            }
            other => panic!("{:?}", other.err()),
        }
    }

    #[test]
    fn plans_without_admission_facts_are_not_admitted() {
        match admit_bundle(FIXTURE, &host(1, [0x11; 32]), false) {
            Err(GuestError::NotAdmitted(mismatch)) => {
                assert_eq!(mismatch.items, crate::admission::item::PLAN)
            }
            other => panic!("{:?}", other.err()),
        }
    }

    #[test]
    fn worker_payload_requires_matching_entry_feature_and_terminated_code() {
        let plan =
            br#"{"domains":{"worker":{"entry":"worker.ts"}},"features":{"runtime.worker":true}}"#;
        assert_eq!(
            worker_payload(plan, Some(b"turn();\0"), false),
            Ok(&b"turn();\0"[..])
        );
        assert_eq!(
            worker_payload(plan, None, false),
            Err(GuestError::WorkerSectionMismatch)
        );
        assert_eq!(
            worker_payload(plan, Some(b"\0"), false),
            Err(GuestError::JavaScriptNotTerminated)
        );
        assert_eq!(
            worker_payload(plan, Some(b"turn();"), false),
            Err(GuestError::JavaScriptNotTerminated)
        );
        assert_eq!(
            worker_payload(b"{}", Some(b"turn();\0"), false),
            Err(GuestError::WorkerSectionMismatch)
        );
        assert_eq!(
            worker_payload(
                br#"{"features":{"runtime.worker":true}}"#,
                Some(b"turn();\0"),
                false
            ),
            Err(GuestError::WorkerSectionMismatch)
        );
        assert_eq!(
            worker_payload(br#"{"features":{"runtime.worker":true}}"#, None, false),
            Ok(&[][..])
        );
        assert_eq!(
            worker_payload(
                br#"{"domains":{"worker":{"entry":"worker.ts"}}}"#,
                Some(b"turn();\0"),
                false
            ),
            Err(GuestError::Package(PackageError::BadLayout))
        );
        assert_eq!(worker_payload(b"{}", None, false), Ok(&[][..]));
    }

    #[test]
    fn admission_refuses_required_worker_without_worker_section() {
        let identity = crate::embedded::identity("worker", "app.worker", "Worker").unwrap();
        let bytes = crate::embedded::encode(crate::embedded::EmbeddedPackage {
            host_abi: 7, profile_hash: [0x55; 32],
            identity: &identity,
            plan: br#"{"animation":"composited","domains":{"worker":{"entry":"worker.ts"}},"features":{"runtime.worker":true},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#,
            code: b"globalThis.frame=()=>{}", pak: &[],
        }).unwrap();
        let facts = HostFacts {
            capabilities: &["runtime.worker"],
            ..host(7, [0x55; 32])
        };
        assert_eq!(
            admit_bundle(&bytes, &facts, false).err(),
            Some(GuestError::WorkerSectionMismatch)
        );
    }
}
