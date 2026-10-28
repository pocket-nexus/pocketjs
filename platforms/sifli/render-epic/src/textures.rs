//! Texture registration and coverage classification, cached by texture
//! revision.
//!
//! A texture reaches hardware through a registration: its native copy from
//! the `.epic` table, matched by source digest, or its portable bytes when
//! the executor reads them. Native copies belong to the program and outlive
//! the renderer. Portable registrations read the core's storage, so a frame
//! that uses one completes before `render` returns, and a moved storage
//! address registers again.

use alloc::vec::Vec;

use pocket_drivers::{RenderResources, TexView};
use pocket_spec as spec;
use pocket_tex_cache::{CacheError, TextureCache, TextureKey};

use crate::executor::{ExecError, Executor, TextureFormat, TextureSource};
use crate::native::{source_digest, NativeTable};

/// Textures without a hardware source, and coverage classes, remembered.
const MEMO_ENTRIES: usize = 64;

#[derive(Clone, Copy)]
struct Registered {
    id: u32,
    /// The core storage a portable registration reads.
    portable: Option<usize>,
}

/// A texture commands may reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Resolved {
    pub id: u32,
    pub portable: bool,
}

pub(crate) struct Textures {
    native: Option<NativeTable<'static>>,
    cache: TextureCache<Registered>,
    missing: Vec<TextureKey>,
    coverage: Vec<(TextureKey, bool)>,
    released: Vec<u32>,
}

impl Textures {
    pub fn new(native: Option<NativeTable<'static>>, max_textures: usize) -> Self {
        Self {
            native,
            cache: TextureCache::new(max_textures, usize::MAX),
            missing: Vec::new(),
            coverage: Vec::new(),
            released: Vec::new(),
        }
    }

    /// The registration commands of `submission` use for `handle`,
    /// registering it on first use. `Ok(None)` keeps the texture on the CPU.
    pub fn resolve<E: Executor>(
        &mut self,
        executor: &mut E,
        res: &dyn RenderResources,
        handle: i32,
        view: &TexView<'_>,
        submission: u64,
    ) -> Result<Option<Resolved>, ExecError> {
        let Some(revision) = res.texture_revision(handle) else {
            return Ok(None);
        };
        let key = TextureKey { handle, revision };
        let storage = view.pixels.as_ptr() as usize;
        if let Some(entry) = self.cache.get(key).copied() {
            if entry.portable.is_none_or(|address| address == storage) {
                self.cache.retain(key, submission);
                return Ok(Some(Resolved {
                    id: entry.id,
                    portable: entry.portable.is_some(),
                }));
            }
            self.cache.invalidate(key);
        }
        if self.missing.contains(&key) {
            return Ok(None);
        }
        let native = source_digest(view).and_then(|digest| self.native?.find(digest));
        let source = match native {
            Some(native) => TextureSource {
                format: TextureFormat::Native(native.format),
                width: native.width,
                height: native.height,
                pixels: native.pixels,
                palette: native.palette,
            },
            None if executor.caps().portable_textures && portable_layout(view) => TextureSource {
                format: TextureFormat::Portable(view.psm),
                width: view.w,
                height: view.h,
                pixels: view.pixels,
                palette: view.palette,
            },
            None => {
                remember(&mut self.missing, key);
                return Ok(None);
            }
        };
        let portable = native.is_none().then_some(storage);
        let bytes = source.pixels.len() + source.palette.map_or(0, <[u8]>::len);
        let Self {
            cache, released, ..
        } = self;
        let result = cache
            .get_or_upload(
                key,
                bytes,
                Some(submission),
                // SAFETY: native copies outlive the renderer; a frame that
                // references a portable registration completes before
                // `render` returns, while the core storage is borrowed.
                || {
                    unsafe { executor.register_texture(&source) }
                        .map(|id| Registered { id, portable })
                },
                |entry: Registered| released.push(entry.id),
            )
            .map(|entry| entry.id);
        let result = match result {
            Ok(id) => Ok(Some(Resolved {
                id,
                portable: portable.is_some(),
            })),
            Err(CacheError::Upload(ExecError::Unsupported)) => {
                remember(&mut self.missing, key);
                Ok(None)
            }
            Err(CacheError::Upload(ExecError::Failed)) => Err(ExecError::Failed),
            Err(CacheError::Capacity) => Ok(None),
        };
        self.release_pending(executor);
        result
    }

