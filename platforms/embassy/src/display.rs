//! A canonical CPU DisplayOutput paired with an asynchronous transport.
use alloc::{rc::Rc, vec::Vec};
use core::cell::RefCell;
use pocket_drivers::{
    BufferIdentity, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, PixelFormat, Rect,
    Surface, Target, TargetOwnership, VsyncSource,
};

/// Bytes produced by the registered renderer. The transport owns wire conversion.
pub struct Frame<'a> {
    pub descriptor: DisplayDescriptor,
    pub pixels: &'a [u8],
    pub regions: &'a [Rect],
}
#[allow(async_fn_in_trait)]
pub trait Transport {
    type Error;
    /// Return or cancel only after hardware stops borrowing the frame's bytes.
    async fn write(&mut self, frame: Frame<'_>) -> Result<(), Self::Error>;
}
struct Buffer {
    pixels: Vec<u8>,
    regions: Vec<Rect>,
}
enum Handoff {
    Drawing,
    Prepared { buffer: Buffer, token: u64 },
    Queued(Buffer),
    InFlight,
    Returned(Buffer),
}
struct Shared {
    state: Handoff,
    generation: u64,
}
/// Registered with Runtime::add_display and rendered through the normal coordinator.
pub struct BufferedDisplay {
    descriptor: DisplayDescriptor,
    buffer: Option<Buffer>,
    shared: Rc<RefCell<Shared>>,
    sequence: u64,
}
/// Kept by the program. Drain after boot/present/tick, before the next runtime turn.
pub struct Presenter {
    descriptor: DisplayDescriptor,
    shared: Rc<RefCell<Shared>>,
}
impl BufferedDisplay {
    pub fn new(
        role: DisplayRole,
        width: u32,
        height: u32,
        format: PixelFormat,
        budget: usize,
    ) -> Result<(Self, Presenter), DisplayError> {
        if width == 0
            || height == 0
            || !matches!(
                format,
                PixelFormat::Rgb565 | PixelFormat::Rgba8888 | PixelFormat::Argb8888
            )
        {
            return Err(DisplayError::Unsupported);
        }
        let stride = format.row_bytes(width).ok_or(DisplayError::InvalidTarget)?;
        let length = stride
            .checked_mul(height as usize)
            .filter(|bytes| *bytes <= budget)
            .ok_or(DisplayError::InvalidTarget)?;
        let mut pixels = Vec::new();
        pixels
            .try_reserve_exact(length)
            .map_err(|_| DisplayError::Failed)?;
        pixels.resize(length, 0);
        let mut descriptor = DisplayDescriptor::new(
            role,
            width,
            height,
            format,
            stride,
            TargetOwnership::CpuVisible,
        );
        descriptor.partial_refresh = true;
        descriptor.vsync = VsyncSource::Timer;
        let shared = Rc::new(RefCell::new(Shared {
            state: Handoff::Drawing,
            generation: 0,
        }));
        let output = Self {
            descriptor,
            buffer: Some(Buffer {
                pixels,
                regions: Vec::new(),
            }),
            shared: shared.clone(),
            sequence: 0,
        };
        Ok((output, Presenter { descriptor, shared }))
    }
}
impl DisplayOutput for BufferedDisplay {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        self.descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        let shared = self.shared.borrow();
        if !matches!(shared.state, Handoff::Drawing | Handoff::Returned(_)) {
            return Err(DisplayError::InvalidTarget);
        }
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: shared.generation,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        if region.width == 0
            || region.height == 0
            || region
                .x
                .checked_add(region.width)
                .is_none_or(|end| end > self.descriptor.width)
            || region
                .y
                .checked_add(region.height)
                .is_none_or(|end| end > self.descriptor.height)
        {
            return Err(DisplayError::InvalidTarget);
        }
        if self.buffer.is_none() {
            let mut shared = self.shared.borrow_mut();
            match core::mem::replace(&mut shared.state, Handoff::Drawing) {
                Handoff::Returned(buffer) => self.buffer = Some(buffer),
                previous => {
                    shared.state = previous;
                    return Err(DisplayError::InvalidTarget);
                }
            }
        }
        let buffer = self.buffer.as_mut().ok_or(DisplayError::InvalidTarget)?;
        let offset = region.y as usize * self.descriptor.stride_bytes
            + self
                .descriptor
                .format
                .row_bytes(region.x)
                .ok_or(DisplayError::InvalidTarget)?;
        Ok(Target::CpuVisible(Surface::new(
            &mut buffer.pixels[offset..],
            region,
            self.descriptor.stride_bytes,
            self.descriptor.format,
        )?))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<u64, DisplayError> {
        if regions.iter().any(|region| {
            region.width == 0
                || region.height == 0
                || region
                    .x
                    .checked_add(region.width)
                    .is_none_or(|end| end > self.descriptor.width)
                || region
                    .y
                    .checked_add(region.height)
                    .is_none_or(|end| end > self.descriptor.height)
        }) {
            return Err(DisplayError::InvalidTarget);
        }
        let buffer = self.buffer.as_mut().ok_or(DisplayError::InvalidTarget)?;
        buffer.regions.clear();
        buffer.regions.extend_from_slice(regions);
        self.sequence = self.sequence.wrapping_add(1);
        self.shared.borrow_mut().state = Handoff::Prepared {
            buffer: self.buffer.take().expect("output owns the drawn buffer"),
            token: self.sequence,
        };
        // wait publishes CPU work; no hardware reads the buffer in this driver.
        Ok(self.sequence)
    }
    fn wait(&mut self, token: u64) -> Result<(), DisplayError> {
        let mut shared = self.shared.borrow_mut();
        match core::mem::replace(&mut shared.state, Handoff::Drawing) {
            Handoff::Prepared {
                buffer,
                token: expected,
            } if token == expected => {
                shared.state = Handoff::Queued(buffer);
                Ok(())
            }
            previous => {
                shared.state = previous;
                Err(DisplayError::InvalidTarget)
            }
        }
    }
    fn vsync(&mut self) -> VsyncSource {
        self.descriptor.vsync
    }
}
struct Transfer {
    shared: Rc<RefCell<Shared>>,
    buffer: Option<Buffer>,
    complete: bool,
}
impl Drop for Transfer {
    fn drop(&mut self) {
        let mut shared = self.shared.borrow_mut();
        shared.state = Handoff::Returned(self.buffer.take().expect("transfer owns its buffer"));
        if !self.complete {
            shared.generation = shared.generation.wrapping_add(1);
        }
    }
}
impl Presenter {
    /// Invalidate retained pixels after a panel reset or a program-owned overlay.
    pub fn invalidate(&mut self) {
        let mut shared = self.shared.borrow_mut();
        shared.generation = shared.generation.wrapping_add(1);
        if let Handoff::Queued(buffer) = &mut shared.state {
            buffer.regions.clear();
            buffer.regions.push(Rect::new(
                0,
                0,
                self.descriptor.width,
                self.descriptor.height,
            ));
        }
    }
    /// Submit the published CPU frame. Cancellation returns the allocation and
    /// changes its identity so the coordinator repaints the complete next frame.
    pub async fn present<T: Transport>(&mut self, transport: &mut T) -> Result<(), T::Error> {
        let buffer = {
            let mut shared = self.shared.borrow_mut();
            match core::mem::replace(&mut shared.state, Handoff::InFlight) {
                Handoff::Queued(buffer) => buffer,
                previous => {
                    shared.state = previous;
                    return Ok(());
                }
            }
        };
        let mut transfer = Transfer {
            shared: self.shared.clone(),
            buffer: Some(buffer),
            complete: false,
        };
        let buffer = transfer.buffer.as_ref().unwrap();
        transport
            .write(Frame {
                descriptor: self.descriptor,
                pixels: &buffer.pixels,
                regions: &buffer.regions,
            })
            .await?;
        transfer.complete = true;
        Ok(())
    }
}
