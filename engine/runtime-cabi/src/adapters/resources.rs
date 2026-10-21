use super::*;

/// Borrowed callback-backed views. The caller of new guarantees lookup buffers
/// remain unchanged for the frame borrow, including successive lookups.
pub struct CResources {
    table: PocketRenderResources,
}
impl CResources {
    /// # Safety
    /// The table, context and callback results obey the resource borrow contract.
    pub unsafe fn new(pointer: *const PocketRenderResources) -> Result<Self, AdapterError> {
        let table =
            unsafe { PocketRenderResources::read_prefix(pointer) }.ok_or(AdapterError::Invalid)?;
        if !table.viewport_width.is_finite()
            || !table.viewport_height.is_finite()
            || table.viewport_width <= 0.0
            || table.viewport_height <= 0.0
        {
            return Err(AdapterError::Invalid);
        }
        Ok(Self { table })
    }
}
impl RenderResources for CResources {
    fn viewport(&self) -> (f32, f32) {
        (self.table.viewport_width, self.table.viewport_height)
    }
    fn raster_revision(&self) -> u64 {
        self.table.raster_revision
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        let mut output = PocketTextureView::empty();
        check(unsafe { self.table.texture?(self.table.context, handle, &mut output) }).ok()?;
        let output = unsafe { PocketTextureView::read_prefix(&output) }?;
        if output.linear > 1 {
            return None;
        }
        Some(TexView {
            pixels: unsafe { borrowed(output.pixels, output.byte_length) }.ok()?,
            w: output.width,
            h: output.height,
            psm: output.psm,
            palette: if output.palette_byte_length == 0 {
                None
            } else {
                Some(unsafe { borrowed(output.palette, output.palette_byte_length) }.ok()?)
            },
            linear: output.linear != 0,
        })
    }
    fn font_atlas(&self, slot: u8) -> Option<FontView<'_>> {
        let mut output = PocketFontView::empty();
        check(unsafe { self.table.font_atlas?(self.table.context, slot, &mut output) }).ok()?;
        let output = unsafe { PocketFontView::read_prefix(&output) }?;
        Some(FontView {
            bitmap: unsafe { borrowed(output.bitmap, output.byte_length) }.ok()?,
            cell_w: output.cell_width,
            cell_h: output.cell_height,
            raster_density: output.raster_density.try_into().ok()?,
            glyph_count: output.glyph_count.try_into().ok()?,
        })
    }
    fn texture_revision(&self, handle: i32) -> Option<u64> {
        if let Some(callback) = self.table.texture_revision {
            let mut revision = 0;
            check(unsafe { callback(self.table.context, handle, &mut revision) }).ok()?;
            Some(revision)
        } else {
            self.texture(handle).map(|_| self.table.raster_revision)
        }
    }
    fn font_revision(&self, slot: u8) -> Option<u64> {
        if let Some(callback) = self.table.font_revision {
            let mut revision = 0;
            check(unsafe { callback(self.table.context, slot, &mut revision) }).ok()?;
            Some(revision)
        } else {
            self.font_atlas(slot).map(|_| self.table.raster_revision)
        }
    }
    fn font_texture_width(&self, slot: u8) -> Option<u32> {
        if let Some(callback) = self.table.font_texture_width {
            let mut width = 0;
            check(unsafe { callback(self.table.context, slot, &mut width) }).ok()?;
            Some(width)
        } else {
            let font = self.font_atlas(slot)?;
            font.cell_w.checked_mul(font.raster_density as u32)
        }
    }
}

pub struct ResourceBridge<'a> {
    source: &'a dyn RenderResources,
}
impl<'a> ResourceBridge<'a> {
    pub fn new(source: &'a dyn RenderResources) -> Self {
        Self { source }
    }
    /// This header and all views borrow self. Keep self at a stable address
    /// until the render call (or explicit zero-copy wait) completes.
    pub fn header(&self) -> PocketRenderResources {
        let (viewport_width, viewport_height) = self.source.viewport();
        PocketRenderResources {
            context: (self as *const Self).cast(),
            viewport_width,
            viewport_height,
            raster_revision: self.source.raster_revision(),
            texture: Some(texture),
            font_atlas: Some(font),
            texture_revision: Some(texture_revision),
            font_revision: Some(font_revision),
            font_texture_width: Some(font_width),
            ..PocketRenderResources::empty()
        }
    }
}
unsafe fn bridge<'a>(context: *const c_void) -> Option<&'a ResourceBridge<'a>> {
    unsafe { context.cast::<ResourceBridge<'a>>().as_ref() }
}
unsafe extern "C" fn texture(
    context: *const c_void,
    handle: i32,
    out: *mut PocketTextureView,
) -> i32 {
    let Some(source) = (unsafe { bridge(context) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Some(view) = source.source.texture(handle) else {
        return POCKET_STATUS_INVALID;
    };
    let palette = view.palette.unwrap_or(&[]);
    let output = PocketTextureView {
        pixels: view.pixels.as_ptr(),
        byte_length: view.pixels.len(),
        width: view.w,
        height: view.h,
        psm: view.psm,
        palette: palette.as_ptr(),
        palette_byte_length: palette.len(),
        revision: source
            .source
            .texture_revision(handle)
            .unwrap_or(source.source.raster_revision()),
        linear: u32::from(view.linear),
        ..PocketTextureView::empty()
    };
    if unsafe { output.write_prefix(out) } {
        POCKET_STATUS_OK
    } else {
        POCKET_STATUS_INVALID
    }
}
unsafe extern "C" fn font(context: *const c_void, slot: u8, out: *mut PocketFontView) -> i32 {
    let Some(source) = (unsafe { bridge(context) }) else {
        return POCKET_STATUS_INVALID;
    };
    let Some(view) = source.source.font_atlas(slot) else {
        return POCKET_STATUS_INVALID;
    };
    let output = PocketFontView {
        bitmap: view.bitmap.as_ptr(),
        byte_length: view.bitmap.len(),
        cell_width: view.cell_w,
        cell_height: view.cell_h,
        raster_density: view.raster_density as u32,
        glyph_count: view.glyph_count as u32,
        ..PocketFontView::empty()
    };
    if unsafe { output.write_prefix(out) } {
        POCKET_STATUS_OK
    } else {
        POCKET_STATUS_INVALID
    }
}
unsafe extern "C" fn texture_revision(context: *const c_void, handle: i32, out: *mut u64) -> i32 {
    if out.is_null() {
        return POCKET_STATUS_INVALID;
    }
    let Some(value) =
        (unsafe { bridge(context) }).and_then(|source| source.source.texture_revision(handle))
    else {
        return POCKET_STATUS_INVALID;
    };
    unsafe { out.write(value) };
    POCKET_STATUS_OK
}
unsafe extern "C" fn font_revision(context: *const c_void, slot: u8, out: *mut u64) -> i32 {
    if out.is_null() {
        return POCKET_STATUS_INVALID;
    }
    let Some(value) =
        (unsafe { bridge(context) }).and_then(|source| source.source.font_revision(slot))
    else {
        return POCKET_STATUS_INVALID;
    };
    unsafe { out.write(value) };
    POCKET_STATUS_OK
}
unsafe extern "C" fn font_width(context: *const c_void, slot: u8, out: *mut u32) -> i32 {
    if out.is_null() {
        return POCKET_STATUS_INVALID;
    }
    let Some(value) =
        (unsafe { bridge(context) }).and_then(|source| source.source.font_texture_width(slot))
    else {
        return POCKET_STATUS_INVALID;
    };
    unsafe { out.write(value) };
    POCKET_STATUS_OK
}
