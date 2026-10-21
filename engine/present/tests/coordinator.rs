use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    rc::Rc,
};

use pocket_drivers::{
    DeviceTarget, DisplayDescriptor, DisplayError, DisplayOutput, DisplayRole, DrawList, FontView,
    FrameInput, PixelFormat, Rect, RenderError, RenderResources, Renderer, RendererDescriptor,
    Surface, Synchronization, Target, TargetOwnership, TexView, VsyncSource,
};
use pocket_present::{Coordinator, PresentError, RendererId};
use pocket_spec::draw_op;

struct Resources(u32, u32);
impl RenderResources for Resources {
    fn viewport(&self) -> (f32, f32) {
        (self.0 as f32, self.1 as f32)
    }
    fn raster_revision(&self) -> u64 {
        7
    }
    fn texture(&self, _: i32) -> Option<TexView<'_>> {
        None
    }
    fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
        None
    }
}

fn scene(width: u32, height: u32) -> DrawList {
    let mut list = DrawList::new();
    list.words = vec![
        draw_op::GRAD_RECT,
        0,
        width | height << 16,
        0xff00_00ff,
        0xff00_ff00,
        pocket_spec::GradDir::ToBottom as u32,
    ];
    list
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Failure {
    Acquire,
    Render,
    RenderWait,
    Flush,
    DisplayWait,
}

struct Job {
    target: u64,
    stopped: bool,
}

#[derive(Default)]
struct DeviceState {
    events: Vec<String>,
    next_submission: u64,
    live: BTreeMap<u64, Job>,
    dma: BTreeSet<u64>,
    max_live: usize,
    retired: Vec<u64>,
    failure: Option<Failure>,
    zero_copy_calls: usize,
}

type Shared = Rc<RefCell<DeviceState>>;

struct FakeRenderer {
    state: Shared,
    zero_copy: bool,
    version: u32,
}
struct Submission(u64);

impl Renderer for FakeRenderer {
    type Submission = Submission;
    fn descriptor(&self) -> RendererDescriptor {
        RendererDescriptor::new(
            &[PixelFormat::Rgb565],
            TargetOwnership::DeviceOwned,
            Synchronization::Deferred,
            self.version,
            self.zero_copy,
        )
        .unwrap()
    }
    fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
        let Target::DeviceOwned(target) = &frame.target else {
            return Err(RenderError::Unsupported);
        };
        let mut state = self.state.borrow_mut();
        state.events.push(format!("render:{}", target.handle));
        if target.handle == 2 && state.failure == Some(Failure::Render) {
            return Err(RenderError::Failed);
        }
        state.next_submission += 1;
        let id = state.next_submission;
        state.live.insert(
            id,
            Job {
                target: target.handle,
                stopped: false,
            },
        );
        state.max_live = state.max_live.max(state.live.len());
        Ok(Submission(id))
    }
    unsafe fn render_zero_copy(
        &mut self,
        frame: &mut FrameInput<'_>,
    ) -> Result<Submission, RenderError> {
        self.state.borrow_mut().zero_copy_calls += 1;
        self.render(frame)
    }
    fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
        let mut state = self.state.borrow_mut();
        let job = state
            .live
            .get_mut(&submission.0)
            .expect("live renderer submission");
        assert!(!job.stopped, "wait exactly once");
        job.stopped = true;
        let target = job.target;
        state.events.push(format!("render-stop:{target}"));
        if target == 2 && state.failure == Some(Failure::RenderWait) {
            Err(RenderError::Failed)
        } else {
            Ok(())
        }
    }
    fn retire(&mut self, submission: Submission) {
        let mut state = self.state.borrow_mut();
        let job = state
            .live
            .remove(&submission.0)
            .expect("retire exactly once");
        assert!(job.stopped, "cannot retire a GPU in flight");
        assert!(
            !state.dma.contains(&job.target),
            "cannot retire during display DMA"
        );
        state.retired.push(submission.0);
        let references = state.live.len();
        state
            .events
            .push(format!("retire:{}:refs:{references}", job.target));
    }
}

