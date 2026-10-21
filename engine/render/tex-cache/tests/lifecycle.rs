use pocket_tex_cache::{CacheError, InUse, TextureCache, TextureKey};
use std::cell::Cell;

fn key(handle: i32, revision: u64) -> TextureKey {
    TextureKey { handle, revision }
}

#[test]
fn delayed_displays_retire_out_of_order_without_releasing_shared_versions() {
    let mut cache = TextureCache::new(3, 30);
    let mut freed = Vec::new();
    cache
        .get_or_upload(
            key(7, 1),
            10,
            Some(101),
            || Ok::<_, ()>(11),
            |t| freed.push(t),
        )
        .unwrap();
    cache.retain(key(7, 1), 202).unwrap();
    cache.retain(key(7, 1), 202).unwrap();
    cache
        .get_or_upload(
            key(7, 2),
            10,
            Some(303),
            || Ok::<_, ()>(12),
            |t| freed.push(t),
        )
        .unwrap();
    assert!(cache.get(key(7, 1)).is_none());
    assert_eq!(cache.resident_bytes(), 20);
    cache.retire(303, |t| freed.push(t));
    cache.retire(202, |t| freed.push(t));
    assert!(freed.is_empty());
    assert_eq!(cache.clear(|t| freed.push(t)), Err(InUse));
    cache.retire(101, |t| freed.push(t));
    assert_eq!(freed, [11]);
    cache.clear(|t| freed.push(t)).unwrap();
    assert_eq!(freed, [11, 12]);
}

#[test]
fn upload_failure_does_not_evict_or_invalidate_previous_version() {
    let mut cache = TextureCache::new(1, 10);
    let mut freed = Vec::new();
    cache
        .get_or_upload(key(7, 1), 10, None, || Ok::<_, &str>(11), |t| freed.push(t))
        .unwrap();
    assert_eq!(
        cache.get_or_upload(
            key(7, 2),
            10,
            None,
            || Err("device lost"),
            |t| freed.push(t)
        ),
        Err(CacheError::Upload("device lost"))
    );
    assert_eq!(cache.get(key(7, 1)), Some(&11));
    assert!(freed.is_empty());
    cache
        .get_or_upload(key(7, 2), 10, None, || Ok::<_, &str>(12), |t| freed.push(t))
        .unwrap();
    assert_eq!(freed, [11]);
    assert_eq!(cache.len(), 1);
}

#[test]
fn nonterminal_native_poll_keeps_submission_pinned_and_pressure_does_not_upload() {
    let mut cache = TextureCache::new(1, 10);
    let uploads = Cell::new(0);
    let mut freed = Vec::new();
    cache
        .get_or_upload(
            key(1, 1),
            10,
            Some(9),
            || Ok::<_, ()>(11),
            |t| freed.push(t),
        )
        .unwrap();
    // A native poll failed without stopping GPU reads. This is not the
    // terminal Renderer/DisplayOutput wait contract, so it does not retire 9.
    let completion: Result<bool, ()> = Err(());
    if completion == Ok(true) {
        cache.retire(9, |t| freed.push(t));
    }
    cache.invalidate_all();
    cache.collect(|t| freed.push(t));
    assert_eq!(
        cache.get_or_upload(
            key(1, 2),
            10,
            Some(10),
            || {
                uploads.set(uploads.get() + 1);
                Ok::<_, ()>(12)
            },
            |t| freed.push(t)
        ),
        Err(CacheError::Capacity)
    );
    assert_eq!(uploads.get(), 0);
    assert!(freed.is_empty());
    cache.retire(9, |t| freed.push(t));
    assert_eq!(freed, [11]);
    cache
        .get_or_upload(
            key(1, 2),
            10,
            Some(10),
            || Ok::<_, ()>(12),
            |t| freed.push(t),
        )
        .unwrap();
}

#[test]
fn invalidating_same_key_keeps_older_instance_until_its_submission_retires() {
    let mut cache = TextureCache::new(2, 20);
    let mut freed = Vec::new();
    cache
        .get_or_upload(
            key(1, 1),
            10,
            Some(1),
            || Ok::<_, ()>(11),
            |t| freed.push(t),
        )
        .unwrap();
    cache.invalidate(key(1, 1));
    cache
        .get_or_upload(
            key(1, 1),
            10,
            Some(2),
            || Ok::<_, ()>(12),
            |t| freed.push(t),
        )
        .unwrap();
    cache.retire(1, |t| freed.push(t));
    assert_eq!(freed, [11]);
    assert_eq!(cache.get(key(1, 1)), Some(&12));
    cache.invalidate_all();
    cache.retire(2, |t| freed.push(t));
    assert_eq!(freed, [11, 12]);
    assert!(cache.is_empty());
}

#[test]
fn lru_evicts_only_idle_entries_and_enforces_byte_budget() {
    let mut cache = TextureCache::new(3, 20);
    let mut freed = Vec::new();
    for handle in 1..=2 {
        cache
            .get_or_upload(
                key(handle, 1),
                10,
                None,
                || Ok::<_, ()>(handle),
                |t| freed.push(t),
            )
            .unwrap();
    }
    cache.retain(key(1, 1), 5).unwrap();
    cache.retire(5, |t| freed.push(t));
    cache
        .get_or_upload(key(3, 1), 10, None, || Ok::<_, ()>(3), |t| freed.push(t))
        .unwrap();
    assert_eq!(freed, [2]);
    assert_eq!(cache.resident_bytes(), 20);
    assert_eq!(
        cache.get_or_upload(key(4, 1), 21, None, || Ok::<_, ()>(4), |t| freed.push(t)),
        Err(CacheError::Capacity)
    );
    assert_eq!(cache.len(), 2);
}
