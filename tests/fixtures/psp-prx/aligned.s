.set noreorder
.section .text,"ax",@progbits
.globl module_start
module_start:
 .cfi_startproc
 jr $ra
 nop
 .cfi_endproc

.section .rodata.sceModuleInfo,"a",@progbits
.p2align 4
.long 0x01010000
.ascii "layout-test"
.space 21
.long 0,0,0,0,0

.section .rodata.aligned,"a",@progbits
.p2align 6
.long 0x12345678

.section .data,"aw",@progbits
.long module_start

.section .bss,"aw",@nobits
.p2align 4
.space 64