impl Drop for FakeRenderer {
    fn drop(&mut self) {
        assert!(
            self.state.borrow().live.is_empty(),
            "shutdown after draining rendering"
        );
    }
}

struct FakeDisplay {
    state: Shared,
    handle: u64,
    descriptor: DisplayDescriptor,
    wrong_region: bool,
}
struct Transfer(u64);

impl DisplayOutput for FakeDisplay {
    type Token = Transfer;
    fn descriptor(&self) -> DisplayDescriptor {
        self.descriptor
    }
    fn acquire(&mut self, mut region: Rect) -> Result<Target<'_>, DisplayError> {
        let mut state = self.state.borrow_mut();
        assert!(
            !state.dma.contains(&self.handle),
            "acquire waits for DMA completion"
        );
        state.events.push(format!("acquire:{}", self.handle));
        if self.handle == 2 && state.failure == Some(Failure::Acquire) {
            return Err(DisplayError::Failed);
        }
        if self.wrong_region {
            region.x += 1;
        }
        Ok(Target::DeviceOwned(DeviceTarget::new(
            self.handle,
            region,
            self.descriptor.format,
        )))
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<Transfer, DisplayError> {
        assert_eq!(regions.len(), 1);
        let mut state = self.state.borrow_mut();
        assert!(
            state
                .live
                .values()
                .any(|job| job.target == self.handle && job.stopped),
            "display reads only after GPU terminal wait"
        );
        state.events.push(format!("flush:{}", self.handle));
        if self.handle == 2 && state.failure == Some(Failure::Flush) {
            return Err(DisplayError::Failed);
        }
        assert!(state.dma.insert(self.handle));
        Ok(Transfer(self.handle))
    }
    fn wait(&mut self, token: Transfer) -> Result<(), DisplayError> {
        assert_eq!(token.0, self.handle);
        let mut state = self.state.borrow_mut();
        assert!(
            state.dma.remove(&self.handle),
            "display token consumed once"
        );
        state.events.push(format!("display-stop:{}", self.handle));
        if self.handle == 2 && state.failure == Some(Failure::DisplayWait) {
            Err(DisplayError::Failed)
        } else {
            Ok(())
        }
    }
    fn vsync(&mut self) -> VsyncSource {
        VsyncSource::None
    }
}

impl Drop for FakeDisplay {
    fn drop(&mut self) {
        assert!(
            !self.state.borrow().dma.contains(&self.handle),
            "shutdown after display terminal wait"
        );
    }
}

fn device_descriptor() -> DisplayDescriptor {
    DisplayDescriptor::new(
        DisplayRole::Primary,
        8,
        6,
        PixelFormat::Rgb565,
        16,
        TargetOwnership::DeviceOwned,
    )
}

fn fake_display(state: &Shared, handle: u64) -> FakeDisplay {
    FakeDisplay {
        state: state.clone(),
        handle,
        descriptor: device_descriptor(),
        wrong_region: false,
    }
}

fn pair(zero_copy: bool) -> (Coordinator, Shared) {
    let state = Shared::default();
    let mut coordinator = Coordinator::new(1, 0).unwrap();
    let renderer = coordinator
        .add_renderer(FakeRenderer {
            state: state.clone(),
            zero_copy,
            version: pocket_spec::DRAW_LIST_VERSION,
        })
        .unwrap();
    coordinator
        .add_display(fake_display(&state, 1), renderer)
        .unwrap();
    coordinator
        .add_display(fake_display(&state, 2), renderer)
        .unwrap();
    (coordinator, state)
}

#[test]
fn shared_renderer_keeps_both_submissions_live_and_retires_in_reverse_order() {
    for zero_copy in [false, true] {
        let (mut coordinator, state) = pair(zero_copy);
        coordinator
            .present(&scene(8, 6), None, &Resources(8, 6))
            .unwrap();
        let state = state.borrow();
        assert_eq!(state.max_live, 2);
        assert_eq!(state.retired, [2, 1]);
        assert_eq!(state.zero_copy_calls, if zero_copy { 2 } else { 0 });
        assert_eq!(
            state.events,
            [
                "acquire:1",
                "render:1",
                "acquire:2",
                "render:2",
                "render-stop:2",
                "flush:2",
                "display-stop:2",
                "retire:2:refs:1",
                "render-stop:1",
                "flush:1",
                "display-stop:1",
                "retire:1:refs:0",
            ]
        );
        assert!(state.live.is_empty());
        assert!(state.dma.is_empty());
        for index in 0..2 {
            assert_eq!(
                coordinator.history_valid(pocket_present::DisplayId::from_raw(index)),
                Some(true)
            );
        }
    }
}

