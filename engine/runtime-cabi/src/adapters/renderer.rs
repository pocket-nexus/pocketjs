use super::*;
use alloc::vec::Vec;

struct Pending {
    id: u64,
    native: u64,
    completion: Option<Result<(), RenderError>>,
}
pub struct CRenderer {
    table: PocketRendererV1,
    context: *mut c_void,
    descriptor: RendererDescriptor,
    pending: Vec<Pending>,
    next: u64,
}
impl CRenderer {
    /// # Safety
    /// Driver callbacks remain live, stop work before reporting errors, and
    /// copy ordinary render borrows before returning as the C ABI requires.
    pub unsafe fn new(
        table: *const PocketRendererV1,
        context: *mut c_void,
    ) -> Result<Self, AdapterError> {
        let table = unsafe { PocketRendererV1::read_prefix(table) }.ok_or(AdapterError::Invalid)?;
        let callback = table.descriptor.ok_or(AdapterError::Unsupported)?;
        if table.render.is_none() {
            return Err(AdapterError::Unsupported);
        }
        let mut raw = PocketRendererDescriptor::empty();
        check(unsafe { callback(context, &mut raw) })?;
        let raw =
            unsafe { PocketRendererDescriptor::read_prefix(&raw) }.ok_or(AdapterError::Invalid)?;
        if raw.pixel_format_count > 7
            || raw.zero_copy > 1
            || raw.draw_list_version != pocket_spec::DRAW_LIST_VERSION
        {
            return Err(AdapterError::Unsupported);
        }
        let mut formats = [PixelFormat::Rgb565; 7];
        for (destination, value) in formats
            .iter_mut()
            .zip(unsafe { borrowed(raw.pixel_formats, raw.pixel_format_count) }?)
        {
            *destination = pixel_format(*value)?;
        }
        let synchronization = match raw.synchronization {
            POCKET_SYNC_IMMEDIATE => Synchronization::Immediate,
            POCKET_SYNC_DEFERRED => Synchronization::Deferred,
            _ => return Err(AdapterError::Invalid),
        };
        if synchronization == Synchronization::Deferred
            && (table.wait.is_none() || table.retire.is_none())
        {
            return Err(AdapterError::Unsupported);
        }
        if raw.zero_copy != 0 && (table.render_zero_copy.is_none() || table.wait.is_none()) {
            return Err(AdapterError::Unsupported);
        }
        let descriptor = RendererDescriptor::new(
            &formats[..raw.pixel_format_count],
            ownership(raw.target_kind)?,
            synchronization,
            raw.draw_list_version,
            raw.zero_copy != 0,
        )
        .map_err(|_| AdapterError::Unsupported)?;
        Ok(Self {
            table,
            context,
            descriptor,
            pending: Vec::new(),
            next: 1,
        })
    }
    fn render_inner(
        &mut self,
        frame: &mut FrameInput<'_>,
        zero_copy: bool,
    ) -> Result<u64, RenderError> {
        if !self.descriptor.accepts(&frame.target) {
            return Err(RenderError::Unsupported);
        }
        let id = self.next;
        self.next = self.next.checked_add(1).ok_or(RenderError::Failed)?;
        self.pending
            .try_reserve(1)
            .map_err(|_| RenderError::Failed)?;
        let region = c_rect(frame.target.region());
        let mut surface = PocketSurface::empty();
        let mut target = PocketTarget {
            region: &region,
            pixel_format: frame.target.format() as u32,
            ..PocketTarget::empty()
        };
        match &mut frame.target {
            Target::CpuVisible(value) => {
                surface.region = &region;
                surface.stride_bytes = value.stride_bytes();
                surface.pixel_format = value.format() as u32;
                surface.byte_length = value.pixels().len();
                surface.pixels = value.pixels_mut().as_mut_ptr();
                target.kind = POCKET_TARGET_CPU_VISIBLE;
                target.surface = &mut surface;
            }
            Target::DeviceOwned(value) => {
                target.kind = POCKET_TARGET_DEVICE_OWNED;
                target.device_handle = value.handle;
            }
            _ => return Err(RenderError::Unsupported),
        }
        let list = PocketDrawList {
            words: frame.list.words.as_ptr(),
            word_count: frame.list.words.len(),
            version: pocket_spec::DRAW_LIST_VERSION,
            ..PocketDrawList::empty()
        };
        let bridge = ResourceBridge::new(frame.resources);
        let resources = bridge.header();
        let damage: Vec<_> = frame.damage.iter().copied().map(c_rect).collect();
        let input = PocketFrameInput {
            list: &list,
            resources: &resources,
            damage: damage.as_ptr(),
            damage_count: damage.len(),
            target: &target,
            ..PocketFrameInput::empty()
        };
        let callback = if zero_copy {
            self.table.render_zero_copy
        } else {
            self.table.render
        }
        .ok_or(RenderError::Unsupported)?;
        let mut native = 0;
        check(unsafe { callback(self.context, &input, &mut native) }).map_err(render_error)?;
        // C header wrappers are local to this call. Zero-copy waits here so
        // those wrappers, resource callbacks and payloads all remain borrowed.
        let complete = zero_copy || self.table.wait.is_none();
        let result = if zero_copy {
            check(unsafe { self.table.wait.unwrap()(self.context, native) }).map_err(render_error)
        } else {
            Ok(())
        };
        self.pending.push(Pending {
            id,
            native,
            completion: complete.then_some(result),
        });
        if let Err(error) = result {
            self.retire(id);
            return Err(error);
        }
        Ok(id)
    }
}
impl Renderer for CRenderer {
    type Submission = u64;
    fn descriptor(&self) -> RendererDescriptor {
        self.descriptor
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<u64, RenderError> {
        self.render_inner(frame, false)
    }
    unsafe fn render_zero_copy(&mut self, frame: &mut FrameInput<'_>) -> Result<u64, RenderError> {
        if !self.descriptor.zero_copy() {
            return Err(RenderError::Unsupported);
        }
        self.render_inner(frame, true)
    }
    fn wait(&mut self, id: &u64) -> Result<(), RenderError> {
        let item = self
            .pending
            .iter_mut()
            .find(|item| item.id == *id)
            .ok_or(RenderError::InvalidFrame)?;
        if let Some(result) = item.completion {
            return result;
        }
        let result = self
            .table
            .wait
            .map(|callback| {
                check(unsafe { callback(self.context, item.native) }).map_err(render_error)
            })
            .unwrap_or(Ok(()));
        item.completion = Some(result);
        result
    }
    fn retire(&mut self, id: u64) {
        if let Some(index) = self.pending.iter().position(|item| item.id == id) {
            let _ = self.wait(&id);
            let item = self.pending.remove(index);
            if let Some(callback) = self.table.retire {
                unsafe {
                    callback(self.context, item.native);
                }
            }
        }
    }
}
impl Drop for CRenderer {
    fn drop(&mut self) {
        while let Some(item) = self.pending.last() {
            let id = item.id;
            self.retire(id);
        }
    }
}
