# hvf-hello — spike results

Real output from `./run.sh` on the dev machine (2026-11-18): Apple M5 Pro, macOS 27.2.1 (26B131),
rustc 1.99.0, Xcode SDK Hypervisor.framework `current-version: 308.2.7`. The binary is ad-hoc signed
with **only** `com.apple.security.hypervisor`. Every guest program is hand-encoded A64 (`src/enc.rs`).
`./check-encodings.sh` re-assembles each one with clang and compares the bytes:

```
OK: 1025 instructions match clang's encoding
```

The same binary signed **without** the entitlement gets `hv_vm_create -> HV_DENIED (0xfae94007)`.

## What the spike established

| # | Finding | Evidence (section below) |
|---|---------|--------------------------|
| 1 | Host page = 16 KiB. With the default config, `hv_vm_map` needs host VA, IPA and size all 16 KiB-aligned. Anything else returns `HV_BAD_ARGUMENT`. Mapping 0 bytes returns `HV_ERROR`. | align |
| 2 | The default IPA granule is 16KB. `hv_vm_config_set_ipa_granule(HV_IPA_GRANULE_4KB)` (macOS 26+) works. 4 KiB-aligned host VA, IPA and size can then be mapped, and a vCPU runs from a 4 KiB mapping. | align |
| 3 | IPA size: default 36 bits (64 GiB), max 40 bits (1 TiB). The last page below `1<<bits` maps. `1<<bits` is rejected. `set_ipa_size(max+1)` returns `HV_UNSUPPORTED`. | info, align |
| 4 | Max vCPUs = 64. EL2 (nested virt) is supported. SME max SVL = 64 bytes (512-bit). CNTFRQ = 24 MHz. | info |
| 5 | Exit on `hvc #imm`: EC=0x16, imm16 = ISS[15:0], and **PC already points past the HVC** (no advance needed). | basic #1 |
| 6 | Exit on `smc #imm`: EC=0x17, and **PC still points at the SMC** (the VMM must add 4). | basic #6 |
| 7 | MMIO to an unmapped IPA: EC=0x24, ISV=1, SAS/SRT/WnR valid, `exception.physical_address` = faulting IPA, `virtual_address` = FAR. PC points at the faulting instruction (+4 needed). | basic #2,#3 |
| 8 | An `stp` to MMIO gives **ISV=0** (no register info). The VMM must decode the instruction itself or refuse. | basic #5 |
| 9 | `mrs x4, PMCR_EL0` with EL2 off traps as EC=0x18. The ISS fields map one-to-one onto `hv_sys_reg_t` (`op0<<14\|op1<<11\|CRn<<7\|CRm<<3\|op2`, here 0xdce0). | basic #7 |
| 10 | Without a GIC, `wfi` exits with EC=0x01 (TI=0). `wfe` (even two in a row) **does not exit**. | basic #8 |
| 11 | A write to a page mapped READ-only from the start reports DFSC=0x07 (*translation* fault L3). After `hv_vm_protect(RW→R)` of a page already touched, the same write reports DFSC=0x0f (*permission* fault L3). Dirty tracking works: protect, take the fault, re-protect RW, re-run **without** advancing PC. | basic #9–#12 |
| 12 | Without a GIC, the vtimer fires `HV_EXIT_REASON_VTIMER_ACTIVATED` **even with PSTATE.I masked**. The framework then sets the vtimer mask automatically. While masked there are no further exits (watchdog CANCELED after 300 ms). Unmasking while CNTV_CTL.ISTATUS=1 re-exits immediately (level semantics). Default vtimer offset = 0, so guest CNTVCT tracks `mach_absolute_time()`. | basic #14–#16 |
| 13 | **With `hv_gic_create`, the vtimer is fully in-kernel**: zero VTIMER_ACTIVATED exits. PPI 27 is delivered to the guest's IRQ vector and `ICC_IAR1_EL1` = 27. WFI also never exits (the wait shows up in `hv_vcpu_get_wait_for_interrupt_time`). Guest MMIO to GICD/GICR and ICC_* sysregs causes zero exits. | gic |
| 14 | `hv_gic_set_spi(33,true)` from a **non-vCPU thread** wakes a guest sitting in WFI and delivers INTID 33. Deassert with `false` (level). | gic |
| 15 | GIC geometry: GICD 64 KiB / 64 KiB-aligned. Redistributor 128 KiB per vCPU, total region 32 MiB (256 slots), 64 KiB-aligned. MSI frame 64 KiB / 64 KiB-aligned. SPIs are INTID 32..1019. GICD_TYPER=0x478001f (no LPIs, no MBIS), DS=1, ArchRev=3. The QEMU-virt addresses are all accepted. | gic |
| 16 | **Only redistributor frames of *created* vCPUs are claimed by the kernel**. Accesses to the rest of the 32 MiB window, including 0x0900_0000 (PL011) and 0x0a00_0000 (virtio-mmio) that it overlaps, exit to the VMM normally. So the QEMU layout (GICR at 0x080A_0000, 0xF6_0000 window, which fits 123 vCPUs) works. The high placement 0x40_0000_0000 with a 40-bit IPA also works. | gicprobe |
| 17 | Redistributor frames are assigned in **vCPU creation order** (vcpu id), *not* by MPIDR. GICR_TYPER reports Affinity = MPIDR and ProcNum = vcpu id. `Last` is set on the highest id. `hv_gic_get_redistributor_base` returns HV_BAD_ARGUMENT until MPIDR_EL1 has been explicitly written (the default reads 0). | gic, smp |
| 18 | A 32-bit guest read of GICR_TYPER returns 0. A 64-bit read returns the real value (0x10). | gicprobe |
| 19 | `hv_vcpus_exit` works from any thread and on several vCPUs at once. Called before `hv_vcpu_run`, it makes the next run return CANCELED immediately (2 µs). `hv_vcpu_get_reg` from a non-owning thread returns `HV_BAD_ARGUMENT`. A second `hv_vcpu_create` on the same thread, a second `hv_vm_create`, and a second `hv_gic_create` all return `HV_BUSY`. An overlapping `hv_vm_map` returns `HV_ERROR`. A VM can be destroyed and re-created in the same process. | basic, smp, gic |
| 20 | `hv_vcpu_{get,set}_pending_interrupt` return `HV_UNSUPPORTED` once a GIC exists. CNTP_* sysregs become accessible only with a GIC, and EL2 sysregs only with EL2 enabled (otherwise `HV_UNSUPPORTED`). | basic, gic |
| 21 | GIC state is a binary plist (`bplist00…`) of about 123 KiB. `hv_gic_set_state` succeeded even after the vCPU had run (the header says to restore before running). `hv_gic_reset` resets GICD_CTLR to 0x50. | gic |
| 22 | With EL2 enabled, a vCPU started with CPSR=0x3c9 runs at EL2 (`CurrentEL`=8). `HVC` at vEL2 goes to the *guest's own* VBAR_EL2 vector, not to the VMM. PMU access with PMUVer=0 is injected as UNDEFINED into the guest (guest ESR_EL2 EC=0). | el2 |
| 23 | The FFI pitfall: `hv_vcpu_set_simd_fp_reg` takes a 16-byte vector **by value in v0**. Stable Rust rejects SIMD types in `extern "C"`, so the spike calls it with an inline-asm trampoline (`ffi::set_simd_fp_reg`). The Q5 round-trip is verified. | basic |
| 25 | **Timer wake-up from in-kernel WFI arrives about 2–4 ms late.** A vtimer programmed about 15.6 ms ahead is delivered after 17.4–19.6 ms when the guest idles in WFI, and after 15.63 ms when it busy-loops (`HVF_GIC_SPIN=1`). Setting the vCPU thread to QoS USER_INTERACTIVE (`HVF_QOS=1`) did not help. SPI delivery from a host thread did not show the penalty. | supplementary below |
| 24 | `hv_vcpu_create` *after* other vCPUs have run still succeeds and gets the next redistributor slot. Whether such a late vCPU is fully functional was not tested. | smp |