#[test]
fn all_failure_stages_drain_other_work_and_allow_a_full_retry() {
    for fault in [
        Failure::Acquire,
        Failure::Render,
        Failure::RenderWait,
        Failure::Flush,
        Failure::DisplayWait,
    ] {
        let (mut coordinator, state) = pair(true);
        state.borrow_mut().failure = Some(fault);
        let result = coordinator.present(&scene(8, 6), None, &Resources(8, 6));
        assert!(result.is_err(), "{fault:?}");
        {
            let state = state.borrow();
            assert!(state.live.is_empty(), "{fault:?}");
            assert!(state.dma.is_empty(), "{fault:?}");
            assert!(state.events.iter().any(|event| event == "retire:1:refs:0"));
            if matches!(
                fault,
                Failure::Acquire | Failure::Render | Failure::RenderWait
            ) {
                assert!(!state.events.iter().any(|event| event == "flush:2"));
            }
        }
        for index in 0..2 {
            assert_eq!(
                coordinator.history_valid(pocket_present::DisplayId::from_raw(index)),
                Some(false)
            );
        }
        state.borrow_mut().failure = None;
        coordinator
            .present(&scene(8, 6), None, &Resources(8, 6))
            .unwrap();
        for index in 0..2 {
            assert_eq!(
                coordinator.history_valid(pocket_present::DisplayId::from_raw(index)),
                Some(true)
            );
        }
    }
}

struct CpuDisplay {
    descriptor: DisplayDescriptor,
    buffer: Vec<u8>,
    screen: Rc<RefCell<Vec<u8>>>,
    acquisitions: Rc<RefCell<Vec<Rect>>>,
    region: Rect,
    reading: bool,
    fail_wait_y: Rc<Cell<Option<u32>>>,
}

