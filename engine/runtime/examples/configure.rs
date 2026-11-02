fn main() {
    use pocket_runtime::{Cow, InputClasses, Profile, Runtime, RuntimeConfig};

    let runtime = Runtime::new(RuntimeConfig {
        profile_hash: [0x5a; 32], // Example identity; production uses exported facts.
        host_abi: pocket_drivers::spec::BINDING_GENERATION,
        heap_limit: 1024 * 1024,
        frame_buffer_budget: 320 * 240 * 4,
        profile: Profile {
            id: Cow::Borrowed("example"),
            cadences: Cow::Borrowed(&[60]),
            viewport: [320, 240],
            logical_viewports: Cow::Borrowed(&[[320, 240]]),
            dynamic_viewport: None,
            presentations: Cow::Borrowed(&[Cow::Borrowed("native")]),
            auxiliary: None,
            auxiliary_logical: Cow::Borrowed(&[]),
            density: 1,
            animation: Cow::Borrowed("composited"),
            capabilities: Cow::Borrowed(&[]),
            required_inputs: InputClasses::NONE,
        },
    })
    .unwrap();
    assert!(runtime.op_context().supports_op(1));
    assert!(runtime.timing().is_none()); // Timing is chosen when a package boots.
}
