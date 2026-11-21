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
