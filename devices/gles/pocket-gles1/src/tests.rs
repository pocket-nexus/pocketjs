use super::*;
use pocket_gles::Pipeline as _;
use std::{cell::RefCell, vec::Vec};
std::thread_local! { static EVENTS: RefCell<Vec<(u32,Vec<f32>)>> = const { RefCell::new(Vec::new()) }; }
fn event(kind: u32, args: &[f32]) {
    EVENTS.with(|events| events.borrow_mut().push((kind, args.to_vec())));
}
#[no_mangle]
unsafe extern "C" fn glGetError() -> u32 {
    0
}
#[no_mangle]
unsafe extern "C" fn glActiveTexture(x: u32) {
    event(1, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glBlendFunc(x: u32, y: u32) {
    event(2, &[x as f32, y as f32]);
}
#[no_mangle]
unsafe extern "C" fn glEnable(x: u32) {
    event(3, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glEnableClientState(x: u32) {
    event(4, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glDisableClientState(x: u32) {
    event(5, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glLoadIdentity() {
    event(6, &[]);
}
#[no_mangle]
unsafe extern "C" fn glMatrixMode(x: u32) {
    event(7, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glShadeModel(x: u32) {
    event(8, &[x as f32]);
}
#[no_mangle]
unsafe extern "C" fn glTexEnvi(x: u32, y: u32, z: i32) {
    event(9, &[x as f32, y as f32, z as f32]);
}
#[no_mangle]
unsafe extern "C" fn glOrthof(a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) {
    event(10, &[a, b, c, d, e, f]);
}
#[no_mangle]
unsafe extern "C" fn glVertexPointer(a: i32, b: u32, c: i32, d: *const c_void) {
    event(11, &[a as f32, b as f32, c as f32, d as usize as f32]);
}
#[no_mangle]
unsafe extern "C" fn glTexCoordPointer(a: i32, b: u32, c: i32, d: *const c_void) {
    event(12, &[a as f32, b as f32, c as f32, d as usize as f32]);
}
#[no_mangle]
unsafe extern "C" fn glColorPointer(a: i32, b: u32, c: i32, d: *const c_void) {
    event(13, &[a as f32, b as f32, c as f32, d as usize as f32]);
}
#[test]
fn restores_fixed_function_state_and_vertex_layout_each_frame() {
    unsafe {
        let mut pipeline = Pipeline::new().unwrap();
        EVENTS.with(|events| events.borrow_mut().clear());
        pipeline.begin_frame(320.0, 480.0);
        pipeline.set_blend();
        pipeline.bind_vertices(20);
        pipeline.unbind_vertices();
        pipeline.destroy();
    }
    EVENTS.with(|events| {
        let events = events.borrow();
        assert!(events.contains(&(3, std::vec![GL_TEXTURE_2D as f32])));
        assert!(events.contains(&(
            9,
            std::vec![
                GL_TEXTURE_ENV as f32,
                GL_TEXTURE_ENV_MODE as f32,
                GL_MODULATE as f32
            ]
        )));
        assert!(events.contains(&(8, std::vec![GL_SMOOTH as f32])));
        assert!(events.contains(&(10, std::vec![0.0, 320.0, 480.0, 0.0, -1.0, 1.0])));
        assert!(events.contains(&(7, std::vec![GL_TEXTURE as f32])));
        assert!(events.contains(&(11, std::vec![2.0, GL_FLOAT as f32, 20.0, 0.0])));
        assert!(events.contains(&(12, std::vec![2.0, GL_FLOAT as f32, 20.0, 8.0])));
        assert!(events.contains(&(13, std::vec![4.0, GL_UNSIGNED_BYTE as f32, 20.0, 16.0])));
        assert_eq!(events.iter().filter(|(kind, _)| *kind == 5).count(), 3);
    });
}
