# Linker script for every test guest (PLAN M3). Read by rust-lld, whose script lexer accepts `#`
# comments (GNU ld would need `/* */`).
#
# Where things go and why:
# - Everything starts at 0x40080000: RAM begins at 0x40000000 (QEMU `virt` map, PLAN §1) and the
#   first 512 KiB are the DTB slot, so a test guest is linked just past it (CURRICULUM ch03).
# - `.text.boot` (the `_start` in common/start.rs) comes first, so the entry point is the first
#   byte of the image. That is what makes `--raw hello.bin@0x40080000` work: a flat binary has
#   no ELF header to name its entry, so the VMM starts at the load address.
# - `.vectors` is 2 KiB-aligned: VBAR_EL1 bits [10:0] are RES0 (ARM ARM, VBAR_EL1 register
#   description).
# - The BSS holds eight 64 KiB stacks, one per CPU (indexed by MPIDR_EL1.Aff0, start.rs), all
#   16-byte aligned (AAPCS64 §6.4.5.1: SP must be 16-byte aligned at every public interface).
#   The BSS is zeroed by CPU 0 before any Rust code runs, so it is not in the file.
# ANCHOR: guest_linker_script
ENTRY(_start)
EXTERN(_start)

SECTIONS
{
  . = 0x40080000;
  __image_start = .;

  .text : {
    KEEP(*(.text.boot))
    . = ALIGN(2048);
    KEEP(*(.vectors))
    *(.text .text.*)
  }

  .rodata : ALIGN(16) {
    *(.rodata .rodata.*)
  }

  .data : ALIGN(16) {
    *(.data .data.*)
  }

  .bss (NOLOAD) : ALIGN(16) {
    __bss_start = .;
    *(.bss .bss.*)
    *(COMMON)
    . = ALIGN(16);
    __stacks_start = .;
    . += 8 * 0x10000;
    __stacks_end = .;
    __bss_end = .;
  }

  __image_end = .;

  /DISCARD/ : {
    *(.comment)
    *(.note .note.*)
    *(.eh_frame .eh_frame_hdr)
  }
}
# ANCHOR_END: guest_linker_script