impl DisplayOutput for CpuDisplay {
    type Token = Rect;
    fn descriptor(&self) -> DisplayDescriptor {
        self.descriptor
    }
    fn acquire(&mut self, region: Rect) -> Result<Target<'_>, DisplayError> {
        assert!(!self.reading);
        self.region = region;
        self.acquisitions.borrow_mut().push(region);
        Surface::new(
            &mut self.buffer,
            region,
            self.descriptor.stride_bytes,
            self.descriptor.format,
        )
        .map(Target::CpuVisible)
    }
    fn flush(&mut self, regions: &[Rect]) -> Result<Rect, DisplayError> {
        assert!(!self.reading);
        assert_eq!(regions, &[self.region]);
        self.reading = true;
        Ok(self.region)
    }
    fn wait(&mut self, token: Rect) -> Result<(), DisplayError> {
        assert!(self.reading);
        assert_eq!(token, self.region);
        let mut output = self.screen.borrow_mut();
        let stride = self.descriptor.stride_bytes;
        let bytes = self.descriptor.format.row_bytes(token.width).unwrap();
        let failed = self.fail_wait_y.get() == Some(token.y);
        let rows = if failed { 1 } else { token.height as usize };
        for row in 0..rows {
            let destination = (token.y as usize + row) * bytes;
            output[destination..destination + bytes]
                .copy_from_slice(&self.buffer[row * stride..row * stride + bytes]);
        }
        self.reading = false;
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

fn cpu_display(
    width: u32,
    height: u32,
    format: PixelFormat,
    rows: u32,
    role: DisplayRole,
) -> CpuDisplay {
    let stride = format.row_bytes(width).unwrap();
    let mut descriptor = DisplayDescriptor::new(
        role,
        width,
        height,
        format,
        stride,
        TargetOwnership::CpuVisible,
    );
    descriptor.device_frame_storage = true;
    CpuDisplay {
        descriptor,
        buffer: vec![0; stride * rows as usize],
        screen: Rc::new(RefCell::new(vec![0; stride * height as usize])),
        acquisitions: Rc::default(),
        region: Rect::default(),
        reading: false,
        fail_wait_y: Rc::default(),
    }
}

#[test]
fn budgeted_strips_match_full_frame_in_all_software_formats_and_scales() {
    for format in [
        PixelFormat::Rgba8888,
        PixelFormat::Argb8888,
        PixelFormat::Rgb565,
    ] {
        for scale in [1, 2, 3, 4] {
            let width = 8 * scale;
            let height = 6 * scale;
            let display = cpu_display(width, height, format, 2, DisplayRole::Primary);
            let screen = display.screen.clone();
            let acquisitions = display.acquisitions.clone();
            let budget = display.descriptor.stride_bytes * 2;
            let mut coordinator = Coordinator::new(scale, budget).unwrap();
            let id = coordinator
                .add_display(display, RendererId::SOFTWARE)
                .unwrap();
            assert_eq!(coordinator.strip_height(id), Some(2));
            assert_eq!(coordinator.reserved_frame_buffer_bytes(), budget);
            let resources = Resources(8, 6);
            let list = scene(8, 6);
            coordinator.present(&list, None, &resources).unwrap();
            let mut expected = vec![0; format.row_bytes(width).unwrap() * height as usize];
            let mut surface = Surface::new(
                &mut expected,
                Rect::new(0, 0, width, height),
                format.row_bytes(width).unwrap(),
                format,
            )
            .unwrap();
            pocket_raster::render_surface(&resources, &list.words, &mut surface, scale).unwrap();
            assert_eq!(*screen.borrow(), expected);
            assert_eq!(acquisitions.borrow().len(), (height / 2) as usize);
            // No target identity: a successful previous frame still redraws.
            coordinator.present(&list, None, &resources).unwrap();
            assert_eq!(acquisitions.borrow().len(), height as usize);
            assert_eq!(*screen.borrow(), expected);
        }
    }
}

#[test]
fn auxiliary_uses_its_own_viewport_and_missing_lists_submit_nothing() {
    let primary = cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary);
    let auxiliary = cpu_display(3, 2, PixelFormat::Rgb565, 2, DisplayRole::Auxiliary);
    let screen = auxiliary.screen.clone();
    let acquisitions = primary.acquisitions.clone();
    let mut coordinator = Coordinator::new(1, 108).unwrap();
    coordinator
        .add_display(primary, RendererId::SOFTWARE)
        .unwrap();
    coordinator
        .add_display(auxiliary, RendererId::SOFTWARE)
        .unwrap();
    assert_eq!(
        coordinator.present(&scene(8, 6), None, &Resources(8, 6)),
        Err(PresentError::MissingAuxiliary)
    );
    assert!(acquisitions.borrow().is_empty());
    let list = scene(3, 2);
    coordinator
        .present(&scene(8, 6), Some(&list), &Resources(8, 6))
        .unwrap();
    let mut expected = [0; 12];
    let mut surface =
        Surface::new(&mut expected, Rect::new(0, 0, 3, 2), 6, PixelFormat::Rgb565).unwrap();
    pocket_raster::render_surface(&Resources(3, 2), &list.words, &mut surface, 1).unwrap();
    assert_eq!(*screen.borrow(), expected);
    assert_eq!(coordinator.display_descriptors().len(), 2);
}