    /// Drop the references of a submission whose commands completed.
    pub fn retire<E: Executor>(&mut self, executor: &mut E, submission: u64) {
        let Self {
            cache, released, ..
        } = self;
        cache.retire(submission, |entry| released.push(entry.id));
        self.release_pending(executor);
    }

    /// Release every registration. Call only with no submission in flight.
    pub fn clear<E: Executor>(&mut self, executor: &mut E) {
        let Self {
            cache, released, ..
        } = self;
        cache.invalidate_all();
        cache.collect(|entry| released.push(entry.id));
        self.release_pending(executor);
        self.missing.clear();
        self.coverage.clear();
    }

    /// True when every texel is white RGB or, under nearest sampling, fully
    /// transparent: the texture carries only coverage and blends as an A8
    /// mask tinted by the modulate color.
    pub fn coverage_only(&mut self, res: &dyn RenderResources, handle: i32) -> bool {
        let Some(view) = res.texture(handle) else {
            return false;
        };
        let Some(revision) = res.texture_revision(handle) else {
            return classify(&view);
        };
        let key = TextureKey { handle, revision };
        if let Some(&(_, class)) = self.coverage.iter().find(|(cached, _)| *cached == key) {
            return class;
        }
        let class = classify(&view);
        if self.coverage.len() == MEMO_ENTRIES {
            self.coverage.remove(0);
        }
        self.coverage.push((key, class));
        class
    }

    fn release_pending<E: Executor>(&mut self, executor: &mut E) {
        for id in self.released.drain(..) {
            executor.release_texture(id);
        }
    }
}

fn remember(memo: &mut Vec<TextureKey>, key: TextureKey) {
    if memo.len() == MEMO_ENTRIES {
        memo.remove(0);
    }
    memo.push(key);
}

fn portable_layout(view: &TexView<'_>) -> bool {
    match view.psm {
        spec::psm::PSM_5650 | spec::psm::PSM_4444 | spec::psm::PSM_8888 => true,
        spec::psm::PSM_T8 => view.palette.is_some(),
        _ => false,
    }
}

fn classify(view: &TexView<'_>) -> bool {
    let count = view.w as usize * view.h as usize;
    let white_or_clear =
        |r: u8, g: u8, b: u8, a: u8| (r == 255 && g == 255 && b == 255) || (!view.linear && a == 0);
    match view.psm {
        spec::psm::PSM_8888 => view.pixels.get(..count * 4).is_some_and(|pixels| {
            pixels
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| white_or_clear(p[0], p[1], p[2], p[3]))
        }),
        spec::psm::PSM_4444 => view.pixels.get(..count * 2).is_some_and(|pixels| {
            pixels.as_chunks::<2>().0.iter().all(|p| {
                let pixel = u16::from_le_bytes([p[0], p[1]]);
                pixel & 0x0fff == 0x0fff || (!view.linear && pixel >> 12 == 0)
            })
        }),
        spec::psm::PSM_T8 => {
            let Some(palette) = view.palette else {
                return false;
            };
            let entry = |index: usize| {
                let p = &palette[index * 4..index * 4 + 4];
                white_or_clear(p[0], p[1], p[2], p[3])
            };
            // A palette of white entries makes every pixel white without a
            // pixel scan.
            (0..256).all(entry)
                || view
                    .pixels
                    .get(..count)
                    .is_some_and(|pixels| pixels.iter().all(|&index| entry(index as usize)))
        }
        _ => false,
    }
}
