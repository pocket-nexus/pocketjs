use pocket_drivers::Renderer as RendererTrait;
use pocket_drivers::*;
use pocket_tex_cache::{TextureCache, TextureKey};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

pub const WIDTH: u32 = 8;
pub const HEIGHT: u32 = 6;
pub type Shared = Rc<RefCell<Device>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    RenderWait,
    Flush,
    DisplayWait,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
    Acquire(u64),
    Upload(u64, TextureKey),
    Render(u64, u64),
    RenderStop(u64),
    Flush(u64),
    DisplayStop(u64, bool),
    Retire(u64),
    Free(u64),
    RendererDrop,
    DisplayDrop(u64),
}
struct Job {
    target: u64,
    texture: u64,
    stopped: bool,
}
#[derive(Default)]
pub struct Device {
    pub events: Vec<Event>,
    pub fault: Option<Fault>,
    pub max_live: usize,
    pub uploads: usize,
    pub freed: Vec<u64>,
    next_submission: u64,
    next_texture: u64,
    jobs: BTreeMap<u64, Job>,
    dma: BTreeMap<u64, u64>,
    textures: BTreeMap<u64, Vec<u8>>,
}
impl Device {
    pub fn stopped(&self) -> bool {
        self.jobs.is_empty() && self.dma.is_empty()
    }
    pub fn released(&self) -> bool {
        self.stopped() && self.textures.is_empty()
    }
    pub fn pixels(&self, texture: u64) -> &[u8] {
        &self.textures[&texture]
    }
    fn release(&mut self, texture: u64) {
        assert!(
            self.jobs.values().all(|job| job.texture != texture),
            "cannot release a texture before its last submission retires"
        );
        assert!(
            self.textures.remove(&texture).is_some(),
            "free exactly once"
        );
        self.freed.push(texture);
        self.events.push(Event::Free(texture));
    }
}

pub struct Renderer {
    pub shared: Shared,
    cache: TextureCache<u64>,
}
#[derive(Debug)]
pub struct Submission(u64);
impl Renderer {
    pub fn new(shared: Shared) -> Self {
        Self {
            shared,
            cache: TextureCache::new(4, 1024),
        }
    }
}
impl pocket_drivers::Renderer for Renderer {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgba8888],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            pocket_spec::DRAW_LIST_VERSION,
            false,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::Unsupported);
        };
        let viewport = frame.resources.viewport();
        let mut handles = pocket_draw_ops::DrawOps::new(
            &frame.list.words,
            DamageRect::new(0, 0, viewport.0 as i32, viewport.1 as i32),
        )
        .filter_map(|operation| match operation {
            Ok(op) if op.opcode == pocket_spec::draw_op::TEX_QUAD => Some(Ok(op.words[1] as i32)),
            Ok(_) => None,
            Err(_) => Some(Err(RenderError::InvalidFrame)),
        });
        let handle = handles.next().ok_or(RenderError::Unsupported)??;
        if handles.next().is_some() {
            return Err(RenderError::Unsupported);
        }
        let view = frame
            .resources
            .texture(handle)
            .ok_or(RenderError::InvalidFrame)?;
        let key = TextureKey {
            handle,
            revision: frame
                .resources
                .texture_revision(handle)
                .ok_or(RenderError::InvalidFrame)?,
        };
        let id = {
            let mut state = self.shared.borrow_mut();
            if state.jobs.values().any(|job| job.target == target.handle) {
                return Err(RenderError::InvalidFrame);
            }
            state.next_submission += 1;
            state.next_submission
        };
        let upload = self.shared.clone();
        let release = self.shared.clone();
        let texture = *self
            .cache
            .get_or_upload(
                key,
                view.pixels.len(),
                Some(id),
                || {
                    let mut state = upload.borrow_mut();
                    state.next_texture += 1;
                    let texture = state.next_texture;
                    // Deferred work never reads the caller's borrowed TexView.
                    state.textures.insert(texture, view.pixels.to_vec());
                    state.uploads += 1;
                    state.events.push(Event::Upload(texture, key));
                    Ok::<_, ()>(texture)
                },
                |texture| release.borrow_mut().release(texture),
            )
            .map_err(|_| RenderError::Failed)?;
        let mut state = self.shared.borrow_mut();
        state.jobs.insert(
            id,
            Job {
                target: target.handle,
                texture,
                stopped: false,
            },
        );
        state.max_live = state.max_live.max(state.jobs.len());
        state.events.push(Event::Render(target.handle, id));
        Ok(Submission(id))
    }
    fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
        let mut state = self.shared.borrow_mut();
        let Some(job) = state.jobs.get_mut(&submission.0) else {
            return Err(RenderError::InvalidFrame);
        };
        let target = job.target;
        if !job.stopped {
            job.stopped = true;
            state.events.push(Event::RenderStop(target));
        }
        if target == 2 && state.fault == Some(Fault::RenderWait) {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn retire(&mut self, submission: Submission) {
        // The driver protects callers who retire before their renderer wait.
        let _ = self.wait(&submission);
        {
            let mut state = self.shared.borrow_mut();
            let Some(job) = state.jobs.get(&submission.0) else {
                return;
            };
            assert!(job.stopped);
            assert!(
                !state.dma.contains_key(&job.target),
                "display DMA must stop before retire"
            );
            state.jobs.remove(&submission.0);
            state.events.push(Event::Retire(submission.0));
        }
        let release = self.shared.clone();
        self.cache.retire(submission.0, |texture| {
            release.borrow_mut().release(texture)
        });
    }
}
impl Drop for Renderer {
    fn drop(&mut self) {
        // A real renderer stops its own work before freeing command/texture storage.
        let ids: Vec<_> = self.shared.borrow().jobs.keys().copied().collect();
        for id in ids {
            self.retire(Submission(id));
        }
        let release = self.shared.clone();
        self.cache
            .clear(|texture| release.borrow_mut().release(texture))
            .unwrap();
        self.shared.borrow_mut().events.push(Event::RendererDrop);
    }
}

