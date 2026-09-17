/* SPDX-License-Identifier: MIT */

    .arch armv8-a
    .text
    .global _start
    .type _start, %function
_start:
    /* BEGIN(version=1, phase=7, iteration=0). Setup is not measured. */
    movz x10, #0x424d
    movk x10, #0x504a, lsl #16
    mov x0, x10
    mov x1, #0x0101
    mov x2, #7
    mov x3, #0
    movz x4, #0xc0de
    movk x4, #0xc001, lsl #16
    mov x8, #4096
    svc #0

    /* Exactly 18 dispatched 4-byte instructions, one load and one store. */
    mov x5, #0
    mov x6, #3
1:
    add x5, x5, #1
    sub x6, x6, #1
    cbnz x6, 1b
    sub sp, sp, #16
    str x5, [sp]
    ldr x6, [sp]
    add sp, sp, #16

    /* Restore magic (BEGIN returned zero), then change opcode 1 to opcode 2. */
    mov x0, x10
    add x1, x1, #1
    svc #0

    /* Linux AArch64 exit(0). This is outside the measurement. */
    mov x0, #0
    mov x8, #93
    svc #0
    .size _start, .-_start

    .section .note.GNU-stack,"",%progbits