#[test]
fn descriptor_and_budget_failures_are_rejected_during_registration() {
    let state = Shared::default();
    let mut coordinator = Coordinator::new(1, 100).unwrap();
    assert_eq!(
        coordinator.add_renderer(FakeRenderer {
            state: state.clone(),
            zero_copy: false,
            version: 999
        }),
        Err(PresentError::InvalidRendererDescriptor)
    );
    assert_eq!(
        coordinator.add_display(
            cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary),
            RendererId::from_raw(999)
        ),
        Err(PresentError::InvalidRenderer)
    );
    assert_eq!(
        coordinator.add_display(fake_display(&state, 1), RendererId::SOFTWARE),
        Err(PresentError::IncompatibleRenderer)
    );
    for changed in 0..4 {
        let mut display = cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary);
        match changed {
            0 => display.descriptor.width = 0,
            1 => display.descriptor.stride_bytes = 1,
            2 => display.descriptor.window_alignment[1] = 0,
            _ => display.descriptor.refresh_granularity[0] = 0,
        }
        assert_eq!(
            coordinator.add_display(display, RendererId::SOFTWARE),
            Err(PresentError::InvalidDisplayDescriptor)
        );
    }
    let mut coordinator = Coordinator::new(1, 80).unwrap();
    let mut no_gram = cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary);
    no_gram.descriptor.device_frame_storage = false;
    assert_eq!(
        coordinator.add_display(no_gram, RendererId::SOFTWARE),
        Err(PresentError::BudgetExceeded)
    );
    let mut coordinator = Coordinator::new(1, 15).unwrap();
    assert_eq!(
        coordinator.add_display(
            cpu_display(8, 6, PixelFormat::Rgb565, 1, DisplayRole::Primary),
            RendererId::SOFTWARE
        ),
        Err(PresentError::BudgetExceeded)
    );
    let mut coordinator = Coordinator::new(1, 80).unwrap();
    let mut double = cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary);
    double.descriptor.double_buffered = true;
    let id = coordinator
        .add_display(double, RendererId::SOFTWARE)
        .unwrap();
    assert_eq!(coordinator.strip_height(id), Some(2));
    assert_eq!(coordinator.reserved_frame_buffer_bytes(), 64);
}

#[test]
fn registration_replans_shared_budget_and_respects_strip_alignment() {
    let mut coordinator = Coordinator::new(1, 80).unwrap();
    let mut first = cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary);
    first.descriptor.window_alignment[1] = 2;
    let first_id = coordinator
        .add_display(first, RendererId::SOFTWARE)
        .unwrap();
    assert_eq!(coordinator.strip_height(first_id), Some(4));
    let mut second = cpu_display(2, 2, PixelFormat::Rgb565, 2, DisplayRole::Auxiliary);
    second.descriptor.device_frame_storage = false;
    coordinator
        .add_display(second, RendererId::SOFTWARE)
        .unwrap();
    assert_eq!(coordinator.strip_height(first_id), Some(4));
    assert_eq!(coordinator.reserved_frame_buffer_bytes(), 72);
    let mut impossible = cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary);
    impossible.descriptor.device_frame_storage = false;
    assert_eq!(
        coordinator.add_display(impossible, RendererId::SOFTWARE),
        Err(PresentError::BudgetExceeded)
    );
    assert_eq!(coordinator.display_descriptors().len(), 2);
    assert_eq!(coordinator.reserved_frame_buffer_bytes(), 72);
}

#[test]
fn mismatched_acquired_target_and_malformed_frame_do_not_reach_renderer() {
    let state = Shared::default();
    let mut coordinator = Coordinator::new(1, 0).unwrap();
    let renderer = coordinator
        .add_renderer(FakeRenderer {
            state: state.clone(),
            zero_copy: false,
            version: pocket_spec::DRAW_LIST_VERSION,
        })
        .unwrap();
    let mut display = fake_display(&state, 1);
    display.wrong_region = true;
    let id = coordinator.add_display(display, renderer).unwrap();
    assert_eq!(
        coordinator.present(&scene(8, 6), None, &Resources(8, 6)),
        Err(PresentError::InvalidTarget(id))
    );
    assert_eq!(state.borrow().events, ["acquire:1"]);
    state.borrow_mut().events.clear();
    let mut malformed = DrawList::new();
    malformed.words.push(u32::MAX);
    assert_eq!(
        coordinator.present(&malformed, None, &Resources(8, 6)),
        Err(PresentError::InvalidFrame)
    );
    assert!(state.borrow().events.is_empty());
}

