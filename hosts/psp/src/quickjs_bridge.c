/* The PSP may enter JS with different exception/status bits in FCSR.
 * Canonical Rust operations use the host's masked IEEE environment; restoring
 * the caller's register after dispatch keeps this boundary nestable. */
#define pocket_runtime_op pocket_psp_runtime_op
#include "../../../engine/guest-quickjs/src/guest.c"
#undef pocket_runtime_op
_Static_assert(sizeof(JSValue) == sizeof(uint64_t), "PSP QuickJS uses NaN-boxed JSValue");
extern int32_t pocket_runtime_op(pocket_runtime *, uint16_t, const void *, size_t, pocket_result *);
void pocket_psp_fpu_reset(void) {
    __asm__ volatile ("ctc1 $zero, $31" ::: "memory");
}
unsigned pocket_psp_fpu_mask(void) {
    unsigned saved;
    __asm__ volatile ("cfc1 %0, $31\n\tctc1 $zero, $31" : "=r"(saved) :: "memory");
    return saved;
}
void pocket_psp_fpu_restore(unsigned saved) {
    __asm__ volatile ("ctc1 %0, $31" :: "r"(saved) : "memory");
}
int32_t pocket_psp_runtime_op(pocket_runtime *runtime, uint16_t op,
                            const void *args, size_t length, pocket_result *result) {
    unsigned saved = pocket_psp_fpu_mask();
    int32_t status = pocket_runtime_op(runtime, op, args, length, result);
    pocket_psp_fpu_restore(saved);
    return status;
}
