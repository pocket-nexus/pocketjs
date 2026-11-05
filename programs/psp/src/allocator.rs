//! Program-owned selection of the shared Rust / QuickJS / C heap.
const fn bytes() -> usize {
    let input = env!("POCKETJS_ARENA_BYTES").as_bytes();
    let mut value = 0usize;
    let mut i = 0;
    while i < input.len() {
        if input[i] < b'0' || input[i] > b'9' {
            break;
        }
        value = value
            .saturating_mul(10)
            .saturating_add((input[i] - b'0') as usize);
        i += 1;
    }
    value
}
/// Private platform startup hook. C and Rust share this immutable budget.
#[no_mangle]
pub extern "C" fn pocket_psp_arena_capacity() -> usize {
    bytes()
}
#[global_allocator]
static GLOBAL: pocket_psp_alloc::ArenaAlloc = pocket_psp_alloc::ArenaAlloc;