#[test]
fn partial_strip_failure_invalidates_history_and_retries_from_row_zero() {
    let display = cpu_display(8, 6, PixelFormat::Rgb565, 2, DisplayRole::Primary);
    let failure = display.fail_wait_y.clone();
    let screen = display.screen.clone();
    let acquisitions = display.acquisitions.clone();
    failure.set(Some(2));
    let mut coordinator = Coordinator::new(1, 32).unwrap();
    let id = coordinator
        .add_display(display, RendererId::SOFTWARE)
        .unwrap();
    let list = scene(8, 6);
    assert_eq!(
        coordinator.present(&list, None, &Resources(8, 6)),
        Err(PresentError::DisplayWait(id, DisplayError::Failed))
    );
    assert_eq!(coordinator.history_valid(id), Some(false));
    assert_eq!(
        acquisitions
            .borrow()
            .iter()
            .map(|region| region.y)
            .collect::<Vec<_>>(),
        [0, 2]
    );
    assert!(screen.borrow()[48..].iter().all(|byte| *byte == 0));
    failure.set(None);
    coordinator.present(&list, None, &Resources(8, 6)).unwrap();
    assert_eq!(
        acquisitions
            .borrow()
            .iter()
            .map(|region| region.y)
            .collect::<Vec<_>>(),
        [0, 2, 0, 2, 4]
    );
    assert_eq!(coordinator.history_valid(id), Some(true));
    let mut expected = vec![0; 96];
    let mut surface = Surface::new(
        &mut expected,
        Rect::new(0, 0, 8, 6),
        16,
        PixelFormat::Rgb565,
    )
    .unwrap();
    pocket_raster::render_surface(&Resources(8, 6), &list.words, &mut surface, 1).unwrap();
    assert_eq!(*screen.borrow(), expected);
}

#[test]
fn scale_change_reconfigures_software_and_preserves_registered_custom_renderer() {
    let state = Shared::default();
    let display = cpu_display(8, 6, PixelFormat::Rgb565, 6, DisplayRole::Primary);
    let screen = display.screen.clone();
    let mut coordinator = Coordinator::new(1, 96).unwrap();
    coordinator
        .add_display(display, RendererId::SOFTWARE)
        .unwrap();
    let renderer = coordinator
        .add_renderer(FakeRenderer {
            state: state.clone(),
            zero_copy: false,
            version: pocket_spec::DRAW_LIST_VERSION,
        })
        .unwrap();
    coordinator
        .add_display(fake_display(&state, 1), renderer)
        .unwrap();
    assert_eq!(
        coordinator.set_scale(3),
        Err(PresentError::InvalidDisplayDescriptor)
    );
    assert_eq!(coordinator.scale(), 1);
    coordinator.set_scale(2).unwrap();
    assert_eq!(coordinator.scale(), 2);
    let list = scene(4, 3);
    coordinator.present(&list, None, &Resources(4, 3)).unwrap();
    assert_eq!(state.borrow().retired.len(), 1);
    let mut expected = vec![0; 96];
    let mut surface = Surface::new(
        &mut expected,
        Rect::new(0, 0, 8, 6),
        16,
        PixelFormat::Rgb565,
    )
    .unwrap();
    pocket_raster::render_surface(&Resources(4, 3), &list.words, &mut surface, 2).unwrap();
    assert_eq!(*screen.borrow(), expected);
}

#[test]
fn destruction_after_failed_waits_has_no_outstanding_render_or_display_work() {
    for failure in [Failure::RenderWait, Failure::DisplayWait] {
        let (mut coordinator, state) = pair(true);
        state.borrow_mut().failure = Some(failure);
        assert!(coordinator
            .present(&scene(8, 6), None, &Resources(8, 6))
            .is_err());
        drop(coordinator);
        assert!(state.borrow().live.is_empty());
        assert!(state.borrow().dma.is_empty());
    }
}

#[test]
fn render_unwind_stops_borrowed_work_before_tokens_and_frame_resources_drop() {
    check_borrowed_unwind(false);
}

#[test]
fn render_wait_unwind_stops_work_without_waiting_the_same_submission_again() {
    check_borrowed_unwind(true);
}

