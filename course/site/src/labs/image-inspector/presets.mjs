// image-inspector presets: the bytes this lab knows about the two kernels the course downloads.
//
// Only a few hundred bytes of each file are here, never the kernels themselves. They were read
// with xxd from the reference Mac's .cache/macvmm/Image-virt and .cache/macvmm/vmlinuz-virt
// (Alpine linux-virt 6.18.60; sha256 a2cecb9b... and cd05fed9... as pinned in
// scripts/fetch-manifest.txt). The first 64 bytes of each match the captures
// course/captures/13-image-header.txt and 13-zboot-header.txt; model.test.mjs checks that, and
// re-reads the real files when they are present.
//
// Every other byte of a preset file is "not read": the inspector says so instead of guessing.

/** The two files. `chunks` are [file offset, hex bytes]. `length` is the real file length. */
export const BASES = {
  image: {
    label: "Alpine Image-virt (the unwrapped kernel)",
    file: ".cache/macvmm/Image-virt",
    length: 36306944n,
    initrd: 9427196n,
    chunks: [
      [
        0,
        "4d5a40fa27b45514000000000000000000002a02000000000a00000000000000" +
        "00000000000000000000000000000000000000000000000041524d6440000000" +
        "5045000064aa0200000000000000000000000000a00006020b02021400006801" +
        "0000c100000000004c2a64010000010000000000000000000000010000020000" +
        "0000000003000000000000000000000000002a0200000100000000000a000001" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "0000000006000000000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000002e74657874000000" +
        "0000680100000100000068010000010000000000000000000000000020000060" +
        "2e646174610000000000c10000006901002a2e00000069010000000000000000" +
        "00000000400000c01f2003d51f2003d51f2003d51f2003d51f2003d51f2003d5" +
        "1f2003d51f2003d51f2003d51f2003d51f2003d51f2003d51f2003d51f2003d5",
      ],
    ],
  },
  zboot: {
    label: "Alpine vmlinuz-virt (the EFI zboot wrapper, as downloaded)",
    file: ".cache/macvmm/vmlinuz-virt",
    length: 10412544n,
    initrd: null,
    chunks: [
      [
        0,
        "4d5a00007a696d6778ca00004bfb9d000000000000000000677a697000000000" +
        "000000000000000000000000000000000000000000000000cd23828140000000" +
        "5045000064aa0200000000000000000000000000a00006020b02000000d09e00" +
        "0004000000000000281000000010000000000000000000000010000000020000" +
        "0000000003000000000000000000000000e49e0000100000000000000a000001" +
        "0000000000000000000000000000000000000000000000000000000000000000" +
        "0000000006000000000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000002e74657874000000" +
        "00d09e000010000000d09e000010000000000000000000000000000020000060" +
        "2e646174610000000004000000e09e000002000000e09e000000000000000000" +
        "00000000400000c0000000000000000000000000000000000000000000000000" +
        "0000000000000000000000000000000000000000000000000000000000000000",
      ],
      // The gzip member's 10-byte header at the payload offset (0xca78) and its 8-byte trailer
      // (CRC32, then ISIZE) just before the payload's end (0xca78 + 0x9dfb4b = 0x9ec5c3).
      [0xca78, "1f8b0800000000000203"],
      [0x9ec5bb, "7be3ed9e00002a02"],
    ],
  },
};

/**
 * The "Try" list: each is a base file plus byte patches (offset -> byte, inside the first 64
 * bytes), an optional file length and an optional initrd. Where the course ran the same
 * experiment on the reference Mac, `capture` names the capture whose message the lab must print.
 */
export const TRIES = [
  {
    id: "alpine",
    label: "Alpine Image-virt, unchanged",
    base: "image",
    patches: {},
    capture: "13-dry-run.txt",
    note: "The kernel chapter 14 boots. Every check passes and the plan matches chapter 13's dry run.",
  },
  {
    id: "huge",
    label: "image_size patched to all ff (the Predict fork)",
    base: "image",
    patches: { 16: 0xff, 17: 0xff, 18: 0xff, 19: 0xff, 20: 0xff, 21: 0xff, 22: 0xff, 23: 0xff },
    capture: "13-image-size-max.txt",
    note: "Every header check passes. Placement fails: 0x40200000 + 0xffffffffffffffff overflows 64 bits.",
  },
  {
    id: "badmagic",
    label: "Magic byte at 0x38 changed from A to B",
    base: "image",
    patches: { 56: 0x42 },
    capture: "13-bad-magic.txt",
    note: "Without ARM\\x64 the file is not an Image at all, so --initrd is refused before any header check.",
  },
  {
    id: "bigendian",
    label: "flags bit 0 set (a big-endian kernel)",
    base: "image",
    patches: { 24: 0x0b },
  },
  {
    id: "pages64k",
    label: "flags page size 3 (64 KiB pages)",
    base: "image",
    patches: { 24: 0x0e },
  },
  {
    id: "zerosize",
    label: "image_size 0 (a kernel older than 3.17)",
    base: "image",
    patches: { 16: 0, 17: 0, 18: 0, 19: 0 },
  },
  {
    id: "unaligned",
    label: "text_offset 0x80 (not 4 KiB-aligned)",
    base: "image",
    patches: { 8: 0x80 },
  },
  {
    id: "oldoffset",
    label: "text_offset 0x80000 (what kernels before 5.8 wrote)",
    base: "image",
    patches: { 10: 0x08 },
    note: "Aligned, so it passes. The kernel moves up by 0x80000 and the initrd follows it.",
  },
  {
    id: "bss",
    label: "image_size 0x1800000, file 0x1400000 (a kernel with BSS)",
    base: "image",
    patches: { 18: 0x80, 19: 0x01 },
    length: 0x1400000n,
    note: "The numbers of the arm64-boot-protocol primer's question. Open the tempting wrong plan below the real one: the initramfs right after the file's last byte loses its first 4 MiB to the BSS.",
  },
  {
    id: "longer",
    label: "File one byte longer than image_size",
    base: "image",
    patches: {},
    length: 0x22a0001n,
  },
  {
    id: "short",
    label: "File cut to 63 bytes",
    base: "image",
    patches: {},
    length: 63n,
  },
  {
    id: "zboot",
    label: "Alpine vmlinuz-virt, as downloaded",
    base: "zboot",
    patches: {},
    capture: "13-zboot-refused.txt",
    note: "The loader recognises MZ and zimg and refuses the wrapper by name.",
  },
  {
    id: "zbootpast",
    label: "zboot payload size runs past the end of the file",
    base: "zboot",
    patches: { 8: 0x00, 9: 0x10, 10: 0x00, 11: 0x00, 12: 0x00, 13: 0xf8, 14: 0xff, 15: 0xff },
    note: "Offset 0x1000, size 0xfffff800: added in 32 bits the end wraps to 0x800 and looks fine.",
  },
  {
    id: "zbootzstd",
    label: "zboot compression name changed to zstd",
    base: "zboot",
    patches: { 24: 0x7a, 25: 0x73, 26: 0x74, 27: 0x64 },
  },
];
