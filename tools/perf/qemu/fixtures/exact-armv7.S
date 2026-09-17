/* SPDX-License-Identifier: MIT */

    .syntax unified
    .arch armv7-a
    .thumb
    .text
    .global _start
    .type _start, %function
    .thumb_func
_start:
    /* BEGIN(version=1, phase=7, iteration=0). Setup is not measured. */
    movw r10, #0x424d
    movt r10, #0x504a
    mov r0, r10
    movw r1, #0x0101
    movs r2, #7
    movs r3, #0
    movw r4, #0xc0de
    movt r4, #0xc001
    movw r7, #4096
    svc #0

    /* Exactly 18 dispatched 16-bit instructions, one load and one store. */
    movs r5, #0
    movs r6, #3
1:
    adds r5, #1
    subs r6, #1
    bne 1b
    sub sp, #4
    str r5, [sp, #0]
    ldr r6, [sp, #0]
    add sp, #4

    /* Restore magic (BEGIN returned zero), then change opcode 1 to opcode 2. */
    mov r0, r10
    adds r1, #1
    svc #0

    /* Linux ARM EABI exit(0). This is outside the measurement. */
    movs r0, #0
    movs r7, #1
    svc #0
    .size _start, .-_start

    .section .note.GNU-stack,"",%progbits
