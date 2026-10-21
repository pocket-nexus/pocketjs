use super::{Display, Scanout};
use drm::{
    buffer::{Buffer, DrmFourcc},
    control::{
        connector, crtc, dumbbuffer::DumbBuffer, framebuffer, Device as ControlDevice, Event,
        PageFlipFlags,
    },
    Device,
};
use pocket_drivers::Rect;
use std::{
    fs::{File, OpenOptions},
    io,
    os::fd::{AsFd, AsRawFd, BorrowedFd},
    path::Path,
    time::{Duration, Instant},
};
struct Card(File);
impl AsFd for Card {
    fn as_fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
}
impl Device for Card {}
impl ControlDevice for Card {}
struct BufferPair {
    dumb: DumbBuffer,
    fb: framebuffer::Handle,
}
pub struct NativeScanout {
    card: Option<Card>,
    buffers: Vec<BufferPair>,
    old: crtc::Info,
    connectors: Vec<connector::Handle>,
    size: [u32; 2],
    pending: bool,
}
impl NativeScanout {
    fn create(card: Card, size: [u32; 2]) -> io::Result<Self> {
        let resources = card.resource_handles()?;
        let mut selected = None;
        for handle in resources.connectors() {
            let connector = card.get_connector(*handle, true)?;
            if connector.state() != connector::State::Connected {
                continue;
            }
            let Some(mode) = connector.modes().iter().copied().find(|m| {
                let (w, h) = m.size();
                [u32::from(w), u32::from(h)] == size
            }) else {
                continue;
            };
            for encoder in connector.encoders() {
                let encoder = card.get_encoder(*encoder)?;
                if let Some(crtc) = encoder.crtc().or_else(|| {
                    resources
                        .filter_crtcs(encoder.possible_crtcs())
                        .first()
                        .copied()
                }) {
                    selected = Some((*handle, crtc, mode));
                    break;
                }
            }
            if selected.is_some() {
                break;
            }
        }
        let (connector, crtc, mode) = selected.ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::NotFound,
                "no connected DRM mode matches the profile",
            )
        })?;
        let old = card.get_crtc(crtc)?;
        let mut old_connectors = Vec::new();
        for handle in resources.connectors() {
            let c = card.get_connector(*handle, true)?;
            if c.current_encoder()
                .and_then(|e| card.get_encoder(e).ok())
                .and_then(|e| e.crtc())
                == Some(crtc)
            {
                old_connectors.push(*handle);
            }
        }
        let mut output = Self {
            card: Some(card),
            buffers: Vec::new(),
            old,
            connectors: old_connectors,
            size,
            pending: false,
        };
        for _ in 0..2 {
            let card = output.card.as_ref().unwrap();
            let mut dumb = card.create_dumb_buffer((size[0], size[1]), DrmFourcc::Xrgb8888, 32)?;
            let fb = match card.add_framebuffer(&dumb, 24, 32) {
                Ok(fb) => fb,
                Err(error) => {
                    let _ = card.destroy_dumb_buffer(dumb);
                    return Err(error);
                }
            };
            // Register ownership before another ioctl can fail.
            output.buffers.push(BufferPair { dumb, fb });
            dumb = output.buffers.last().unwrap().dumb;
            card.map_dumb_buffer(&mut dumb)?.fill(0);
        }
        output.card.as_ref().unwrap().set_crtc(
            crtc,
            Some(output.buffers[0].fb),
            (0, 0),
            &[connector],
            Some(mode),
        )?;
        Ok(output)
    }
}
impl Scanout for NativeScanout {
    fn present(&mut self, slot: usize, pixels: &[u8], damage: &[Rect]) -> io::Result<()> {
        if self.pending {
            return Err(io::Error::other("page flip already pending"));
        }
        let card = self
            .card
            .as_ref()
            .ok_or_else(|| io::Error::other("display stopped"))?;
        let pair = self
            .buffers
            .get_mut(slot)
            .ok_or_else(|| io::Error::other("unknown scanout slot"))?;
        let pitch = pair.dumb.pitch() as usize;
        let source_pitch = self.size[0] as usize * 4;
        {
            let mut mapping = card.map_dumb_buffer(&mut pair.dumb)?;
            for r in damage {
                for y in r.y..r.y + r.height {
                    let source = y as usize * source_pitch + r.x as usize * 4;
                    let dest = y as usize * pitch + r.x as usize * 4;
                    let len = r.width as usize * 4;
                    mapping[dest..dest + len].copy_from_slice(&pixels[source..source + len]);
                }
            }
        }
        card.page_flip(self.old.handle(), pair.fb, PageFlipFlags::EVENT, None)?;
        self.pending = true;
        Ok(())
    }
    fn wait(&mut self) -> io::Result<()> {
        let card = self
            .card
            .as_ref()
            .ok_or_else(|| io::Error::other("display stopped"))?;
        if !self.pending {
            return Err(io::Error::other("no pending page flip"));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "DRM page flip did not complete",
                ));
            }
            let mut descriptor = libc::pollfd {
                fd: card.0.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            let ready = unsafe {
                libc::poll(
                    &mut descriptor,
                    1,
                    remaining.as_millis().min(i32::MAX as u128) as i32,
                )
            };
            if ready < 0 {
                let e = io::Error::last_os_error();
                if e.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(e);
            }
            if ready == 0 {
                continue;
            }
            if descriptor.revents & (libc::POLLERR | libc::POLLHUP | libc::POLLNVAL) != 0 {
                return Err(io::Error::other("DRM disconnected"));
            }
            for event in card.receive_events()? {
                if matches!(event,Event::PageFlip(event) if event.crtc==self.old.handle()) {
                    self.pending = false;
                    return Ok(());
                }
            }
        }
    }
    fn stop(&mut self) {
        let Some(card) = self.card.take() else {
            return;
        };
        // Restore or disable scanout before dropping our handles. If both fail
        // (e.g. unplug), KMS retains kernel references to any scanned-out BO.
        // Neither BO ever aliases the runtime's CPU staging allocations.
        if card
            .set_crtc(
                self.old.handle(),
                self.old.framebuffer(),
                self.old.position(),
                &self.connectors,
                self.old.mode(),
            )
            .is_err()
        {
            let _ = card.set_crtc(self.old.handle(), None, (0, 0), &[], None);
        }
        for pair in self.buffers.drain(..) {
            let _ = card.destroy_framebuffer(pair.fb);
            let _ = card.destroy_dumb_buffer(pair.dumb);
        }
        self.pending = false;
    }
}
impl Drop for NativeScanout {
    fn drop(&mut self) {
        self.stop();
    }
}
pub fn open(path: impl AsRef<Path>, size: [u32; 2]) -> io::Result<Display<NativeScanout>> {
    if cfg!(target_endian = "big") {
        return Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "ARGB staging requires little-endian scanout",
        ));
    }
    let card = Card(OpenOptions::new().read(true).write(true).open(path)?);
    Display::new(NativeScanout::create(card, size)?, size)
}
