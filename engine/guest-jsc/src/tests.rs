use crate::jsc::*;
use crate::*;
use pocket_runtime::generated_ops::BINDING_GENERATION;
use pocket_runtime::{AssetRegistry, Guest, GuestEnvironment, GuestFrame, OpContext, RuntimeError};

fn environment(assets: Option<&AssetRegistry>) -> GuestEnvironment<'_> {
    GuestEnvironment {
        host: "binding-test",
        host_abi: BINDING_GENERATION,
        tick_hz: 60,
        sim_hz: 30,
        viewport: [480, 272],
        auxiliary_viewport: None,
        auxiliary_root: 0,
        raster_density: 1,
        heap_limit: 0,
        pak: &[],
        worker_javascript: &[],
        assets,
    }
}

fn guest() -> (JscGuest, OpContext) {
    let ops = OpContext::from_ui(pocketjs_core::Ui::new());
    let mut guest = JscGuest::new("test");
    guest.initialize(ops.clone(), &environment(None)).unwrap();
    (guest, ops)
}

fn eval(guest: &JscGuest, source: &str) -> Value {
    let ctx = guest.realm().ctx().unwrap();
    ctx.eval(source, "test.js").unwrap()
}
fn truth(guest: &JscGuest, source: &str) -> bool {
    let ctx = guest.realm().ctx().unwrap();
    eval(guest, source).to_bool(ctx)
}
fn number(guest: &JscGuest, source: &str) -> f64 {
    let ctx = guest.realm().ctx().unwrap();
    eval(guest, source).to_num(ctx)
}
fn text(guest: &JscGuest, source: &str) -> String {
    let ctx = guest.realm().ctx().unwrap();
    eval(guest, source).to_string(ctx)
}

#[test]
fn namespace_omits_unregistered_providers_and_preserves_metadata_presence() {
    let (guest, _) = guest();
    assert!(truth(
        &guest,
        "ui.__host==='binding-test' && ui.__tickHz===60 && ui.__viewport.w===480 && __simHz===30"
    ));
    assert_eq!(number(&guest, "ui.__hostAbi"), BINDING_GENERATION as f64);
    assert!(truth(
        &guest,
        "['svcOpen','videoOpen','appLaunch','physicsCreate','loadTileTexture','hitTestAuxiliary','__textures','__sprites'].every(k=>!(k in ui))"
    ));
    assert!(truth(
        &guest,
        "['setPropBatch','takeAnimationCompletions','fontStreamBatch','captureTexts','capturedTexts'].every(k=>typeof ui[k]==='function')"
    ));
    assert!(truth(&guest, "ui.createNode.name==='createNode' && ui.createNode.length===1 && typeof ui.createNode.call==='function'"));
    let mut native = JscGuest::new("assets");
    let assets = AssetRegistry::default();
    native
        .initialize(
            OpContext::from_ui(pocketjs_core::Ui::new()),
            &environment(Some(&assets)),
        )
        .unwrap();
    assert!(truth(
        &native,
        "Object.getPrototypeOf(ui.__textures)===null && Object.keys(ui.__sprites).length===0"
    ));
}

#[test]
fn binding_generation_is_checked_before_creating_or_replacing_a_realm() {
    let mut guest = JscGuest::new("generation");
    let ops = OpContext::from_ui(pocketjs_core::Ui::new());
    for generation in (0..12).chain([BINDING_GENERATION + 1, u32::MAX]) {
        let mut env = environment(None);
        env.host_abi = generation;
        assert_eq!(
            guest.initialize(ops.clone(), &env),
            Err(RuntimeError::Guest)
        );
        assert!(guest
            .last_error()
            .unwrap()
            .contains("Unsupported UI binding generation"));
        assert!(guest.realm().ctx().is_none());
    }
    guest.initialize(ops.clone(), &environment(None)).unwrap();
    guest
        .evaluate(b"globalThis.retained=ui.createNode;globalThis.marker=42\0")
        .unwrap();
    let mut bad = environment(None);
    bad.host_abi = 0;
    assert_eq!(guest.initialize(ops, &bad), Err(RuntimeError::Guest));
    assert!(truth(
        &guest,
        "marker===42 && retained===ui.createNode && retained(0)>0"
    ));
}

#[test]
fn setup_runs_after_ui_and_before_the_package() {
    let ops = OpContext::from_ui(pocketjs_core::Ui::new());
    let mut guest = JscGuest::new("setup").with_setup(|ctx| {
        let host = ctx.object();
        host.set(
            ctx,
            "sawUi",
            ctx.bool(!ctx.global().get(ctx, "ui").is_undefined(ctx)),
        );
        ctx.global().set(ctx, "host", host);
        Ok(())
    });
    guest.initialize(ops, &environment(None)).unwrap();
    guest
        .evaluate(b"globalThis.ok = host.sawUi === true")
        .unwrap();
    assert!(truth(&guest, "ok"));
}

#[test]
fn typed_array_offset_is_borrowed_after_reentrant_scalar_coercion() {
    let (guest, ops) = guest();
    let handle = number(
        &guest,
        "ui.uploadTexture(new Uint8Array([99,99,99,99,10,20,30,255]).subarray(4), {valueOf(){ui.createNode(0);return 1}},1,3)",
    ) as i32;
    let core = ops.core().unwrap();
    assert_eq!(core.ui.texture(handle).unwrap().pixels, &[10, 20, 30, 255]);
}

