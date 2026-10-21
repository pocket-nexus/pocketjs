use super::*;

pub struct CDisplay {
    table: PocketDisplayOutputV1,
    context: *mut c_void,
    descriptor: DisplayDescriptor,
    acquired: bool,
    pending: Option<(u64, u64)>,
    next: u64,
}
impl CDisplay {
    /// # Safety
    /// Callback storage remains live and acquired surfaces obey the exclusive
    /// access and terminal-error promises of the C ABI.
    pub unsafe fn new(
        table: *const PocketDisplayOutputV1,
        context: *mut c_void,
    ) -> Result<Self, AdapterError> {
        let table =
            unsafe { PocketDisplayOutputV1::read_prefix(table) }.ok_or(AdapterError::Invalid)?;
        let callback = table.descriptor.ok_or(AdapterError::Unsupported)?;
        if table.acquire.is_none() || table.flush.is_none() || table.wait.is_none() {
            return Err(AdapterError::Unsupported);
        }
        let mut raw = PocketDisplayDescriptor::empty();
        check(unsafe { callback(context, &mut raw) })?;
        let raw =
            unsafe { PocketDisplayDescriptor::read_prefix(&raw) }.ok_or(AdapterError::Invalid)?;
        let role = match raw.role {
            POCKET_DISPLAY_ROLE_PRIMARY => DisplayRole::Primary,
            POCKET_DISPLAY_ROLE_AUXILIARY => DisplayRole::Auxiliary,
            _ => return Err(AdapterError::Unsupported),
        };
        let format = pixel_format(raw.pixel_format)?;
        if raw.width == 0 || raw.height == 0 {
            return Err(AdapterError::Invalid);
        }
        let own = ownership(raw.target_kind)?;
        if own == TargetOwnership::CpuVisible
            && raw.stride_bytes < format.row_bytes(raw.width).ok_or(AdapterError::Invalid)?
        {
            return Err(AdapterError::Invalid);
        }
        let mut descriptor =
            DisplayDescriptor::new(role, raw.width, raw.height, format, raw.stride_bytes, own);
        descriptor.double_buffered = raw.flags & POCKET_DISPLAY_DOUBLE_BUFFERED != 0;
        descriptor.partial_refresh = raw.flags & POCKET_DISPLAY_PARTIAL_REFRESH != 0;
        descriptor.device_frame_storage = raw.flags & POCKET_DISPLAY_FRAME_STORAGE != 0;
        descriptor.device_rotation = raw.flags & POCKET_DISPLAY_DEVICE_ROTATION != 0;
        descriptor.device_scaling = raw.flags & POCKET_DISPLAY_DEVICE_SCALING != 0;
        macro_rules! positive {
            ($field:ident) => {
                if raw.struct_size
                    < core::mem::offset_of!(PocketDisplayDescriptor, $field)
                        + core::mem::size_of::<u32>()
                {
                    1
                } else if raw.$field == 0 {
                    return Err(AdapterError::Invalid);
                } else {
                    raw.$field
                }
            };
        }
        descriptor.refresh_granularity = [positive!(refresh_width), positive!(refresh_height)];
        descriptor.window_alignment =
            [positive!(window_x_alignment), positive!(window_y_alignment)];
        descriptor.vsync = vsync(raw.vsync_source)?;
        Ok(Self {
            table,
            context,
            descriptor,
            acquired: false,
            pending: None,
            next: 1,
        })
    }
}
impl DisplayOutput for CDisplay {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        self.descriptor
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if self.pending.is_some()
            || region.width == 0
            || region.height == 0
            || region
                .x
                .checked_add(region.width)
                .is_none_or(|v| v > self.descriptor.width)
            || region
                .y
                .checked_add(region.height)
                .is_none_or(|v| v > self.descriptor.height)
        {
            return Err(DisplayError::InvalidTarget);
        }
        let requested = c_rect(region);
        let mut output = PocketTarget::empty();
        check(unsafe { self.table.acquire.unwrap()(self.context, &requested, &mut output) })
            .map_err(display_error)?;
        let output =
            unsafe { PocketTarget::read_prefix(&output) }.ok_or(DisplayError::InvalidTarget)?;
        let acquired = unsafe { rect(output.region) }.map_err(display_error)?;
        if acquired != region
            || pixel_format(output.pixel_format).map_err(display_error)? != self.descriptor.format
            || ownership(output.kind).map_err(display_error)? != self.descriptor.target_ownership
        {
            return Err(DisplayError::InvalidTarget);
        }
        if (output.kind == POCKET_TARGET_CPU_VISIBLE && output.device_handle != 0)
            || (output.kind == POCKET_TARGET_DEVICE_OWNED && !output.surface.is_null())
        {
            return Err(DisplayError::InvalidTarget);
        }
        let target = match output.kind {
            POCKET_TARGET_CPU_VISIBLE => {
                let surface = unsafe { PocketSurface::read_prefix(output.surface) }
                    .ok_or(DisplayError::InvalidTarget)?;
                if unsafe { rect(surface.region) }.map_err(display_error)? != acquired
                    || surface.pixel_format != output.pixel_format
                {
                    return Err(DisplayError::InvalidTarget);
                }
                let bytes = unsafe { writable(surface.pixels, surface.byte_length) }
                    .map_err(display_error)?;
                Target::CpuVisible(Surface::new(
                    bytes,
                    acquired,
                    surface.stride_bytes,
                    self.descriptor.format,
                )?)
            }
            POCKET_TARGET_DEVICE_OWNED => Target::DeviceOwned(DeviceTarget::new(
                output.device_handle,
                acquired,
                self.descriptor.format,
            )),
            _ => return Err(DisplayError::Unsupported),
        };
        self.acquired = true;
        Ok(target)
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<u64, DisplayError> {
        if !self.acquired || self.pending.is_some() {
            return Err(DisplayError::InvalidTarget);
        }
        let id = self.next;
        self.next = self.next.checked_add(1).ok_or(DisplayError::Failed)?;
        let raw: alloc::vec::Vec<_> = regions.iter().copied().map(c_rect).collect();
        let mut native = 0;
        self.acquired = false;
        check(unsafe {
            self.table.flush.unwrap()(self.context, raw.as_ptr(), raw.len(), &mut native)
        })
        .map_err(display_error)?;
        self.pending = Some((id, native));
        Ok(id)
    }
    fn wait(&mut self, token: u64) -> Result<(), DisplayError> {
        let Some((id, native)) = self.pending else {
            return Err(DisplayError::InvalidTarget);
        };
        if id != token {
            return Err(DisplayError::InvalidTarget);
        }
        self.pending = None;
        check(unsafe { self.table.wait.unwrap()(self.context, native) }).map_err(display_error)
    }
    fn vsync(&mut self) -> VsyncSource {
        self.table
            .vsync
            .and_then(|callback| vsync(unsafe { callback(self.context) }).ok())
            .unwrap_or(self.descriptor.vsync)
    }
}
impl Drop for CDisplay {
    fn drop(&mut self) {
        if let Some((_, native)) = self.pending.take() {
            unsafe {
                self.table.wait.unwrap()(self.context, native);
            }
        }
    }
}