pub struct Display {
    pub shared: Shared,
    pub id: u64,
}
pub struct Transfer {
    target: u64,
    submission: u64,
}
impl Display {
    pub fn new(shared: Shared, id: u64) -> Self {
        Self { shared, id }
    }
}
impl DisplayOutput for Display {
    type Token = Transfer;
    fn descriptor(&self) -> DisplayDescriptor {
        DisplayDescriptor::new(
            DisplayRole::Primary,
            WIDTH,
            HEIGHT,
            PixelFormat::Rgba8888,
            WIDTH as usize * 4,
            TargetOwnership::DeviceOwned,
        )
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        let mut state = self.shared.borrow_mut();
        if state.dma.contains_key(&self.id) || state.jobs.values().any(|job| job.target == self.id)
        {
            return Err(DisplayError::InvalidTarget);
        }
        state.events.push(Event::Acquire(self.id));
        Ok(Target::DeviceOwned(DeviceTarget::new(
            self.id,
            region,
            PixelFormat::Rgba8888,
        )))
    }
    fn flush(&mut self, _: &[Rect]) -> Result<Transfer, DisplayError> {
        let mut state = self.shared.borrow_mut();
        if state.dma.contains_key(&self.id) {
            return Err(DisplayError::InvalidTarget);
        }
        let Some((&submission, job)) = state.jobs.iter().find(|(_, job)| job.target == self.id)
        else {
            return Err(DisplayError::InvalidTarget);
        };
        if !job.stopped {
            return Err(DisplayError::InvalidTarget);
        }
        assert!(state.textures.contains_key(&job.texture));
        state.dma.insert(self.id, submission);
        state.events.push(Event::Flush(self.id));
        if self.id == 2 && state.fault == Some(Fault::Flush) {
            // Model a partially issued transfer: cancel/drain before Err.
            state.dma.remove(&self.id);
            state.events.push(Event::DisplayStop(self.id, false));
            return Err(DisplayError::Failed);
        }
        Ok(Transfer {
            target: self.id,
            submission,
        })
    }
    fn wait(&mut self, token: Transfer) -> Result<(), DisplayError> {
        let mut state = self.shared.borrow_mut();
        if token.target != self.id || state.dma.get(&self.id) != Some(&token.submission) {
            return Err(DisplayError::InvalidTarget);
        }
        state.dma.remove(&self.id);
        let failed = self.id == 2 && state.fault == Some(Fault::DisplayWait);
        state.events.push(Event::DisplayStop(self.id, !failed));
        if failed {
            Err(DisplayError::Failed)
        } else {
            Ok(())
        }
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}
impl Drop for Display {
    fn drop(&mut self) {
        let mut state = self.shared.borrow_mut();
        if state.dma.remove(&self.id).is_some() {
            state.events.push(Event::DisplayStop(self.id, false));
        }
        state.events.push(Event::DisplayDrop(self.id));
    }
}

pub struct Resources {
    pub pixels: Vec<u8>,
    pub revision: u64,
}
impl Resources {
    pub fn new(revision: u64, byte: u8) -> Self {
        Self {
            pixels: vec![byte, 0, 0, 255],
            revision,
        }
    }
}
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (WIDTH as f32, HEIGHT as f32)
    }
    fn raster_revision(&self) -> u64 {
        self.revision
    }
    fn texture(&self, handle: i32) -> Option<TexView<'_>> {
        (handle == 7).then_some(TexView {
            pixels: &self.pixels,
            w: 1,
            h: 1,
            psm: pocket_spec::psm::PSM_8888,
            palette: None,
            linear: false,
        })
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}
pub fn scene() -> DrawList {
    let mut list = DrawList::new();
    list.words = vec![
        pocket_spec::draw_op::TEX_QUAD,
        7,
        0,
        WIDTH | HEIGHT << 16,
        0f32.to_bits(),
        0f32.to_bits(),
        1f32.to_bits(),
        1f32.to_bits(),
        u32::MAX,
    ];
    list
}
pub fn submit(renderer: &mut Renderer, display: &mut Display, resources: &Resources) -> Submission {
    let list = scene();
    let damage = [Rect::new(0, 0, WIDTH, HEIGHT)];
    let target = display.acquire(damage[0]).unwrap();
    renderer
        .render(&mut FrameInput::new(&list, resources, &damage, target))
        .unwrap()
}
pub fn finish(renderer: &mut Renderer, display: &mut Display, submission: Submission) {
    renderer.wait(&submission).unwrap();
    let token = display.flush(&[Rect::new(0, 0, WIDTH, HEIGHT)]).unwrap();
    display.wait(token).unwrap();
    renderer.retire(submission);
}