fn check_borrowed_unwind(panic_on_wait: bool) {
    #[derive(Default)]
    struct State {
        live: Cell<bool>,
        resources_alive: Cell<bool>,
        events: RefCell<Vec<&'static str>>,
    }
    struct BorrowedResources(Rc<State>);
    impl RenderResources for BorrowedResources {
        fn viewport(&self) -> (f32, f32) {
            assert!(self.0.resources_alive.get());
            (8., 6.)
        }
        fn raster_revision(&self) -> u64 {
            1
        }
        fn texture(&self, _: i32) -> Option<TexView<'_>> {
            None
        }
        fn font_atlas(&self, _: u8) -> Option<FontView<'_>> {
            None
        }
    }
    impl Drop for BorrowedResources {
        fn drop(&mut self) {
            assert!(
                !self.0.live.get(),
                "hardware stopped before frame storage drops"
            );
            self.0.resources_alive.set(false);
            self.0.events.borrow_mut().push("resources-drop");
        }
    }
    struct BorrowedSubmission(Rc<State>);
    impl Drop for BorrowedSubmission {
        fn drop(&mut self) {
            assert!(
                !self.0.live.get(),
                "stop renderer before dropping its tokens"
            );
            self.0.events.borrow_mut().push("token-drop");
        }
    }
    struct PanicRenderer {
        state: Rc<State>,
        calls: usize,
        resources: Option<*const dyn RenderResources>,
        words: *const u32,
        damage: *const Rect,
        panic_on_wait: bool,
    }
    impl Renderer for PanicRenderer {
        type Submission = BorrowedSubmission;
        fn descriptor(&self) -> RendererDescriptor {
            RendererDescriptor::new(
                &[PixelFormat::Rgb565],
                TargetOwnership::DeviceOwned,
                Synchronization::Deferred,
                pocket_spec::DRAW_LIST_VERSION,
                true,
            )
            .unwrap()
        }
        fn render(&mut self, _: &mut FrameInput<'_>) -> Result<Self::Submission, RenderError> {
            unreachable!("zero-copy capability selected")
        }
        unsafe fn render_zero_copy(
            &mut self,
            frame: &mut FrameInput<'_>,
        ) -> Result<Self::Submission, RenderError> {
            self.calls += 1;
            self.state.live.set(true);
            // Model hardware retaining the coordinator's resource wrapper and
            // caller's words through terminal completion or driver Drop.
            self.resources = Some(unsafe {
                core::mem::transmute::<&dyn RenderResources, *const dyn RenderResources>(
                    frame.resources,
                )
            });
            self.words = frame.list.words.as_ptr();
            self.damage = frame.damage.as_ptr();
            if self.calls == 2 && !self.panic_on_wait {
                panic!("started borrowed work before returning a submission");
            }
            Ok(BorrowedSubmission(self.state.clone()))
        }
        fn wait(&mut self, _: &Self::Submission) -> Result<(), RenderError> {
            assert!(self.panic_on_wait);
            self.state.events.borrow_mut().push("wait-panic");
            panic!("device completion unknown")
        }
        fn retire(&mut self, _: Self::Submission) {
            unreachable!("token release follows driver destruction")
        }
    }
    impl Drop for PanicRenderer {
        fn drop(&mut self) {
            assert!(self.state.resources_alive.get());
            assert_eq!(unsafe { (&*self.resources.unwrap()).viewport() }, (8., 6.));
            assert_eq!(unsafe { *self.words }, draw_op::GRAD_RECT);
            assert_eq!(unsafe { *self.damage }, Rect::new(0, 0, 8, 6));
            self.state.live.set(false);
            self.state.events.borrow_mut().push("renderer-stop");
        }
    }
    let state = Rc::new(State::default());
    let other = Shared::default();
    let mut coordinator = Coordinator::new(1, 0).unwrap();
    let good = coordinator
        .add_renderer(FakeRenderer {
            state: other.clone(),
            zero_copy: false,
            version: pocket_spec::DRAW_LIST_VERSION,
        })
        .unwrap();
    let poisoned = coordinator
        .add_renderer(PanicRenderer {
            state: state.clone(),
            calls: 0,
            resources: None,
            words: core::ptr::null(),
            damage: core::ptr::null(),
            panic_on_wait,
        })
        .unwrap();
    coordinator
        .add_display(fake_display(&other, 1), good)
        .unwrap();
    coordinator
        .add_display(fake_display(&other, 2), poisoned)
        .unwrap();
    coordinator
        .add_display(fake_display(&other, 3), poisoned)
        .unwrap();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        state.resources_alive.set(true);
        let resources = BorrowedResources(state.clone());
        let list = scene(8, 6);
        coordinator.present(&list, None, &resources)
    }));
    assert!(result.is_err());
    assert_eq!(
        *state.events.borrow(),
        if panic_on_wait {
            vec![
                "wait-panic",
                "renderer-stop",
                "token-drop",
                "token-drop",
                "resources-drop",
            ]
        } else {
            vec!["renderer-stop", "token-drop", "resources-drop"]
        }
    );
    assert_eq!(other.borrow().retired, [1]);
    assert!(other.borrow().live.is_empty());
    assert!(!other
        .borrow()
        .events
        .iter()
        .any(|event| event.starts_with("flush:")));
    assert_eq!(
        coordinator.present(&scene(8, 6), None, &Resources(8, 6)),
        Err(PresentError::InvalidRenderer)
    );
    assert_eq!(
        coordinator.add_display(fake_display(&other, 4), poisoned),
        Err(PresentError::InvalidRenderer)
    );
    for index in 0..3 {
        assert_eq!(
            coordinator.history_valid(pocket_present::DisplayId::from_raw(index)),
            Some(false)
        );
    }
    drop(coordinator);
}

