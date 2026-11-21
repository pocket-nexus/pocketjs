use super::*;
use pocket_gles::mock::{self, Call};
use pocket_gles::Pipeline as _;

#[test]
fn restores_fixed_function_state_and_vertex_layout_each_frame() {
    mock::reset();
    unsafe {
        let mut pipeline = Pipeline::new().unwrap();
        mock::with(|gl| gl.calls.clear());
        pipeline.begin_frame(320.0, 480.0);
        pipeline.set_blend();
        pipeline.bind_vertices(20);
        pipeline.unbind_vertices();
        pipeline.destroy();
    }
    let calls = mock::calls();
    assert!(calls.contains(&Call::Enable(GL_TEXTURE_2D)));
    assert!(calls.contains(&Call::TexEnvi(
        GL_TEXTURE_ENV,
        GL_TEXTURE_ENV_MODE,
        GL_MODULATE
    )));
    assert!(calls.contains(&Call::ShadeModel(GL_SMOOTH)));
    assert!(calls.contains(&Call::Orthof([0.0, 320.0, 480.0, 0.0, -1.0, 1.0])));
    assert!(calls.contains(&Call::MatrixMode(GL_TEXTURE)));
    assert!(calls.contains(&Call::VertexPointer(2, GL_FLOAT, 20, 0)));
    assert!(calls.contains(&Call::TexCoordPointer(2, GL_FLOAT, 20, 8)));
    assert!(calls.contains(&Call::ColorPointer(4, GL_UNSIGNED_BYTE, 20, 16)));
    assert_eq!(
        calls
            .iter()
            .filter(|call| matches!(call, Call::DisableClientState(_)))
            .count(),
        3
    );
}
