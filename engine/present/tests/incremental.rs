use pocket_drivers::*;
use pocket_present::{Coordinator, RendererId};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

struct Resources;
impl RenderResources for Resources {
    fn raster_revision(&self) -> u64 {
        1
    }
    fn viewport(&self) -> (f32, f32) {
        (8.0, 8.0)
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}
fn scene(x: u32) -> DrawList {
    let mut list = DrawList::new();
    list.words = vec![
        pocket_spec::draw_op::RECT,
        x | 2 << 16,
        2 | 2 << 16,
        0xff00_00ff,
    ];
    list
}
fn reference(list: &DrawList) -> Vec<u8> {
    let mut pixels = vec![0; 256];
    let target = Surface::new(
        &mut pixels,
        Rect::new(0, 0, 8, 8),
        32,
        PixelFormat::Rgba8888,
    )
    .unwrap();
    let damage = [Rect::new(0, 0, 8, 8)];
    let mut input = FrameInput::new(list, &Resources, &damage, Target::CpuVisible(target));
    let mut raster = pocket_raster::RasterRenderer::new(1).unwrap();
    raster.render(&mut input).unwrap();
    raster.wait(&()).unwrap();
    raster.retire(());
    pixels
}
#[derive(Default)]
struct Facts {
    selected: usize,
    generation: u64,
    flushed: Vec<Vec<Rect>>,
    pixels: Vec<u8>,
    fail: bool,
    panic_flush: bool,
    max_pending: usize,
    overlapped: usize,
    pending: usize,
    drops: usize,
}
struct Persistent {
    buffers: [Vec<u8>; 2],
    facts: Rc<RefCell<Facts>>,
}
impl DisplayOutput for Persistent {
    type Token = usize;
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            8,
            8,
            PixelFormat::Rgba8888,
            32,
            TargetOwnership::CpuVisible,
        );
        descriptor.double_buffered = true;
        descriptor.partial_refresh = true;
        descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        let facts = self.facts.borrow();
        Ok(Some(BufferIdentity {
            buffer: facts.selected as u64,
            generation: facts.generation,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        let index = self.facts.borrow().selected;
        Ok(Target::CpuVisible(Surface::new(
            &mut self.buffers[index],
            region,
            32,
            PixelFormat::Rgba8888,
        )?))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<usize, DisplayError> {
        let mut facts = self.facts.borrow_mut();
        facts.flushed.push(regions.to_vec());
        Ok(facts.selected)
    }
    fn wait(&mut self, token: usize) -> Result<(), DisplayError> {
        let mut facts = self.facts.borrow_mut();
        facts.pixels = self.buffers[token].clone();
        if std::mem::take(&mut facts.fail) {
            Err(DisplayError::Failed)
        } else {
            Ok(())
        }
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}
#[test]
fn each_physical_buffer_has_its_own_history_and_generation() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut coordinator = Coordinator::new(1, 512).unwrap();
    coordinator
        .add_display(
            Persistent {
                buffers: [vec![0; 256], vec![0; 256]],
                facts: facts.clone(),
            },
            RendererId::SOFTWARE,
        )
        .unwrap();
    let first = scene(1);
    for selected in [0, 1, 0, 1] {
        facts.borrow_mut().selected = selected;
        coordinator.present(&first, None, &Resources).unwrap();
    }
    assert_eq!(facts.borrow().flushed.len(), 2);
    let second = scene(4);
    for selected in [0, 1] {
        facts.borrow_mut().selected = selected;
        coordinator.present(&second, None, &Resources).unwrap();
        assert_eq!(facts.borrow().pixels, reference(&second));
        let regions = facts.borrow().flushed.last().unwrap().clone();
        assert!(regions.iter().map(|r| r.width * r.height).sum::<u32>() < 64);
    }
    facts.borrow_mut().generation += 1;
    coordinator.present(&second, None, &Resources).unwrap();
    assert_eq!(
        facts.borrow().flushed.last().unwrap(),
        &vec![Rect::new(0, 0, 8, 8)]
    );
    facts.borrow_mut().fail = true;
    assert!(coordinator.present(&first, None, &Resources).is_err());
    coordinator.present(&first, None, &Resources).unwrap();
    assert_eq!(
        facts.borrow().flushed.last().unwrap(),
        &vec![Rect::new(0, 0, 8, 8)]
    );
    assert_eq!(facts.borrow().pixels, reference(&first));
}

struct Transfer {
    buffer: usize,
    region: Rect,
    damage: Vec<Rect>,
    frozen: Vec<u8>,
}
struct Panel {
    buffers: [Vec<u8>; 2],
    current: usize,
    region: Rect,
    next: u64,
    transfers: BTreeMap<u64, Transfer>,
    facts: Rc<RefCell<Facts>>,
}
impl Panel {
    fn finish(&mut self, token: u64) {
        let transfer = self.transfers.remove(&token).expect("known transfer");
        assert_eq!(
            transfer.frozen, self.buffers[transfer.buffer],
            "pending DMA storage changed"
        );
        let mut facts = self.facts.borrow_mut();
        for damage in transfer.damage {
            for y in damage.y..damage.y + damage.height {
                let from = (y - transfer.region.y) as usize * 32 + damage.x as usize * 4;
                let to = y as usize * 32 + damage.x as usize * 4;
                let length = damage.width as usize * 4;
                facts.pixels[to..to + length]
                    .copy_from_slice(&self.buffers[transfer.buffer][from..from + length]);
            }
        }
        facts.pending = self.transfers.len();
    }
}
impl DisplayOutput for Panel {
    type Token = u64;
    fn descriptor(&self) -> DisplayDescriptor {
        let mut descriptor = DisplayDescriptor::new(
            DisplayRole::Primary,
            8,
            8,
            PixelFormat::Rgba8888,
            32,
            TargetOwnership::CpuVisible,
        );
        descriptor.device_frame_storage = true;
        descriptor.double_buffered = true;
        descriptor.pipelined_acquire = true;
        descriptor.partial_refresh = true;
        descriptor
    }
    fn frame_identity(&mut self) -> Result<Option<BufferIdentity>, DisplayError> {
        assert!(self.transfers.is_empty());
        Ok(Some(BufferIdentity {
            buffer: 1,
            generation: 0,
        }))
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        assert!(
            !self.transfers.values().any(|t| t.buffer == self.current),
            "buffer reused before wait"
        );
        if !self.transfers.is_empty() {
            self.facts.borrow_mut().overlapped += 1;
        }
        self.region = region;
        Ok(Target::CpuVisible(Surface::new(
            &mut self.buffers[self.current],
            region,
            32,
            PixelFormat::Rgba8888,
        )?))
    }
    fn flush(&mut self, damage: &[Rect]) -> Result<u64, DisplayError> {
        self.next += 1;
        self.transfers.insert(
            self.next,
            Transfer {
                buffer: self.current,
                region: self.region,
                damage: damage.to_vec(),
                frozen: self.buffers[self.current].clone(),
            },
        );
        self.current = 1 - self.current;
        let mut facts = self.facts.borrow_mut();
        facts.flushed.push(damage.to_vec());
        facts.pending = self.transfers.len();
        facts.max_pending = facts.max_pending.max(self.transfers.len());
        if facts.panic_flush && self.transfers.len() == 2 {
            drop(facts);
            panic!("partial native flush");
        }
        Ok(self.next)
    }
    fn wait(&mut self, token: u64) -> Result<(), DisplayError> {
        self.finish(token);
        if std::mem::take(&mut self.facts.borrow_mut().fail) {
            Err(DisplayError::Failed)
        } else {
            Ok(())
        }
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}
impl Drop for Panel {
    fn drop(&mut self) {
        while let Some(token) = self.transfers.keys().next().copied() {
            self.finish(token);
        }
        self.facts.borrow_mut().drops += 1;
    }
}
fn panel(facts: Rc<RefCell<Facts>>) -> Coordinator {
    facts.borrow_mut().pixels = vec![0; 256];
    let mut coordinator = Coordinator::new(1, 128).unwrap();
    let id = coordinator
        .add_display(
            Panel {
                buffers: [vec![0; 64], vec![0; 64]],
                current: 0,
                region: Rect::default(),
                next: 0,
                transfers: BTreeMap::new(),
                facts,
            },
            RendererId::SOFTWARE,
        )
        .unwrap();
    assert_eq!(coordinator.strip_height(id), Some(2));
    assert_eq!(coordinator.reserved_frame_buffer_bytes(), 128);
    coordinator
}
#[test]
fn two_strip_dma_buffers_overlap_and_failure_invalidates_panel_history() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut coordinator = panel(facts.clone());
    for x in [1, 4] {
        let list = scene(x);
        coordinator.present(&list, None, &Resources).unwrap();
        assert_eq!(facts.borrow().pixels, reference(&list));
    }
    assert_eq!(facts.borrow().max_pending, 2);
    assert!(facts.borrow().overlapped > 0);
    assert_eq!(facts.borrow().pending, 0);
    let flushes = facts.borrow().flushed.len();
    coordinator.present(&scene(4), None, &Resources).unwrap();
    assert_eq!(facts.borrow().flushed.len(), flushes);
    facts.borrow_mut().fail = true;
    assert!(coordinator.present(&scene(1), None, &Resources).is_err());
    assert_eq!(facts.borrow().pending, 0);
    let before = facts.borrow().flushed.len();
    coordinator.present(&scene(1), None, &Resources).unwrap();
    assert_eq!(
        facts.borrow().flushed[before..]
            .iter()
            .flatten()
            .map(|r| r.width * r.height)
            .sum::<u32>(),
        64
    );
    assert_eq!(facts.borrow().pixels, reference(&scene(1)));
}
#[test]
fn panic_during_second_flush_drains_both_buffers_before_disabling_display() {
    let facts = Rc::new(RefCell::new(Facts::default()));
    let mut coordinator = panel(facts.clone());
    facts.borrow_mut().panic_flush = true;
    assert!(
        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| coordinator.present(
            &scene(1),
            None,
            &Resources
        )))
        .is_err()
    );
    assert_eq!(facts.borrow().pending, 0);
    assert_eq!(facts.borrow().drops, 1);
    assert!(coordinator.present(&scene(1), None, &Resources).is_err());
}
