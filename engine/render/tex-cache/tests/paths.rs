//! The forwarding crate keeps every public path and names the same items.

use core::any::TypeId;

#[test]
fn paths_name_the_pocket_render_items() {
    use pocket_render::tex_cache as render;
    assert_eq!(
        TypeId::of::<pocket_tex_cache::TextureKey>(),
        TypeId::of::<render::TextureKey>()
    );
    assert_eq!(
        TypeId::of::<pocket_tex_cache::CacheError<()>>(),
        TypeId::of::<render::CacheError<()>>()
    );
    assert_eq!(
        TypeId::of::<pocket_tex_cache::InUse>(),
        TypeId::of::<render::InUse>()
    );
    assert_eq!(
        TypeId::of::<pocket_tex_cache::TextureCache<u8>>(),
        TypeId::of::<render::TextureCache<u8>>()
    );

    let mut cache = pocket_tex_cache::TextureCache::new(4, 1024);
    let key = pocket_tex_cache::TextureKey {
        handle: 1,
        revision: 1,
    };
    cache
        .get_or_upload(key, 4, Some(7), || Ok::<_, ()>(vec![255u8; 4]), drop)
        .unwrap();
    assert_eq!(cache.resident_bytes(), 4);
    cache.retire(7, drop);
    cache.clear(drop).unwrap();
    assert!(cache.is_empty());
}