## Supplementary: WFI wake-up latency (run by hand, 2026-11-18)

```text
$ for i in 1 2 3; do ./target/release/hvf-hello gic | grep 'INTID 27'; done
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (17.658583ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (19.574666ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (19.574375ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
$ for i in 1 2 3; do HVF_GIC_SPIN=1 ./target/release/hvf-hello gic | grep 'INTID 27'; done
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (15.634292ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (15.630292ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (15.631416ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
$ for i in 1 2 3 4; do HVF_QOS=1 ./target/release/hvf-hello gic | grep 'INTID 27'; done
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (19.549666ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (19.581708ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (19.574417ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (17.350625ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
```

The guest programs CVAL = CNTVCT + CNTFRQ/64, which is 15.625 ms ahead.

## Raw output

```text
# macOS 27.2.1 (26B131), Apple M5 Pro, rustc 1.99.0 (b940084d7 2026-09-28)

== info: host + framework capabilities ==
  host page size (sysconf)                                   = 0x4000
  host CNTFRQ_EL0                                            = 24000000 Hz
  hv_vm_get_max_vcpu_count                                   -> HV_SUCCESS (0x00000000)
    max vCPUs = 64
  hv_vm_config_get_max_ipa_size                              -> HV_SUCCESS (0x00000000)
  hv_vm_config_get_default_ipa_size                          -> HV_SUCCESS (0x00000000)
    max IPA = 40 bits (1024 GiB), default IPA = 36 bits (64 GiB)
  hv_vm_config_get_el2_supported                             -> HV_SUCCESS (0x00000000)
    EL2 (nested virt) supported = true
  hv_vm_config_get_default_ipa_granule                       -> HV_SUCCESS (0x00000000)
    default IPA granule = 1 (16KB)
  hv_sme_config_get_max_svl_bytes                            -> HV_SUCCESS (0x00000000)
    SME max SVL = 64 bytes (512 bits)
  hv_vm_config_get_ipa_size(fresh config)                    -> HV_SUCCESS (0x00000000)
    fresh config IPA size = 36
  hv_vm_config_get_ipa_granule(fresh config)                 -> HV_SUCCESS (0x00000000)
    fresh config granule = 1
  hv_vm_config_get_el2_enabled(fresh config)                 -> HV_SUCCESS (0x00000000)
    fresh config el2_enabled = false
  hv_vm_config_set_ipa_size(max+1) [expect error]            -> HV_UNSUPPORTED (0xfae9400f)
    feature ID_AA64DFR0_EL1    = 0x0000000010305006 [HV_SUCCESS]
    feature ID_AA64DFR1_EL1    = 0x0000000000000000 [HV_SUCCESS]
    feature ID_AA64ISAR0_EL1   = 0x0221100110212120 [HV_SUCCESS]
    feature ID_AA64ISAR1_EL1   = 0x0010221110211502 [HV_SUCCESS]
    feature ID_AA64MMFR0_EL1   = 0x000010000f100022 [HV_SUCCESS]
      PARange=2 (40 bits) TGran16=0x1 TGran64=0xf TGran4=0x0 (TGran4/64: 0=supported, 0xf=not; TGran16: 0=not, >=1 supported)
    feature ID_AA64MMFR1_EL1   = 0x0000100011312000 [HV_SUCCESS]
    feature ID_AA64MMFR2_EL1   = 0x1001001102001011 [HV_SUCCESS]
    feature ID_AA64PFR0_EL1    = 0x1101000010110011 [HV_SUCCESS]
      EL0=0x1 EL1=0x1 EL2=0x0 EL3=0x0 GIC=0x0 SVE=0x0
    feature ID_AA64PFR1_EL1    = 0x0000000202000001 [HV_SUCCESS]
    feature CTR_EL0            = 0x000000099444c004 [HV_SUCCESS]
    feature CLIDR_EL1          = 0x0000000080000023 [HV_SUCCESS]
    feature DCZID_EL0          = 0x0000000000000004 [HV_SUCCESS]
    feature ID_AA64SMFR0_EL1   = 0x02f15cff00000000 [HV_SUCCESS]
    feature ID_AA64ZFR0_EL1    = 0x0000100001200002 [HV_SUCCESS]

== basic: VM without GIC ==
  hv_vm_config_set_ipa_size(40)                              -> HV_SUCCESS (0x00000000)
  hv_vm_create(config)                                       -> HV_SUCCESS (0x00000000)
  hv_vm_create again [expect error]                          -> HV_BUSY (0xfae94002)
  hv_vm_map(code page, RWX)                                  -> HV_SUCCESS (0x00000000)
  hv_vm_map(page 1, READ only)                               -> HV_SUCCESS (0x00000000)
  hv_vm_map(pages 2-3, RW)                                   -> HV_SUCCESS (0x00000000)
  hv_vm_map(overlapping page 0) [expect error]               -> HV_ERROR (0xfae94001)
  hv_vcpu_create                                             -> HV_SUCCESS (0x00000000)
    vcpu id = 0, exit struct at 0x100f26858
  hv_vcpu_create 2nd on same thread [expect error]           -> HV_BUSY (0xfae94002)
  -- default vCPU state --
    PC=0x0 CPSR=0x0
    MIDR_EL1                   = 0x00000000610f0000
    MPIDR_EL1                  = 0x0000000000000000
    SCTLR_EL1                  = 0x0000000000000000
    ID_AA64PFR0_EL1            = 0x1101000010110011
    ID_AA64MMFR0_EL1           = 0x000010000f100022
    ID_AA64DFR0_EL1            = 0x0000000010305006
    CNTV_CTL_EL0               = 0x0000000000000000
    CNTP_CTL_EL0 (needs GIC)   -> HV_UNSUPPORTED (0xfae9400f)
    HCR_EL2 (needs EL2)        -> HV_UNSUPPORTED (0xfae9400f)
  hv_vcpu_get_vtimer_offset                                  -> HV_SUCCESS (0x00000000)
    vtimer offset = 0x0  (mach_absolute_time now = 0x11fd2c446a5)
    vtimer masked by default = false
  hv_vcpu_get_pending_interrupt(IRQ) [no GIC]                -> HV_SUCCESS (0x00000000)
  hv_vcpu_get_wait_for_interrupt_time [no GIC, expect UNSUPPORTED] -> HV_UNSUPPORTED (0xfae9400f)
  hv_vcpu_set_simd_fp_reg(Q5, 10..1f)                        -> HV_SUCCESS (0x00000000)
  hv_vcpu_get_simd_fp_reg(Q5)                                -> HV_SUCCESS (0x00000000)
    Q5 roundtrip ok = true ([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 1a, 1b, 1c, 1d, 1e, 1f])
  hv_vcpu_get_reg from a non-owning thread                   -> HV_BAD_ARGUMENT (0xfae94003)
  hv_vcpus_exit(self) before hv_vcpu_run                     -> HV_SUCCESS (0x00000000)
  first run after pre-exit: reason=CANCELED in 2.917µs
  -- running guest at 0x40000000, CPSR=0x3c5 (EL1h, DAIF masked) --

  exit #1: reason=EXCEPTION after 10.334µs, PC=0x40000008
    ESR=0x5a000001 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000001 FAR(VA)=0x0 IPA=0x0
      imm16=0x1
    HVC: PC already points past the HVC? true (PC-4=0x40000004)
    x0 = 42

  exit #2: reason=EXCEPTION after 1.5µs, PC=0x40000010
    ESR=0x93810046 EC=0x24 (Data Abort from lower EL) IL=1 ISS=0x1810046 FAR(VA)=0x9000000 IPA=0x9000000
      ISV=1 SAS=2 (4B) SSE=0 SRT=x1 SF=0 AR=0 FnV=0 S1PTW=0 WnR=1 (write) DFSC=0x06 (translation fault, level 2)
    MMIO WRITE 0x9000000 <- 0x41 (4B)

  exit #3: reason=EXCEPTION after 1.25µs, PC=0x40000014
    ESR=0x93830006 EC=0x24 (Data Abort from lower EL) IL=1 ISS=0x1830006 FAR(VA)=0x9000018 IPA=0x9000018
      ISV=1 SAS=2 (4B) SSE=0 SRT=x3 SF=0 AR=0 FnV=0 S1PTW=0 WnR=0 (read) DFSC=0x06 (translation fault, level 2)
    MMIO READ  0x9000018 -> inject 0x90 into x3

  exit #4: reason=EXCEPTION after 1.083µs, PC=0x4000001c
    ESR=0x5a000002 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000002 FAR(VA)=0x0 IPA=0x0
      imm16=0x2
    HVC: PC already points past the HVC? true (PC-4=0x40000018)
    x3 = 0x90 (we injected 0x90 for the UARTFR read)

  exit #5: reason=EXCEPTION after 1.125µs, PC=0x4000001c
    ESR=0x92000046 EC=0x24 (Data Abort from lower EL) IL=1 ISS=0x0000046 FAR(VA)=0x9000000 IPA=0x9000000
      ISV=0 SAS=0 (1B) SSE=0 SRT=x0 SF=0 AR=0 FnV=0 S1PTW=0 WnR=1 (write) DFSC=0x06 (translation fault, level 2)
    ISV=0: syndrome has no register info; a VMM must fetch + decode the instruction at PC (or refuse)

  exit #6: reason=EXCEPTION after 1.042µs, PC=0x40000020
    ESR=0x5e000003 EC=0x17 (SMC (AArch64)) IL=1 ISS=0x0000003 FAR(VA)=0x0 IPA=0x0
      imm16=0x3
    SMC: PC == SMC instruction address? -> need PC+=4 if so

  exit #7: reason=EXCEPTION after 1.125µs, PC=0x40000024
    ESR=0x6230e499 EC=0x18 (MSR/MRS/System instruction trap) IL=1 ISS=0x030e499 FAR(VA)=0x0 IPA=0x0
      op0=3 op1=3 CRn=9 CRm=12 op2=0 Rt=x4 dir=read(MRS) -> hv_sys_reg_t 0xdce0

  exit #8: reason=EXCEPTION after 1.083µs, PC=0x40000028
    ESR=0x07e00000 EC=0x01 (WFI/WFE) IL=1 ISS=0x1e00000 FAR(VA)=0x0 IPA=0x0
      TI=0 (WFI)

  exit #9: reason=EXCEPTION after 1.458µs, PC=0x4000003c
    ESR=0x93c08047 EC=0x24 (Data Abort from lower EL) IL=1 ISS=0x1c08047 FAR(VA)=0x40004000 IPA=0x40004000
      ISV=1 SAS=3 (8B) SSE=0 SRT=x0 SF=1 AR=0 FnV=0 S1PTW=0 WnR=1 (write) DFSC=0x07 (translation fault, level 3)
    MMIO WRITE 0x40004000 <- 0x2a (8B)

  exit #10: reason=EXCEPTION after 3.417µs, PC=0x4000004c
    ESR=0x5a000004 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000004 FAR(VA)=0x0 IPA=0x0
      imm16=0x4
    HVC: PC already points past the HVC? true (PC-4=0x40000048)
  hv_vm_protect(0x4000_8000, 16K, READ)                      -> HV_SUCCESS (0x00000000)

  exit #11: reason=EXCEPTION after 1.459µs, PC=0x4000004c
    ESR=0x93c0804f EC=0x24 (Data Abort from lower EL) IL=1 ISS=0x1c0804f FAR(VA)=0x40008008 IPA=0x40008008
      ISV=1 SAS=3 (8B) SSE=0 SRT=x0 SF=1 AR=0 FnV=0 S1PTW=0 WnR=1 (write) DFSC=0x0f (permission fault, level 3)
    write to write-protected RAM page: mark dirty, hv_vm_protect back to RW, retry WITHOUT advancing PC
  hv_vm_protect(0x4000_8000, 16K, RW)                        -> HV_SUCCESS (0x00000000)

  exit #12: reason=EXCEPTION after 3.167µs, PC=0x40000054
    ESR=0x5a000005 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000005 FAR(VA)=0x0 IPA=0x0
      imm16=0x5
    HVC: PC already points past the HVC? true (PC-4=0x40000050)
    host sees guest RAM[0x4000_8008] = 42 (42 => retried store landed)

  exit #13: reason=EXCEPTION after 1.208µs, PC=0x40000060
    ESR=0x5a000003 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000003 FAR(VA)=0x0 IPA=0x0
      imm16=0x3
    HVC: PC already points past the HVC? true (PC-4=0x4000005c)
    guest CNTVCT=0x11fd2c464d8 CNTFRQ=24000000 ; host mach_absolute_time-offset=0x11fd2c4660c (delta 308 ticks)

  exit #14: reason=VTIMER_ACTIVATED after 15.6135ms, PC=0x40000074
    15.627ms after arming; CNTV_CTL=0x5 (ISTATUS=1); vtimer mask now = true ; PC at spin? true
    stage 0 -> re-run WITHOUT unmasking; expect no further VTIMER exit (watchdog CANCELED)

  exit #15: reason=CANCELED after 300.28175ms, PC=0x40000074
    (watchdog hv_vcpus_exit from another thread; fired=1)
    confirmed: masked vtimer did not re-exit. Unmasking with timer still firing...
  hv_vcpu_set_vtimer_mask(false)                             -> HV_SUCCESS (0x00000000)

  exit #16: reason=VTIMER_ACTIVATED after 1.125µs, PC=0x40000074
    315.946208ms after arming; CNTV_CTL=0x5 (ISTATUS=1); vtimer mask now = true ; PC at spin? true
    stage 1 -> timer still pending after unmask => immediate re-exit (level semantics)
    now: CNTV_CTL=0 (disable), unmask, PC -> after_spin

  exit #17: reason=EXCEPTION after 1.583µs, PC=0x10000000
    ESR=0x82000006 EC=0x20 (Instruction Abort from lower EL) IL=1 ISS=0x0000006 FAR(VA)=0x10000000 IPA=0x10000000
      IFSC=0x06 (translation fault, level 2)
    instruction abort at unmapped IPA - end of basic program

  hv_vcpu_get_exec_time = 7566676 mach ticks
  hv_vcpu_destroy                                            -> HV_SUCCESS (0x00000000)
  hv_vm_unmap(all)                                           -> HV_SUCCESS (0x00000000)
  hv_vm_destroy                                              -> HV_SUCCESS (0x00000000)
  hv_vm_deallocate                                           -> HV_SUCCESS (0x00000000)
  hv_vm_create after destroy (re-create in same process)     -> HV_SUCCESS (0x00000000)
  hv_vm_destroy                                              -> HV_SUCCESS (0x00000000)

== gic: VM with in-kernel GICv3 (QEMU virt addresses) ==
  hv_vm_create(NULL)                                         -> HV_SUCCESS (0x00000000)
  hv_gic_get_distributor_size                                -> HV_SUCCESS (0x00000000)
  hv_gic_get_distributor_base_alignment                      -> HV_SUCCESS (0x00000000)
  hv_gic_get_redistributor_region_size                       -> HV_SUCCESS (0x00000000)
  hv_gic_get_redistributor_size                              -> HV_SUCCESS (0x00000000)
  hv_gic_get_redistributor_base_alignment                    -> HV_SUCCESS (0x00000000)
  hv_gic_get_msi_region_size                                 -> HV_SUCCESS (0x00000000)
  hv_gic_get_msi_region_base_alignment                       -> HV_SUCCESS (0x00000000)
  hv_gic_get_spi_interrupt_range                             -> HV_SUCCESS (0x00000000)
    distributor:   size=0x10000 align=0x10000  (QEMU GICD 0x8000000 aligned? true)
    redistributor: region size=0x2000000 per-vCPU size=0x20000 -> 256 vCPUs; align=0x10000 (QEMU GICR 0x80a0000 aligned? true)
      QEMU virt redist window is 0xf60000 bytes -> region fits? false (end 0xa0a0000)
    MSI region:    size=0x10000 align=0x10000 (QEMU v2m 0x8020000 aligned? true)
    SPI INTIDs:    base=32 count=988 -> [32, 1020)
    hv_gic_get_intid(PERFORMANCE_MONITOR ) = 23  [HV_SUCCESS]
    hv_gic_get_intid(MAINTENANCE         ) = 25  [HV_SUCCESS]
    hv_gic_get_intid(EL2_PHYSICAL_TIMER  ) = 26  [HV_SUCCESS]
    hv_gic_get_intid(EL1_VIRTUAL_TIMER   ) = 27  [HV_SUCCESS]
    hv_gic_get_intid(EL1_PHYSICAL_TIMER  ) = 30  [HV_SUCCESS]
  hv_gic_config_set_distributor_base(0x0800_0000)            -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_redistributor_base(0x080A_0000)          -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_msi_region_base(0x0802_0000)             -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_msi_interrupt_range(80, 64)              -> HV_SUCCESS (0x00000000)
  hv_gic_create                                              -> HV_SUCCESS (0x00000000)
  hv_gic_create again [expect error]                         -> HV_BUSY (0xfae94002)
  hv_vm_map(RAM 4 pages RWX)                                 -> HV_SUCCESS (0x00000000)
  hv_vcpu_create                                             -> HV_SUCCESS (0x00000000)
    default MPIDR_EL1 = 0x0
  hv_gic_get_redistributor_base (before setting MPIDR)       -> HV_BAD_ARGUMENT (0xfae94003)
      -> 0x0
  hv_gic_get_redistributor_base (MPIDR=0x80000000)           -> HV_SUCCESS (0x00000000)
      -> 0x80a0000
    GICD_TYPER = 0x478001f (ITLinesNumber=31 -> 1024 INTIDs, SecurityExtn=0, MBIS=0, LPIS=0, IDbits=16)
    GICD_PIDR2 = 0x30 (ArchRev=3)
    GICD_CTLR (reset) = 0x50 (DS=1)
    GICR_TYPER = 0x10 (Affinity=0x0, Last=1, ProcNum=0)
    ICC_SRE_EL1 (host view) = 0x7 [HV_SUCCESS]
  hv_vcpu_get_pending_interrupt with GIC [expect UNSUPPORTED] -> HV_UNSUPPORTED (0xfae9400f)
  hv_vcpu_set_pending_interrupt with GIC [expect UNSUPPORTED] -> HV_UNSUPPORTED (0xfae9400f)
    CNTP_CTL_EL0 (now with GIC) = 0x4

  exit #1: reason=EXCEPTION after 17.667µs, PC=0x40000064
    ESR=0x5a000020 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000020 FAR(VA)=0x0 IPA=0x0
      imm16=0x20
    guest finished GIC init with 0 MMIO exits; guest ICC_SRE_EL1 = 0x7
    GICD_CTLR via API = 0x53
    GICR_ISENABLER0 via API = 0x8000000
    GICR_IGROUPR0 via API = 0xffffffff
    ICC_PMR_EL1 via API = 0xf8
    ICC_IGRPEN1_EL1 via API = 0x1

  exit #2: reason=EXCEPTION after 19.560875ms, PC=0x40000a88
    ESR=0x5a000010 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000010 FAR(VA)=0x0 IPA=0x0
      imm16=0x10
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 27 (19.590708ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    vtimer mask = false

  exit #3: reason=EXCEPTION after 3.833µs, PC=0x40000a94
    ESR=0x5a000011 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000011 FAR(VA)=0x0 IPA=0x0
      imm16=0x11
    guest EOI'd INTID 27
    spawning a non-vCPU thread to raise SPI 33 in 30ms while the guest sits in WFI
    [spi thread] hv_gic_set_spi(33, true) -> HV_SUCCESS (0x00000000)

  exit #4: reason=EXCEPTION after 35.066041ms, PC=0x40000a88
    ESR=0x5a000010 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000010 FAR(VA)=0x0 IPA=0x0
      imm16=0x10
    *** guest IRQ handler: ICC_IAR1_EL1 = INTID 33 (35.100958ms since arm/send) ; VTIMER exits so far = 0, WFI exits = 0
    vtimer mask = false
  hv_gic_set_spi(33, false) (deassert level)                 -> HV_SUCCESS (0x00000000)

  exit #5: reason=EXCEPTION after 2.042µs, PC=0x40000a94
    ESR=0x5a000011 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000011 FAR(VA)=0x0 IPA=0x0
      imm16=0x11
    guest EOI'd INTID 33
    SPI path verified; stopping
  hv_vcpu_get_wait_for_interrupt_time                        -> HV_SUCCESS (0x00000000)
    WFI wait time = 1310471 ticks (~54.6 ms)
    summary: vtimer exits=0, WFI exits=0, MMIO exits=0, fallback used=false
  -- GIC state save/restore --
    hv_gic_state_create -> 0x75b6ce8000
  hv_gic_state_get_size                                      -> HV_SUCCESS (0x00000000)
    state size = 126363 bytes
  hv_gic_state_get_data                                      -> HV_SUCCESS (0x00000000)
    first 16 bytes: [62, 70, 6c, 69, 73, 74, 30, 30, d9, 00, 01, 00, 02, 00, 03, 00]
  hv_gic_set_state (after vCPU has run) [header: must be before run] -> HV_SUCCESS (0x00000000)
  hv_gic_reset                                               -> HV_SUCCESS (0x00000000)
    GICD_CTLR after reset = 0x50
  hv_vcpu_destroy                                            -> HV_SUCCESS (0x00000000)
  hv_vm_destroy                                              -> HV_SUCCESS (0x00000000)

== gicprobe: GICD=0x8000000 GICR=0x80a0000 MSI=0x8020000 ipa_bits=None ==
  hv_vm_create                                               -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_distributor_base                         -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_redistributor_base                       -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_msi_region_base                          -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_msi_interrupt_range(80, 64)              -> HV_SUCCESS (0x00000000)
  hv_gic_create                                              -> HV_SUCCESS (0x00000000)
  PL011 UARTDR (QEMU 0x0900_0000)          0x0009000000: EXITS to VMM (data abort)
  virtio-mmio slot 0 (0x0a00_0000)         0x000a000000: EXITS to VMM (data abort)
  GICR vCPU0 GICR_TYPER (32-bit)           0x00080a0008: handled in kernel, read 0x0
  GICR vCPU0 GICR_TYPER (64-bit)           0x00080a0008: handled in kernel, read 0x10
  GICR vCPU0 GICR_PIDR2                    0x00080affe8: handled in kernel, read 0x30
  GICR vCPU1 GICR_TYPER (no such vCPU)     0x00080c0008: EXITS to VMM (data abort)
  GICR last slot GICR_TYPER                0x000a080008: EXITS to VMM (data abort)
  just past GICR region                    0x000a0a0000: EXITS to VMM (data abort)
  GICD_TYPER                               0x0008000004: handled in kernel, read 0x478001f
  GICD_PIDR2                               0x000800ffe8: handled in kernel, read 0x30
  just past GICD (dist+64K)                0x0008010000: EXITS to VMM (data abort)
  GICM_TYPER (MSI frame +8)                0x0008020008: handled in kernel, read 0x80500040
  just past MSI frame                      0x0008030000: EXITS to VMM (data abort)

== gicprobe: GICD=0x8000000 GICR=0x4000000000 MSI=0x8020000 ipa_bits=Some(40) ==
  hv_vm_config_set_ipa_size                                  -> HV_SUCCESS (0x00000000)
  hv_vm_create                                               -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_distributor_base                         -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_redistributor_base                       -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_msi_region_base                          -> HV_SUCCESS (0x00000000)
  hv_gic_config_set_msi_interrupt_range(80, 64)              -> HV_SUCCESS (0x00000000)
  hv_gic_create                                              -> HV_SUCCESS (0x00000000)
  PL011 UARTDR (QEMU 0x0900_0000)          0x0009000000: EXITS to VMM (data abort)
  virtio-mmio slot 0 (0x0a00_0000)         0x000a000000: EXITS to VMM (data abort)
  GICR vCPU0 GICR_TYPER (32-bit)           0x4000000008: handled in kernel, read 0x0
  GICR vCPU0 GICR_TYPER (64-bit)           0x4000000008: handled in kernel, read 0x10
  GICR vCPU0 GICR_PIDR2                    0x400000ffe8: handled in kernel, read 0x30
  GICR vCPU1 GICR_TYPER (no such vCPU)     0x4000020008: EXITS to VMM (data abort)
  GICR last slot GICR_TYPER                0x4001fe0008: EXITS to VMM (data abort)
  just past GICR region                    0x4002000000: EXITS to VMM (data abort)
  GICD_TYPER                               0x0008000004: handled in kernel, read 0x478001f
  GICD_PIDR2                               0x000800ffe8: handled in kernel, read 0x30
  just past GICD (dist+64K)                0x0008010000: EXITS to VMM (data abort)
  GICM_TYPER (MSI frame +8)                0x0008020008: handled in kernel, read 0x80500040
  just past MSI frame                      0x0008030000: EXITS to VMM (data abort)

== smp: 4 vCPUs, each on its own thread, with in-kernel GIC ==
  hv_gic_create                                              -> HV_SUCCESS (0x00000000)
  hv_vcpus_exit(all 4 ids) from main thread                  -> HV_SUCCESS (0x00000000)
  hv_vcpu_create AFTER other vCPUs ran (CPU hotplug?)          -> HV_SUCCESS (0x00000000)
    late vCPU id=4 redist_base=0x8120000 [HV_SUCCESS]
  thread 0: vcpu id=0 Aff0=3 redist_base=0x80a0000 [HV_SUCCESS] GICR_TYPER=0x300000000 (Aff=0x3 Last=0 ProcNum=0) | 1st exit EXCEPTION guest MPIDR=0x80000003 | 2nd exit CANCELED after 55.014917ms
  thread 1: vcpu id=1 Aff0=2 redist_base=0x80c0000 [HV_SUCCESS] GICR_TYPER=0x200000100 (Aff=0x2 Last=0 ProcNum=1) | 1st exit EXCEPTION guest MPIDR=0x80000002 | 2nd exit CANCELED after 55.022083ms
  thread 2: vcpu id=2 Aff0=1 redist_base=0x80e0000 [HV_SUCCESS] GICR_TYPER=0x100000200 (Aff=0x1 Last=0 ProcNum=2) | 1st exit EXCEPTION guest MPIDR=0x80000001 | 2nd exit CANCELED after 55.031042ms
  thread 3: vcpu id=3 Aff0=0 redist_base=0x8100000 [HV_SUCCESS] GICR_TYPER=0x310 (Aff=0x0 Last=1 ProcNum=3) | 1st exit EXCEPTION guest MPIDR=0x80000000 | 2nd exit CANCELED after 55.017959ms
  hv_vm_destroy                                              -> HV_SUCCESS (0x00000000)

== el2: VM with EL2 enabled ==
  hv_vm_config_set_el2_enabled(true)                         -> HV_SUCCESS (0x00000000)
    el2_enabled = true
  hv_vm_create(el2 config)                                   -> HV_SUCCESS (0x00000000)
  hv_vcpu_create                                             -> HV_SUCCESS (0x00000000)
    default CPSR = 0x0 (M[3:0]=0x0)
    HCR_EL2          = 0x0000000080000000
    ID_AA64PFR0_EL1  = 0x1101000010110011
    ID_AA64DFR0_EL1  = 0x0000000010305006

  exit #1: reason=EXCEPTION after 6.459µs, PC=0x40000008 CPSR=0x3c9
    ESR=0x93c18046 EC=0x24 (Data Abort from lower EL) IL=1 ISS=0x1c18046 FAR(VA)=0x9000000 IPA=0x9000000
      ISV=1 SAS=3 (8B) SSE=0 SRT=x1 SF=1 AR=0 FnV=0 S1PTW=0 WnR=1 (write) DFSC=0x06 (translation fault, level 2)
    MMIO write value (CurrentEL) = 0x8 -> EL2

  exit #2: reason=EXCEPTION after 4.125µs, PC=0x200 CPSR=0x3c9
    ESR=0x82000006 EC=0x20 (Instruction Abort from lower EL) IL=1 ISS=0x0000006 FAR(VA)=0x200 IPA=0x200
      IFSC=0x06 (translation fault, level 2)
    guest-visible ESR_EL2=0x2000000 (EC=0x0 Unknown reason) ELR_EL2=0x4000000c VBAR_EL2=0x0
  hv_vcpu_destroy                                            -> HV_SUCCESS (0x00000000)
  hv_vm_destroy                                              -> HV_SUCCESS (0x00000000)

== align: hv_vm_map rules ==
  -- default config (default granule, default IPA 36 bits) --
  map 16K @ IPA 0x4000_0000, host page-aligned               -> HV_SUCCESS (0x00000000)
  map 16K @ IPA 0x4000_5000 (4K-aligned only)                -> HV_BAD_ARGUMENT (0xfae94003)
  map 4K  @ IPA 0x4001_0000 (size 4K)                        -> HV_BAD_ARGUMENT (0xfae94003)
  map 16K @ IPA 0x4002_0000, host VA +0x1000                 -> HV_BAD_ARGUMENT (0xfae94003)
  map 16K @ IPA (1<<36)-16K (last page)                      -> HV_SUCCESS (0x00000000)
  map 16K @ IPA 1<<36 (just beyond)                          -> HV_BAD_ARGUMENT (0xfae94003)
  unmap 4K of a 16K mapping                                  -> HV_BAD_ARGUMENT (0xfae94003)
  protect 16K -> READ                                        -> HV_SUCCESS (0x00000000)
  unmap never-mapped 16K @ 0x5000_0000                       -> HV_SUCCESS (0x00000000)
  map 0 bytes                                                -> HV_ERROR (0xfae94001)
  map with flags=0 (no access)                               -> HV_SUCCESS (0x00000000)
  -- config: IPA size = max (40 bits) --
  set_ipa_size(max)                                          -> HV_SUCCESS (0x00000000)
  map 16K @ IPA (1<<40)-16K                                  -> HV_SUCCESS (0x00000000)
  map 16K @ IPA 1<<40                                        -> HV_BAD_ARGUMENT (0xfae94003)
  -- config: IPA granule = 4KB --
  hv_vm_config_set_ipa_granule(HV_IPA_GRANULE_4KB)           -> HV_SUCCESS (0x00000000)
  hv_vm_create(4K granule config)                            -> HV_SUCCESS (0x00000000)
  map 4K  @ IPA 0x4000_1000, host VA page+0x1000             -> HV_SUCCESS (0x00000000)
  map 4K  @ IPA 0x4000_3000, host VA page+0x2000 (VA/IPA offsets differ) -> HV_SUCCESS (0x00000000)
  map 12K @ IPA 0x4001_0000                                  -> HV_SUCCESS (0x00000000)
  unmap 4K                                                   -> HV_SUCCESS (0x00000000)
  map 4K code @ IPA 0x8000_1000 (host VA page+0x1000)        -> HV_SUCCESS (0x00000000)
    4K-granule guest: reason=EXCEPTION ESR=0x5a000004 EC=0x16 (HVC (AArch64)) IL=1 ISS=0x0000004 FAR(VA)=0x0 IPA=0x0
      imm16=0x4 x0=0x4b
```
