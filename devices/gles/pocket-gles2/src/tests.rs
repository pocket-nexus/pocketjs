use super::*;
use pocket_gles::mock::{self, Call};
use pocket_gles::Pipeline as _;

#[test]
fn shader_pipeline_retains_color_normalization_and_alpha_blend() {
    mock::reset();
    unsafe {
        let mut pipeline = Pipeline::new().unwrap();
        pipeline.begin_frame(360.0, 640.0);
        pipeline.set_blend();
        pipeline.bind_vertices(20);
        pipeline.unbind_vertices();
        pipeline.destroy();
    }
    let calls = mock::calls();
    mock::with(|gl| {
        assert_eq!(gl.shaders[0], &VERTEX_SHADER[..VERTEX_SHADER.len() - 1]);
        assert_eq!(gl.shaders[1], &FRAGMENT_SHADER[..FRAGMENT_SHADER.len() - 1]);
    });
    assert!(calls.contains(&Call::Uniform2f(0, 360.0, 640.0)));
    assert!(calls.contains(&Call::BlendFuncSeparate(
        GL_SRC_ALPHA,
        GL_ONE_MINUS_SRC_ALPHA,
        GL_ONE,
        GL_ONE_MINUS_SRC_ALPHA
    )));
    for (index, size, kind, normalized, offset) in [
        (0, 2, GL_FLOAT, 0, 0),
        (1, 2, GL_FLOAT, 0, 8),
        (2, 4, GL_UNSIGNED_BYTE, 1, 16),
    ] {
        assert!(calls.contains(&Call::VertexAttribPointer(
            index, size, kind, normalized, 20, offset
        )));
    }
    assert_eq!(
        calls
            .iter()
            .filter(|call| matches!(call, Call::DisableVertexAttribArray(_)))
            .count(),
        3
    );
}

#[test]
fn failed_link_releases_both_shaders_and_program() {
    mock::reset();
    mock::with(|gl| gl.fail_link = true);
    assert!(unsafe { Pipeline::new() }.is_none());
    let calls = mock::calls();
    assert_eq!(
        calls
            .iter()
            .filter(|call| matches!(call, Call::DeleteShader(_)))
            .count(),
        2
    );
    assert_eq!(
        calls
            .iter()
            .filter(|call| matches!(call, Call::DeleteProgram(_)))
            .count(),
        1
    );
}