#[test]
fn strings_coerce_reentrantly_and_unpaired_surrogates_match_quickjs() {
    let (guest, ops) = guest();
    let id = number(&guest, "(()=>{let id=ui.createNode(1);ui.setText(id,{toString(){ui.createNode(0);return 'ok'}});return id})()") as i32;
    assert_eq!(ops.core().unwrap().ui.node_text(id), Some("ok"));
    let lone = number(
        &guest,
        "(()=>{let id=ui.createNode(1);ui.setText(id,'\\ud800');return id})()",
    ) as i32;
    assert_eq!(
        ops.core().unwrap().ui.node_text(lone),
        Some("\u{fffd}\u{fffd}\u{fffd}")
    );
    let number_text = number(
        &guest,
        "(()=>{let id=ui.createNode(1);ui.setText(id,42);return id})()",
    ) as i32;
    assert_eq!(ops.core().unwrap().ui.node_text(number_text), Some("42"));
}

#[test]
fn missing_arguments_throw_type_errors_and_empty_results_follow_the_profile() {
    let (guest, _) = guest();
    assert!(truth(
        &guest,
        "(()=>{try{ui.createNode();return false}catch(e){return e instanceof TypeError}})()"
    ));
    assert!(truth(&guest, "(()=>{try{ui.uploadTexture(5,1,1,3);return false}catch(e){return e instanceof TypeError}})()"));
    assert!(truth(&guest, "(()=>{try{ui.setText(ui.createNode(1),{toString(){throw 7}});return false}catch(e){return e===7}})()"));
    assert_eq!(text(&guest, "ui.takeAnimationCompletions()"), "[]");
    assert_eq!(text(&guest, "JSON.stringify(ui.wrapText('',0,100))"), "[]");
}

#[test]
fn detached_views_are_rejected() {
    let (guest, _) = guest();
    assert!(truth(
        &guest,
        "(()=>{const buf=new ArrayBuffer(4);const view=new Uint8Array(buf);try{ui.uploadTexture(view,{valueOf(){buf.transfer();return 1}},1,3);return false}catch(e){return true}})()"
    ));
}

#[test]
fn frame_passes_eleven_arguments_and_drains_jobs() {
    let (mut guest, _) = guest();
    guest
        .evaluate(b"globalThis.frame=(...args)=>{globalThis.received=args;Promise.resolve().then(()=>globalThis.drained=true)}")
        .unwrap();
    let delta = pocket_drivers::AxisDelta { id: 1, delta: -5 };
    #[allow(clippy::field_reassign_with_default)]
    let mut motion = pocket_drivers::MotionState::default();
    motion.timestamp = 100;
    guest
        .frame(&GuestFrame {
            buttons: 9,
            analog: 0x8080,
            touches: &[0x40040000],
            hits: &[0],
            touch_surfaces: &[1],
            right_analog: 0x807f,
            axis_deltas: &[delta],
            motion: Some(&motion),
            text: &[
                pocket_drivers::TextEvent::Commit("hi".into()),
                pocket_drivers::TextEvent::Key {
                    key: "Enter".into(),
                    pressed: true,
                    repeat: false,
                },
            ],
            pointer: Some(pocket_drivers::Pointer {
                surface: 0,
                x: 1500.5,
                y: 7.25,
                buttons: 0,
            }),
            scroll: [0.0, -12.5],
            touch_positions: &[0.0, 0.0],
        })
        .unwrap();
    assert!(truth(
        &guest,
        "received.length===11 && received[10].length===2 && received[10][0]===0 && received[2][0]===0x40040000 && received[4][0]===1 && received[6][0].axis===1 && received[6][0].delta===-5 && received[7].timestamp===100 && received[8].length===2 && received[8][0].kind===2 && received[8][0].text==='hi' && received[8][1].kind===0 && received[8][1].text==='Enter' && received[8][1].repeat===false && JSON.stringify(received[9])==='{\"surface\":0,\"x\":1500.5,\"y\":7.25,\"buttons\":0,\"scrollX\":0,\"scrollY\":-12.5}' && drained"
    ));
}

#[test]
fn a_frame_that_throws_reports_the_message_and_stack() {
    let (mut guest, _) = guest();
    guest
        .evaluate(b"globalThis.frame=()=>{throw new Error('boom')}")
        .unwrap();
    let frame = GuestFrame {
        buttons: 0,
        analog: 0x8080,
        touches: &[],
        hits: &[],
        touch_surfaces: &[],
        right_analog: 0x8080,
        axis_deltas: &[],
        motion: None,
        text: &[],
        pointer: None,
        scroll: [0.0; 2],
        touch_positions: &[],
    };
    assert_eq!(guest.frame(&frame), Err(RuntimeError::Guest));
    assert!(guest.last_error().unwrap().contains("boom"));
}

#[test]
fn int32_coercion_wraps_like_ecmascript() {
    assert_eq!(to_int32(f64::NAN), 0);
    assert_eq!(to_int32(f64::INFINITY), 0);
    assert_eq!(to_int32(-1.9), -1);
    assert_eq!(to_int32(4294967296.0 + 5.0), 5);
    assert_eq!(to_int32(2147483648.0), i32::MIN);
    assert_eq!(to_int32(-2147483649.0), i32::MAX);
    assert_eq!(
        to_int32(1e21),
        (1e21f64).rem_euclid(4294967296.0) as u64 as u32 as i32
    );
}
