.syntax unified
.section .gba.header,"ax"
.arm
.global _start
.type _start, %function
_start:
    b boot
    .space 188
boot:
    mov r0, #0x12
    orr r0, r0, #0xc0
    msr cpsr_c, r0
    ldr sp, =0x03007fa0
    mov r0, #0x1f
    orr r0, r0, #0x40
    msr cpsr_c, r0
    ldr sp, =0x03007f00
    // Watermark the user stack before entering Rust.
    ldr r0, =0x03000000
    ldr r1, =0xdeadbeef
0:  cmp r0, sp
    strlo r1, [r0], #4
    blo 0b
    ldr r0, =__data_load
    ldr r1, =__data_start
    ldr r2, =__data_end
1:  cmp r1, r2
    ldrlo r3, [r0], #4
    strlo r3, [r1], #4
    blo 1b
    ldr r1, =__bss_start
    ldr r2, =__bss_end
    mov r3, #0
2:  cmp r1, r2
    strlo r3, [r1], #4
    blo 2b
    ldr r0, =gba_main
    bx r0

.section .text.gba_irq,"ax"
.arm
.global gba_irq
.type gba_irq, %function
gba_irq:
    ldr r0, =0x04000202
    ldrh r1, [r0]
    strh r1, [r0]
    tst r1, #1
    beq 3f
    ldr r0, =0x02000010
    ldr r1, [r0]
    add r1, r1, #1
    str r1, [r0]
    // Sample transitions at LCD rate, even while a slow UI frame is drawing.
    // SPSC queue: words 22/23 producer/consumer, 24 latest, 25 overflow;
    // sixteen raw GBA key states at diagnostic word 32.
    ldr r0, =0x04000130
    ldrh r1, [r0]
    mvn r1, r1
    ldr r2, =0x03ff
    and r1, r1, r2
    ldr r0, =0x02000060
    ldr r2, [r0]
    cmp r1, r2
    beq 3f
    ldr r0, =0x02000058
    ldr r2, [r0]
    ldr r3, [r0, #4]
    sub r3, r2, r3
    cmp r3, #16
    bhs 4f
    // Commit dedup state only after reserving a slot. A dropped final
    // release is retried next VBlank instead of leaving a button stuck.
    str r1, [r0, #8]
    and r3, r2, #15
    add r3, r0, r3, lsl #2
    str r1, [r3, #40]
    add r2, r2, #1
    str r2, [r0]
    b 3f
4:  ldr r1, [r0, #12]
    add r1, r1, #1
    str r1, [r0, #12]
3:  bx lr

// ARM7TDMI is single-core, in-order, with no data cache or write buffer.
// LLVM's external barrier call already prevents compiler reordering.
.global __sync_synchronize
.type __sync_synchronize, %function
__sync_synchronize:
    bx lr
