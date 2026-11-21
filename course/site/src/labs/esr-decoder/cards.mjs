// Spec-hunt cards for the reading-arm-specs primer. Data only. The view shows them only in the
// primer and on the standalone page: several (DRIVER_OK, MagicValue, the DTB magic) would spoil
// chapters that come after chapter 07, where the lab is also embedded.
//
// Each card asks a question to answer with the primary document open, then says where the
// answer lives and what it is. Cards with an `esr` open the decoder with that value; `expect`
// is checked by model.test.mjs so a card can never contradict the decoder.
export const CARDS = Object.freeze([
  {
    id: "sctlr-a",
    question: "What does SCTLR_EL1.A do?",
    where: "ARM ARM (DDI 0487), register page \"SCTLR_EL1, System Control Register (EL1)\", field A (bit 1).",
    answer: "Alignment check enable. When it is 1, a load or store whose address is not a multiple of its size takes an Alignment fault. When it is 0, ordinary loads and stores to Normal memory may be unaligned, though some accesses (exclusives, and any access to Device memory) must be aligned whatever A says. Chapter 06's self-fault guest sets it before its unaligned load. With translation off, that load would fault even with A = 0, because every access is then treated as Device memory; setting A makes the cause show up in a register. Its ESR_EL1 is the value this card opens.",
    esr: 0x96000021n,
    expect: { kind: "Unknown", ec: 0x25 },
  },
  {
    id: "dfsc-alignment",
    question: "What is DFSC 0b100001?",
    where: "ARM ARM, register page ESR_EL2, \"ISS encoding for an exception from a Data Abort\", field DFSC (bits 5 to 0).",
    answer: "Alignment fault. The other codes nearby are worth a look too: 0b0001LL are translation faults at level LL, 0b0011LL permission faults.",
    esr: 0x93000021n,
    expect: { kind: "DataAbort", dfsc: 0x21 },
  },
  {
    id: "driver-ok",
    question: "Who sets the DRIVER_OK status bit, the driver or the device?",
    where: "virtio 1.2, section 2.1 \"Device Status Field\", and section 3.1.1 \"Driver Requirements: Device Initialization\".",
    answer: "The driver (the guest), as the last step of initialization: DRIVER_OK (4) says the driver is set up and ready to drive the device. The device requirements say the device must not consume buffers or send used-buffer notifications before it, so our VMM checks for DRIVER_OK; it never assumes it.",
  },
  {
    id: "hvc-ec",
    question: "Which exception class does an hvc from AArch64 report, and where is its immediate?",
    where: "ARM ARM, register page ESR_EL2, field EC, the row for 0b010110, then the ISS encoding that row points to.",
    answer: "EC 0x16, \"HVC instruction execution in AArch64 state\". The 16-bit immediate is ISS bits 15 to 0; bits 24 to 16 are RES0.",
    esr: 0x5a000000n,
    expect: { kind: "Hvc", imm: 0 },
  },
  {
    id: "sysreg-direction",
    question: "In a trapped mrs or msr (EC 0x18), which bit says read or write, and which value means mrs?",
    where: "ARM ARM, register page ESR_EL2, \"ISS encoding for an exception from MSR, MRS, or System instruction execution in AArch64 state\", field Direction.",
    answer: "Bit 0, Direction: 1 is a read of the system register into Rt (mrs), 0 a write from Rt (msr). Rt is bits 9 to 5, and Op0, Op1, CRn, CRm and Op2 name the register.",
    esr: 0x6230e499n,
    expect: { kind: "SysReg", read: true, rt: 4 },
  },
  {
    id: "sas-11",
    question: "SAS is 0b11. How many bytes did the access move, and when may you believe it?",
    where: "ARM ARM, register page ESR_EL2, \"ISS encoding for an exception from a Data Abort\", fields SAS and ISV.",
    answer: "8 bytes, a doubleword (the size is 1 << SAS). Only when ISV is 1: with ISV = 0, bits 23 to 14, SAS among them, are RES0 and say nothing.",
    esr: 0x93c18046n,
    expect: { kind: "DataAbort", isv: true, sas: 3 },
  },
  {
    id: "srt-31",
    question: "In a data abort with ISV = 1, SRT is 31. Which register is that?",
    where: "ARM ARM, register page ESR_EL2, the Data Abort ISS, field SRT; and the load/store pseudocode, where the data register is written X[t].",
    answer: "The zero register (xzr, or wzr when SF is 0): a load into it is discarded and a store from it stores 0. For a load or store's data register, 31 is never sp.",
    esr: 0x93df8046n,
    expect: { kind: "DataAbort", srt: 31, sf: true },
  },
  {
    id: "perm-l3",
    question: "Which DFSC does a permission fault at level 3 report?",
    where: "ARM ARM, register page ESR_EL2, the Data Abort ISS, field DFSC.",
    answer: "0b001111 (0x0f): the 0b0011LL group is permission faults, with LL = 3 for level 3.",
    esr: 0x93c0804fn,
    expect: { kind: "DataAbort", dfsc: 0x0f },
  },
  {
    id: "dtb-magic",
    question: "What must the first four bytes of a DTB hold, and in which byte order?",
    where: "Devicetree Specification v0.4, section 5.2 \"Header\".",
    answer: "The magic number 0xd00dfeed, stored big-endian, so the bytes are d0 0d fe ed. Every header field is a big-endian 32-bit integer.",
  },
  {
    id: "virtio-mmio-magic",
    question: "What does a virtio-mmio device's MagicValue register read?",
    where: "virtio 1.2, section 4.2.2 \"MMIO Device Register Layout\".",
    answer: "0x74726976, the string \"virt\" read as a little-endian 32-bit value, at offset 0x000.",
  },
]);
