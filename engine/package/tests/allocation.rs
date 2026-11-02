//! Bound package-sized allocations: memory sources must not add a second
//! container, and raw embedding must not allocate a script-sized scratch copy.
use pocket_package::{
    embedded::{encode, identity, EmbeddedPackage},
    source::{LoadedPackage, OwnedMemorySource, StaticMemorySource},
    HostFacts,
};
use std::{
    alloc::{GlobalAlloc, Layout, System},
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};

struct Allocator;
static COUNTING: AtomicBool = AtomicBool::new(false);
static LARGE_ALLOCATIONS: AtomicUsize = AtomicUsize::new(0);
fn record(size: usize) {
    if size >= 128 * 1024 && COUNTING.load(Ordering::Relaxed) {
        LARGE_ALLOCATIONS.fetch_add(1, Ordering::Relaxed);
    }
}
unsafe impl GlobalAlloc for Allocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc(layout) }
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        record(layout.size());
        unsafe { System.alloc_zeroed(layout) }
    }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
        unsafe { System.dealloc(pointer, layout) }
    }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        record(size);
        unsafe { System.realloc(pointer, layout, size) }
    }
}
#[global_allocator]
static ALLOCATOR: Allocator = Allocator;
fn count<T>(operation: impl FnOnce() -> T) -> (T, usize) {
    struct Stop;
    impl Drop for Stop {
        fn drop(&mut self) {
            COUNTING.store(false, Ordering::Relaxed);
        }
    }
    LARGE_ALLOCATIONS.store(0, Ordering::Relaxed);
    COUNTING.store(true, Ordering::Relaxed);
    let stop = Stop;
    let result = operation();
    drop(stop);
    (result, LARGE_ALLOCATIONS.load(Ordering::Relaxed))
}

const PLAN: &[u8] = br#"{"animation":"composited","features":{},"profile":{"tickHz":60},"viewport":{"logical":[480,272],"presentation":"native","rasterDensity":1}}"#;
const HOST: HostFacts<'static, &'static str> = HostFacts {
    binding_generation: 12,
    profile_hash: [0x11; 32],
    raster_density: 1,
    animation: Some("composited"),
    cadences: &[60],
    logical_viewports: &[[480, 272]],
    dynamic_viewport: None,
    presentations: Some(&["native"]),
    capabilities: &[],
    auxiliary_logical: &[],
};

#[test]
fn large_embedded_package_uses_one_container_and_transfers_it_without_copying() {
    let identity = identity("large", "test.large", "Large package").unwrap();
    let code = vec![b' '; 200 * 1024];
    let pak = vec![0xab; 1024 * 1024];
    let (bytes, allocations) = count(|| {
        encode(EmbeddedPackage {
            target: "fixture",
            host_abi: 12,
            profile_hash: [0x11; 32],
            identity: &identity,
            plan: PLAN,
            code: &code,
            pak: &pak,
        })
        .unwrap()
    });
    assert_eq!(
        allocations, 1,
        "only the final encoded container may be allocated"
    );
    let address = bytes.as_ptr();
    let (loaded, allocations) = count(|| {
        LoadedPackage::load(&mut OwnedMemorySource::new(bytes), &HOST, usize::MAX).unwrap()
    });
    assert_eq!(
        allocations, 0,
        "admission must consume the source allocation"
    );
    assert_eq!(loaded.bytes().as_ptr(), address);
    assert_eq!(loaded.pak(), pak);
    assert_eq!(loaded.javascript().len(), code.len() + 1);
    assert_eq!(loaded.javascript().last(), Some(&0));

    // A static image follows the same parser; retaining it cannot allocate a
    // package-sized buffer. The leak is confined to this test process.
    let bytes: &'static [u8] = Box::leak(loaded.bytes().to_vec().into_boxed_slice());
    let (loaded, allocations) =
        count(|| LoadedPackage::load(&mut StaticMemorySource(bytes), &HOST, usize::MAX).unwrap());
    assert_eq!(allocations, 0);
    assert_eq!(loaded.bytes().as_ptr(), bytes.as_ptr());

    // Foreign storage a program keeps alive is read in place as well. The
    // check shares this test's counting window: the counter is global.
    use pocket_drivers::{PackageBytes, PackageSource, PackageStorage, SourceError};
    struct Leased(&'static [u8]);
    impl PackageStorage for Leased {
        fn bytes(&self) -> &[u8] {
            self.0
        }
    }
    struct Source(&'static [u8]);
    impl PackageSource for Source {
        fn length(&self) -> Result<usize, SourceError> {
            Ok(self.0.len())
        }
        fn take_bytes(&mut self) -> Result<PackageBytes, SourceError> {
            Ok(PackageBytes::Foreign(Box::new(Leased(self.0))))
        }
        fn range(&mut self, _: usize, _: &mut [u8]) -> Result<usize, SourceError> {
            panic!("must not fall back after transfer")
        }
    }
    let (loaded, allocations) =
        count(|| LoadedPackage::load(&mut Source(bytes), &HOST, usize::MAX).unwrap());
    assert_eq!(allocations, 0, "transferred storage is read in place");
    assert_eq!(loaded.bytes().as_ptr(), bytes.as_ptr());
}