#[test]
fn native_overlays_are_submitted_between_ui_draw_and_terminal_render_wait() {
    let (mut coordinator, state) = pair(false);
    coordinator
        .present_with_overlay(&scene(8, 6), None, &Resources(8, 6), |id| {
            let mut state = state.borrow_mut();
            assert!(state.live.values().all(|job| !job.stopped));
            state.events.push(format!("overlay:{}", id.as_raw() + 1));
        })
        .unwrap();
    let events = &state.borrow().events;
    for target in [1, 2] {
        let pos = |s: String| events.iter().position(|e| *e == s).unwrap();
        assert!(pos(format!("render:{target}")) < pos(format!("overlay:{target}")));
        assert!(pos(format!("overlay:{target}")) < pos(format!("render-stop:{target}")));
        assert_eq!(
            coordinator.history_valid(pocket_present::DisplayId::from_raw(target - 1)),
            Some(false)
        );
    }
}

#[test]
fn native_target_scaling_keeps_the_logical_resource_viewport() {
    struct ViewportRenderer(FakeRenderer);
    impl Renderer for ViewportRenderer {
        type Submission = Submission;
        fn descriptor(&self) -> RendererDescriptor {
            self.0.descriptor()
        }
        fn render(&mut self, frame: &mut FrameInput<'_>) -> Result<Submission, RenderError> {
            assert_eq!(frame.resources.viewport(), (8.0, 6.0));
            let Target::DeviceOwned(target) = &frame.target else {
                panic!("native target")
            };
            assert_eq!(target.region, Rect::new(0, 0, 13, 9));
            assert_eq!(frame.damage, &[Rect::new(0, 0, 13, 9)]);
            self.0.render(frame)
        }
        fn wait(&mut self, submission: &Submission) -> Result<(), RenderError> {
            self.0.wait(submission)
        }
        fn retire(&mut self, submission: Submission) {
            self.0.retire(submission)
        }
    }
    let state = Shared::default();
    let mut coordinator = Coordinator::new(2, 0).unwrap();
    let renderer = coordinator
        .add_renderer(ViewportRenderer(FakeRenderer {
            state: state.clone(),
            zero_copy: false,
            version: pocket_spec::DRAW_LIST_VERSION,
        }))
        .unwrap();
    let mut display = fake_display(&state, 1);
    display.descriptor.width = 13;
    display.descriptor.height = 9;
    display.descriptor.stride_bytes = 26;
    coordinator.add_display(display, renderer).unwrap();
    coordinator
        .present(&scene(8, 6), None, &Resources(8, 6))
        .unwrap();
    assert!(state.borrow().live.is_empty());
}
