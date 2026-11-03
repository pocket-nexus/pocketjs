//! pocket-driver-kit lifecycle audit of the ES 1.1 renderer over the recording
//! GL. glFinish is the completion probe and glDeleteTextures the release
//! probe; neither is evidence about a physical GPU.
use pocket_driver_kit::test_device::{scene, Resources, HEIGHT, WIDTH};
use pocket_driver_kit::{Event, Lifecycle};
use pocket_drivers::{FrameInput, PixelFormat, RenderError, Renderer as _, Target};
use pocket_gles::mock::{self, Call};
use pocket_gles::{ContextAccess, TargetConfig, Viewport};

struct Context;
unsafe impl ContextAccess for Context {
    type NativeTarget = ();
    fn ensure_current(&mut self) -> Result<(), RenderError> {
        Ok(())
    }
    fn bind_target(&mut self, _: &()) -> Result<(), RenderError> {
        Ok(())
    }
}
fn count(call: impl Fn(&Call) -> bool) -> usize {
    mock::calls().iter().filter(|c| call(c)).count()
}

#[test]
fn render_wait_retire_and_destroy_pass_the_lifecycle_audit() {
    mock::reset();
    let mut renderer = pocket_gles1::Renderer::new(Context).unwrap();
    let buffer = renderer
        .register_target(TargetConfig::new(
            (),
            [WIDTH, HEIGHT],
            Viewport::new(0, 0, WIDTH, HEIGHT),
            PixelFormat::Rgba8888,
        ))
        .unwrap();
    let list = scene();
    let mut audit = Lifecycle::new(8);
    for frame in 1..=2u64 {
        // Each frame carries a new texture version for handle 7.
        let resources = Resources::new(frame, frame as u8);
        audit.observe(Event::Acquire(buffer)).unwrap();
        let target = renderer.target(buffer).unwrap();
        let damage = [pocket_drivers::Rect::new(0, 0, WIDTH, HEIGHT)];
        let submission = renderer
            .render(&mut FrameInput::new(
                &list,
                &resources,
                &damage,
                Target::DeviceOwned(target),
            ))
            .unwrap();
        audit
            .observe(Event::Render {
                submission: frame,
                buffer,
            })
            .unwrap();
        audit
            .observe(Event::UseResource {
                submission: frame,
                resource: frame,
            })
            .unwrap();
        let finished = count(|c| *c == Call::Finish);
        renderer.wait(&submission).unwrap();
        if count(|c| *c == Call::Finish) > finished {
            audit.observe(Event::RenderStopped(frame)).unwrap();
        }
        audit
            .observe(Event::RenderWaited {
                submission: frame,
                failed: false,
            })
            .unwrap();
        renderer.retire(submission);
        audit.observe(Event::Retire(frame)).unwrap();
        audit.observe(Event::FrameEnd { failed: false }).unwrap();
    }
    renderer.unregister_target(buffer).unwrap();
    drop(renderer);
    // Both texture versions were uploaded and are deleted by destruction.
    assert!(count(|c| matches!(c, Call::TexImage2D { .. })) >= 2);
    assert!(count(|c| matches!(c, Call::DeleteTextures(_))) > 0);
    for version in 1..=2 {
        audit.observe(Event::ReleaseResource(version)).unwrap();
    }
    audit.observe(Event::Destroy).unwrap();
    audit.finish().unwrap();
}
