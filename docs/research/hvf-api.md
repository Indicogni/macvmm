# Hypervisor.framework (arm64) — API reference for macvmm

This reference was built from the SDK headers on the dev machine and checked against the
`spikes/hvf-hello` spike, which was run on that machine.

- **Headers:** `$(xcrun --show-sdk-path)/System/Library/Frameworks/Hypervisor.framework/Headers/`, plus
  `usr/include/arm64/hv/hv_kern_types.h`. The framework TBD reports `current-version: 308.2.7`.
- **Machine:** Apple M5 Pro, macOS 27.2.1 (26B131), Rust 1.99.
- **Raw spike output:** `spikes/hvf-hello/RESULTS.md`. Re-run it with `spikes/hvf-hello/run.sh`.

Every claim carries one of these tags:

- **[verified-on-machine]**: the spike observed it on this Mac (see RESULTS.md).
- **[from-header]**: the SDK header doc comment or declaration says so. Not independently tested.
- **[from-docs/unverified]**: Apple docs, QEMU source, or general ARM knowledge. Treat it as a hypothesis.

---

## 0. TL;DR for the VMM design

1. **One VM per process, one vCPU per thread.** A vCPU can only be driven from the thread that created it.
   `hv_vcpus_exit` is the only way to interrupt it from outside. It works from any thread. [verified-on-machine]
2. **The guest-memory granule is 16 KiB by default.** Host VA, IPA and size must all be 16 KiB-aligned.
   macOS 26+ can opt into a 4 KiB IPA granule per VM. [verified-on-machine]
3. **IPA: 36 bits by default, 40 bits max on M5 Pro.** Set it explicitly with `hv_vm_config_set_ipa_size`. [verified-on-machine]
4. **Use the in-kernel GICv3 (`hv_gic_create`).** Once it exists, the kernel handles all of the following with zero exits:
   - the virtual timer
   - WFI
   - GICD/GICR/MSI-frame MMIO and the ICC_* system registers

   Device interrupts are raised with `hv_gic_set_spi()` from any thread. **No `HV_EXIT_REASON_VTIMER_ACTIVATED`
   exits occur with a GIC.** [verified-on-machine]
5. **The QEMU-virt GIC addresses work unchanged.** These are GICD 0x0800_0000, GICR 0x080A_0000 and v2m MSI 0x0802_0000.
   The kernel only claims the redistributor frames of vCPUs that exist, so PL011/virtio in the "32 MiB" redistributor
   window still trap to us. [verified-on-machine]
6. **PC-advance rules:**
   - HVC: the PC is already past the instruction.
   - SMC, data abort, MSR/MRS trap, WFI: the PC is at the faulting instruction, so add 4.

   [verified-on-machine]
7. **Create vCPUs one after another.** Redistributor slots follow creation order, not MPIDR. Write MPIDR_EL1
   explicitly; the default is 0 and `hv_gic_get_redistributor_base` refuses until MPIDR has been written.
   [verified-on-machine]

---

## 1. Entitlement, linking and FFI conventions

| Fact | Tag |
|---|---|
| The binary needs the entitlement `com.apple.security.hypervisor`, and ad-hoc signing (`codesign -s - --entitlements e.plist -f bin`) is enough. Without it, `hv_vm_create` returns `HV_DENIED` (0xfae94007). | [verified-on-machine] |
| Link with `#[link(name = "Hypervisor", kind = "framework")]`. Under edition 2024, declarations go in `unsafe extern "C" { ... }`. | [verified-on-machine] |
| `hv_return_t` is `mach_error_t` (an `int`). Codes are `0xfae94000 \| n`: `HV_SUCCESS`=0, `HV_ERROR` 0x…01, `HV_BUSY` 0x…02, `HV_BAD_ARGUMENT` 0x…03, `HV_ILLEGAL_GUEST_STATE` 0x…04, `HV_NO_RESOURCES` 0x…05, `HV_NO_DEVICE` 0x…06, `HV_DENIED` 0x…07, `HV_EXISTS` 0x…08, `HV_UNSUPPORTED` 0x…0f. The arm64 values come from `hv_kern_types.h`. The x86 `hv_error.h` has no `ILLEGAL_GUEST_STATE` and gives 0x…08 to `HV_FAULT`. | [from-header] |
| `OS_ENUM(name, T, ...)` expands to `typedef T name_t`. Use the stated width: `hv_reg_t` u32, `hv_sys_reg_t` **u16**, `hv_exit_reason_t` u32, `hv_gic_*_reg_t` u16, except `hv_gic_redistributor_reg_t`, which is **u32**. Also `hv_gic_intid_t` u16, `hv_ipa_granule_t` u32, `hv_feature_reg_t` u32, `hv_interrupt_type_t` u32. | [from-header] |
| `hv_vcpu_t` is `uint64_t` (on x86 it is `unsigned`). `hv_ipa_t` is `uint64_t`. | [from-header] |
| Config and state objects are OS objects: `hv_vm_config_t`, `hv_vcpu_config_t`, `hv_gic_config_t`, `hv_gic_state_t`. In C, each is an opaque pointer, released with `os_release(void*)` from libSystem. Declaring `os_release` in Rust links fine. | [verified-on-machine] |
| **`hv_vcpu_set_simd_fp_reg` takes `hv_simd_fp_uchar16_t` (a clang `ext_vector_type(16)` of `uint8_t`) by value, in SIMD register v0.** Stable Rust rejects `uint8x16_t` in `extern "C"` (error: `simd_ffi` is unstable). A `u128` would travel in x2:x3, which is wrong. The spike works around this with an inline-asm trampoline that puts the value in `v0` and uses `clobber_abi("C")`. The getter takes a pointer, so `*mut [u8;16]` is fine. A Q-register round-trip was checked. | [verified-on-machine] |
| `hv_vm_allocate(&p, size, HV_ALLOCATE_DEFAULT)` returns page-aligned anonymous memory "suitable to be mapped as guest memory", with accurate memory accounting. Release it with `hv_vm_deallocate`. `size` must be a multiple of PAGE_SIZE. | [from-header]; allocation and mapping [verified-on-machine] |

## 2. Capabilities on this machine

| Query | Value | Tag |
|---|---|---|
| Host page size | 0x4000 (16 KiB) | [verified-on-machine] |
| `hv_vm_get_max_vcpu_count` | 64 | [verified-on-machine] |
| `hv_vm_config_get_max_ipa_size` / `_default_ipa_size` | 40 / 36 bits | [verified-on-machine] |
| `hv_vm_config_get_el2_supported` | true | [verified-on-machine] |
| `hv_vm_config_get_default_ipa_granule` | `HV_IPA_GRANULE_16KB` (1) | [verified-on-machine] |
| `hv_sme_config_get_max_svl_bytes` | 64 (SVL = 512 bits) | [verified-on-machine] |
| Guest CNTFRQ_EL0 | 24 MHz (same as host) | [verified-on-machine] |
| Guest MIDR_EL1 | 0x610f0000 (implementer 0x61 = Apple) | [verified-on-machine] |
| Guest ID_AA64MMFR0_EL1 | 0x000010000f100022: PARange=2 (40 bits); TGran4 supported, TGran16 supported, TGran64 **not** supported | [verified-on-machine]; field decode per ARM ARM |
| Guest ID_AA64PFR0_EL1 | 0x1101000010110011 without a GIC: EL2 field = 0 even when EL2 is enabled in the config (see §11); SVE = 0. **With `hv_gic_create`**, `hv_vcpu_get_sys_reg` on a live vCPU reads 0x1101000011110011: the GIC field [27:24] becomes 1 (`hvf_gic_live`, the API's view). The guest's own `MRS ID_AA64PFR0_EL1` agrees: `irq` prints `irq: pfr0.gic=1` under the in-kernel GIC and `timer-nogic` prints `pfr0.gic=0` without one (both required by their e2e marker files), so Linux's `ICC_*` probe sees the in-kernel GIC (risk R3 closed on the guest's view). | [verified-on-machine] (M8: API read `hvf_gic_live`; guest read `e2e_irq`) |
| Guest ID_AA64PFR1_EL1 | 0x0000000202000001: SME field [27:24] = 2 (SME2) | [verified-on-machine] value; SME2 reading [from-docs/unverified] |
| Guest ID_AA64DFR0_EL1 | 0x10305006: PMUVer [11:8] = 0 (no PMU advertised) | [verified-on-machine] |

`hv_vcpu_config_get_feature_reg(cfg, HV_FEATURE_REG_*, &v)` reads these before any VM exists.
`hv_vcpu_get_sys_reg` reads the same values from a live vCPU. [verified-on-machine]

## 3. VM lifecycle

```
cfg = hv_vm_config_create()                       // macOS 13+
hv_vm_config_set_ipa_size(cfg, 40)                // <= max; max+1 -> HV_UNSUPPORTED
hv_vm_config_set_ipa_granule(cfg, ...)            // optional, macOS 26+
hv_vm_config_set_el2_enabled(cfg, true)           // optional, macOS 15+
hv_vm_create(cfg); os_release(cfg)
[ hv_gic_config_create / set bases / hv_gic_create ]   // BEFORE any vCPU (see §9)
hv_vm_map(...)                                    // any time
... spawn vCPU threads ...
all vCPU threads: hv_vcpu_destroy(own vcpu)
hv_vm_destroy()                                   // requires all vCPUs destroyed
```

- There is one VM per process. A second `hv_vm_create` returns `HV_BUSY`. [verified-on-machine]
- After `hv_vm_destroy`, a new VM can be created in the same process. [verified-on-machine]
- `hv_vm_create(NULL)` uses the defaults: 36-bit IPA, 16 KB granule, EL2 off. [verified-on-machine]
- `hv_vm_destroy` "requires all vCPUs be destroyed". [from-header]
- The config object can be released right after `hv_vm_create`. [verified-on-machine]
- 100 consecutive `hv_vm_create(cfg)` / `hv_vm_destroy()` pairs in one process all return `HV_SUCCESS`, and a
  VM with an in-kernel GIC can be destroyed and re-created the same way. [verified-on-machine, M0
  `macvmm doctor`, 2026-11-18]

## 4. vCPU lifecycle and threading rules

| Rule | Tag |
|---|---|
| `hv_vcpu_create(&vcpu, &exit, cfg_or_NULL)` creates the vCPU *for the calling thread*. It also hands back a pointer to a framework-owned `hv_vcpu_exit_t`, which is rewritten on every `hv_vcpu_run`. Read it after each run; the spike uses `read_volatile`. | [from-header]; behaviour [verified-on-machine] |
| "Each thread can only have one vCPU associated at a time." A second create on the same thread returns `HV_BUSY`. | [verified-on-machine] |
| These calls are documented as "Must be called by the owning thread": `get/set_reg`, `get/set_sys_reg`, `get/set_simd_fp_reg`, SME accessors, `run`, `destroy`, `get_exec_time`, `get/set_pending_interrupt`, `set_trap_debug_*`, `hv_gic_{get,set}_{redistributor,icc,ich,icv}_reg`, `hv_vcpu_invalidate_tlb`. | [from-header] |
| `hv_vcpu_get_reg` from a non-owning thread returns `HV_BAD_ARGUMENT`. It does not crash. | [verified-on-machine] |
| The header does *not* mark `hv_vcpu_{get,set}_vtimer_mask` or `_vtimer_offset` as owner-only. Call them on the owner anyway. | [from-header] |
| **`hv_vcpus_exit(ids, n)` can be called from any thread, for several vCPUs at once.** Each running vCPU returns from `hv_vcpu_run` with `HV_EXIT_REASON_CANCELED`. Four spinning vCPUs on four threads were all kicked by one call from the main thread. | [verified-on-machine] |
| `hv_vcpus_exit` on a vCPU that is *not* running is sticky: its next `hv_vcpu_run` returns CANCELED at once (2 µs) without entering the guest. The VMM's run loop must therefore tolerate spurious CANCELED exits. | [verified-on-machine] |
| vCPU ids are small integers starting at 0, given out in creation order. | [verified-on-machine] |
| Creating a vCPU *after* other vCPUs have run still succeeds, and it gets the next redistributor slot. The GIC header says the topology "is considered final" once vCPUs run, and "Destroy vcpus only when you are tearing down the virtual machine". **Design decision: create all vCPUs at startup.** PSCI CPU_ON then only sets PC/x0 and releases a parked thread. | create [verified-on-machine]; functional correctness unverified |
| Measured exit round trip: about 1–3 µs for a trivial HVC/MMIO exit, as seen from user space. | [verified-on-machine] |

Default vCPU state after create: PC=0, CPSR=0, MPIDR_EL1=0, SCTLR_EL1=0, CNTV_CTL=0, vtimer offset 0, vtimer
mask false. This is true even in an EL2-enabled VM. Always set CPSR before the first run:

- `0x3c5` = EL1h with DAIF masked (the Linux boot protocol).
- `0x3c9` = EL2h.

[verified-on-machine]

## 5. Guest memory: `hv_vm_map` / `unmap` / `protect`

Signature: `hv_vm_map(void *uva, hv_ipa_t ipa, size_t size, hv_memory_flags_t flags)`, with
`HV_MEMORY_READ=1`, `WRITE=2`, `EXEC=4`. [from-header]

The header only says "page aligned". On this machine with the default config:

| Experiment (default 16 KB granule) | Result | Tag |
|---|---|---|
| 16 KiB at a 16 KiB-aligned IPA, host VA page-aligned | `HV_SUCCESS` | [verified-on-machine] |
| 16 KiB at an IPA that is only 4 KiB-aligned (0x4000_5000) | `HV_BAD_ARGUMENT` | [verified-on-machine] |
| size 4 KiB | `HV_BAD_ARGUMENT` | [verified-on-machine] |
| host VA 16K+0x1000 | `HV_BAD_ARGUMENT` | [verified-on-machine] |
| size 0 | `HV_ERROR` | [verified-on-machine] |
| Map overlapping an existing mapping | `HV_ERROR` (not `HV_EXISTS`) | [verified-on-machine] |
| Unmap 4 KiB of a 16 KiB mapping | `HV_BAD_ARGUMENT` | [verified-on-machine] |
| Unmap a range that was never mapped | `HV_SUCCESS` (no error) | [verified-on-machine] |
| flags=0 (mapped, no access) | `HV_SUCCESS` | [verified-on-machine] |
| Last page below `1<<ipa_bits` | `HV_SUCCESS`. At `1<<ipa_bits` it is `HV_BAD_ARGUMENT`. Checked at 36 and 40 bits. | [verified-on-machine] |
| With `hv_vm_config_set_ipa_granule(HV_IPA_GRANULE_4KB)` | 4 KiB / 12 KiB sizes at 4 KiB-aligned IPA and host VA succeed; VA and IPA offsets may differ within a 16 K page; 4 KiB unmap works; a vCPU executes code from a 4 KiB mapping. | [verified-on-machine] |
| Unmap one 16 KiB page of a 32 KiB mapping (aligned partial unmap) | `HV_SUCCESS` | [verified-on-machine, M2 `teardown_failure_codes_probe`] |
| Unmap at a 4 KiB-misaligned IPA | `HV_BAD_ARGUMENT` | [verified-on-machine, M2] |
| `hv_vm_destroy` while a vCPU still exists | `HV_BUSY`; the VM stays intact and a later destroy succeeds | [verified-on-machine, M2] |
| Normal teardown (all vCPUs gone, unmap exactly what was mapped, destroy), 20× in one process | every call `HV_SUCCESS`; no failure of unmap/destroy observed outside misuse (threat model §13, MEM-11) | [verified-on-machine, M2] |
| `hv_vm_allocate` 64 MiB, `HV_ALLOCATE_DEFAULT` | every byte reads 0 (MEM-10) | [verified-on-machine, M2 `hv_allocate_is_zeroed`] |
| Guest store through an `RX` mapping (flash) | EC 0x24 data abort, WnR 1, IPA = the store address; the byte is unchanged | [verified-on-machine, M2 `rom_region_maps_rx_and_rejects_guest_memory_write`] |

**Implications for macvmm:**

- With the default granule, every *mapped* region must be 16 KiB-aligned: RAM, flash, any shared-memory window.
- QEMU-virt's mapped regions already satisfy this: RAM at 0x4000_0000, flash at 0/0x0400_0000.
- MMIO devices are left *unmapped* so that they trap, so their 4 KiB/0x200 granularity is irrelevant: PL011
  0x0900_0000, PL031 0x0901_0000, virtio-mmio at 0x200 stride. [reasoning from verified rules]
- The guest's own stage-1 granule is independent of the stage-2 granule. Guest kernels using 4 K pages run
  fine on the 16 K stage-2 (the spike guests ran with the MMU off). [from-docs/unverified for a real Linux
  4K-page kernel; to be confirmed when Linux boots]
- Keep the default 16 KB granule unless a guest needs 4 KiB holes in RAM, which none of our targets do.
  The 4 KB option exists from macOS 26, and the 4 KB granule probably makes stage-2 TLB use worse
  [from-docs/unverified].

**Permissions, faults and dirty tracking:**

- A write to RAM that is mapped READ-only exits as EC=0x24 with ISV=1 and the full IPA. [verified-on-machine]
- **The DFSC is not reliable for telling "unmapped" from "read-only".** A page mapped READ-only from the
  start reported DFSC=0x07 (*translation* fault, level 3). A page that had been written while RW and then
  `hv_vm_protect`ed to READ reported DFSC=0x0f (*permission* fault, level 3). The probable cause is lazy
  stage-2 population [from-docs/unverified]. **Classify faults by looking the IPA up in our own memory
  map, never by DFSC.** [verified-on-machine]
- The dirty-page tracking pattern works:
  1. `hv_vm_protect(page, READ)`.
  2. The guest writes and the vCPU exits.
  3. Record the page as dirty and call `hv_vm_protect(page, READ|WRITE)`.
  4. Re-run **without advancing PC**. The store is retried and lands.

  [verified-on-machine]

## 6. Registers

| API | Notes | Tag |
|---|---|---|
| `hv_vcpu_get/set_reg(vcpu, hv_reg_t, u64)` | `HV_REG_X0..X30` = 0..30 (`FP`=29, `LR`=30), `PC`=31, `FPCR`=32, `FPSR`=33, `CPSR`=34. SP is not here: use sysregs `SP_EL0` 0xc208 and `SP_EL1` 0xe208. | [from-header]; X/PC/CPSR [verified-on-machine] |
| `hv_vcpu_get/set_sys_reg(vcpu, hv_sys_reg_t, u64)` | The encoding is **`op0<<14 \| op1<<11 \| CRn<<7 \| CRm<<3 \| op2`**, for example CNTV_CTL_EL0 = 0xdf19. These are exactly the ISS fields of an EC=0x18 trap, so a trapped access maps straight onto this enum. Only the enumerated registers are accessible. | [from-header] + derived; mapping [verified-on-machine] (PMCR_EL0 → 0xdce0) |
| Sysreg availability | `CNTP_CTL/CVAL/TVAL_EL0` return `HV_UNSUPPORTED` without a GIC and work with one. `*_EL2` registers (e.g. `HCR_EL2`) return `HV_UNSUPPORTED` unless EL2 is enabled. | [verified-on-machine] |
| `ACTLR_EL1` (macOS 15+) | Only bit 1 (EnTSO) is readable/writable. It selects the TSO memory model for the vCPU. | [from-header] |
| `MPIDR_EL1` | Writable. The guest reads back what we set (0x8000_000N observed). | [verified-on-machine] |
| `hv_vcpu_get/set_simd_fp_reg` | Q0..Q31. See the by-value ABI caveat in §1. | [verified-on-machine] |
| SME: `hv_vcpu_get/set_sme_state`, `_sme_z_reg` / `_p_reg` / `_za_reg` / `_zt0_reg` (macOS 15.2+) | Z buffers must be exactly max-SVL bytes (64 here), P buffers SVL/8, ZA SVL×SVL. Z/P need streaming mode, ZA/ZT0 need PSTATE.ZA. Entering or leaving streaming mode zeroes Z/P and sets FPSR. In streaming mode Q aliases the low 128 bits of Z. They return `HV_UNSUPPORTED` without SME. Registers involved: `SMCR_EL1` 0xc096, `SMPRI_EL1` 0xc094, `TPIDR2_EL0` 0xde85. | [from-header]; SVL value [verified-on-machine] |
| `hv_vcpu_get/set_serror` (macOS 27+) | Query or inject a pending virtual SError. | [from-header] |
| `hv_vcpu_invalidate_tlb(vcpu, HV_TLBI_OP_*, param)` (macOS 27+) | Performs guest TLBI ops (VMALLE1IS, VAE1IS, ...). With EL2 enabled, it targets the guest hypervisor's own context. Not needed for a plain EL1 guest. | [from-header] |
| `hv_vcpu_{get,set}_trap_debug_exceptions` / `_trap_debug_reg_accesses` | These route BRK/watchpoints and DBG*/MDSCR accesses to the host, for a gdbstub later. | [from-header] |
| `hv_vcpu_get_exec_time` | Cumulative guest run time in mach ticks. | [verified-on-machine] |
| `hv_vcpu_get_wait_for_interrupt_time` (macOS 27+) | Time spent in WFI. Returns `HV_UNSUPPORTED` without a GIC. With a GIC it returned about 54.6 ms after two WFI waits. | [verified-on-machine] |

## 7. Exits and exception decoding

`hv_vcpu_run` blocks until an exit. The exit is described by `hv_vcpu_exit_t`. [from-header]

```c
struct { uint32_t reason;               // CANCELED=0, EXCEPTION=1, VTIMER_ACTIVATED=2, UNKNOWN=3
         struct { uint64_t syndrome;    // ESR_EL2
                  uint64_t virtual_address;   // FAR_EL2
                  uint64_t physical_address;  // faulting IPA (full byte address, e.g. 0x9000018)
         } exception; }
```

Field meanings are [from-header]. The full-IPA behaviour (page offset included) is [verified-on-machine].
The Rust layout is `repr(C)` with 4 bytes of padding after `reason`. [verified-on-machine]

`hv_vcpu_run` itself returned `HV_SUCCESS` for every exit kind observed. [verified-on-machine]

ESR layout:

- EC = ESR[31:26]
- IL = ESR[25]; always 1 in our exits
- ISS = ESR[24:0]

### Exception classes we handle

| EC | Meaning | ISS fields that matter | PC at exit | Tag |
|---|---|---|---|---|
| 0x16 | HVC from AArch64 | imm16 = ISS[15:0] | **Already PC+4.** Do not advance. | [verified-on-machine] |
| 0x17 | SMC from AArch64 (HVF traps SMC) | imm16 = ISS[15:0] | **At the SMC.** Advance by 4. | [verified-on-machine] |
| 0x18 | Trapped MSR/MRS/sysinstr | Op0[21:20] Op2[19:17] Op1[16:14] CRn[13:10] Rt[9:5] CRm[4:1] Dir[0] (1 = read/MRS) | At the instruction. Advance by 4. On a read, write the emulated value to Xt (Rt=31 → XZR, discard). | [verified-on-machine] |
| 0x01 | WFI/WFE | TI = ISS[1:0]: 0 WFI, 1 WFE, 2 WFIT, 3 WFET. CV/COND were also set (ISS = 0x1e00000). | At the instruction. Advance by 4. | WFI exit [verified-on-machine], **only without a GIC**. WFE never exited, even back-to-back [verified-on-machine]. |
| 0x24 | Data abort from lower EL (MMIO or stage-2 fault) | ISV[24] SAS[23:22] SSE[21] SRT[20:16] SF[15] AR[14] FnV[10] S1PTW[7] WnR[6] DFSC[5:0]; IPA in `physical_address` | At the instruction. Advance by 4 after emulating, or retry without advancing after fixing the mapping. | [verified-on-machine] |
| 0x24 with ISV=0 | Load/store pair, writeback, etc. | No Rt/size info | — | `stp` to MMIO gave ISV=0 [verified-on-machine]. The VMM must decode the instruction at PC (read via stage-1 walk) or inject an abort. Linux `readl/writel` always give ISV=1; firmware might not [from-docs/unverified]. |
| 0x20 | Instruction abort from lower EL | IFSC[5:0], FAR/IPA | — (fatal for us) | [verified-on-machine] |
| 0x00 | Unknown | — | — | Not observed. |
| 0x3c | BRK | — | — | Only with `set_trap_debug_exceptions(true)` [from-header] |

Which system registers trap with EL2 off:

- **PMU registers trap as EC 0x18** (e.g. PMCR_EL0) **only without the in-kernel GIC.** The header documents
  this and the spike verified it on a GIC-less VM. **With `hv_gic_create`, HVF injects the UNDEF itself** and
  the VMM never sees the access (M5, §17). [verified-on-machine]
- Forwarded as EC 0x18 with the GIC (M5, §17): `OSLAR_EL1`, `OSLSR_EL1`, `OSDLR_EL1`, `MDCCSR_EL0`,
  `LORID_EL1`. Handled in the framework (no exit): `MDSCR_EL1`, `DBGBVR0_EL1`, `DBGCLAIMSET_EL1`,
  `DBGAUTHSTATUS_EL1`, `ERRIDR_EL1`, `ID_AA64DFR0_EL1`. [verified-on-machine]
- More precisely (M5 review fixes, raw ELF probes with `--trace exits:F:sysreg`): forwarded are `MRS LORID_EL1`
  and `LORSA_EL1`/`LOREA_EL1`/`LORN_EL1`/`LORC_EL1` in **both** directions (the guest sees
  `ID_AA64MMFR1_EL1.LO = 1`, so macvmm reads them as zero), and `MRS MDCCSR_EL0`. HVF injects the UNDEF itself
  (no exit) for wrong-direction accesses (`MRS OSLAR_EL1`, `MSR OSLSR_EL1`, `MSR MDCCSR_EL0`, `MSR LORID_EL1`) and
  for every ID-absent register probed: `MPAMIDR_EL1`, `MPAM1_EL1` (MPAM = 0), `PMSIDR_EL1` (SPE = 0),
  `TRFCR_EL1` (TraceFilt = 0), `AMCR_EL0` (AMU = 0), and the unallocated `S3_0_C11_C0_0`, `S3_0_C9_C0_0`.
  So no register the guest's ID registers call absent was seen reaching the VMM. [verified-on-machine]
- With an in-kernel GIC, `ICC_PMR/IGRPEN1/IAR1/EOIR1/SRE` produced **no exits**. [verified-on-machine]

### Other exit reasons

| Reason | Semantics | Tag |
|---|---|---|
| `CANCELED` | Produced by `hv_vcpus_exit`, including a pending kick from before the run. | [verified-on-machine] |
| `VTIMER_ACTIVATED` | See §8. Only seen when there is **no** GIC. | [verified-on-machine] |
| `UNKNOWN` | "should not happen under normal operation". Treat it as fatal and log it. | [from-header] |

### Suggested run-loop skeleton

```
loop {
  hv_vcpu_run(v)
  match exit.reason {
    CANCELED  => check stop/pause flags; continue          // may be spurious (sticky kick)
    VTIMER_ACTIVATED => (no-GIC mode only) inject PPI 27, unmask on EOI
    EXCEPTION => match EC {
       0x16 => psci_or_smccc(x0..x3)             // PC already advanced
       0x17 => psci_or_smccc(...); PC += 4
       0x24 => mmio_dispatch(ipa, ISV/SAS/SRT/WnR); PC += 4
       0x18 => sysreg_emulate(iss); PC += 4
       0x01 => (no-GIC only) idle; PC += 4
       _    => fatal(dump)
    }
  }
}
```

## 8. Virtual timer

**Without a GIC** (user-space interrupt controller), all of the following is [verified-on-machine]:

- When CNTV fires, `hv_vcpu_run` returns `VTIMER_ACTIVATED`. This happens **even if the guest has PSTATE.I
  masked**: the exit reflects the timer condition, not guest deliverability.
- The framework then sets the vtimer mask automatically (`hv_vcpu_get_vtimer_mask` = true).
- While masked, the vCPU does not exit for the timer again. The spike re-ran for 300 ms until the watchdog
  CANCELED it.
- If the mask is cleared while `CNTV_CTL.ISTATUS` is still 1, the next run exits `VTIMER_ACTIVATED` within 1 µs.
  This is level semantics: unmask only after the guest has handled or disarmed the timer.
- The VMM is expected to assert the timer PPI in its own interrupt controller. It does that with
  `hv_vcpu_set_pending_interrupt(IRQ)` before every run, because the pending state is auto-cleared after
  each run [from-header]. It then calls `hv_vcpu_set_vtimer_mask(false)` when the guest deactivates (EOIs)
  INTID 27 [from-header].

**With `hv_gic_create` (our design)**, all of the following is [verified-on-machine]:

- The guest enabled PPI 27 via GICR_ISENABLER0, set PMR=0xff and IGRPEN1=1, armed CNTV, unmasked IRQ and
  executed WFI.
- About 19.6 ms later (the programmed ~15.6 ms plus scheduling), the guest's IRQ vector ran with
  `ICC_IAR1_EL1 = 27`.
- In that sequence there were **zero** `VTIMER_ACTIVATED` exits and zero WFI exits, and the vtimer mask stayed false.
- The kernel wires CNTV to the in-kernel redistributor as PPI 27, which is
  `hv_gic_get_intid(HV_GIC_INT_EL1_VIRTUAL_TIMER)`.
- The other reserved INTIDs:

  | INTID | Interrupt | Note |
  |---|---|---|
  | 30 | EL1 physical timer | |
  | 26 | EL2 physical timer | EL2 only [from-header] |
  | 25 | Maintenance | EL2 only [from-header] |
  | 23 | PMU | |

  Put these values in the DTB `timer` node: `interrupts = <PPI 13>, <PPI 14>, <PPI 11>, <PPI 10>`. These are
  the secure-phys, phys, virt and hyp PPIs, i.e. INTIDs 29/30/27/26. **INTID 29 (secure phys) is not
  reserved by HVF.** Listing it is harmless [from-docs/unverified].
- **Latency caveat:**
  - The guest's timer IRQ arrives **about 2–4 ms late when the vCPU idles in in-kernel WFI**: 17.4–19.6 ms
    for a 15.625 ms deadline.
  - If the guest busy-waits, delivery is on time (15.63 ms).
  - Thread QoS USER_INTERACTIVE made no difference.
  - Probable cause: host timer coalescing for the WFI wait [from-docs/unverified].
  - Expect jittery guest timekeeping in idle. Measure again with a real Linux guest (e.g. `cyclictest`)
    before deciding whether to fight it. One option is a no-GIC fallback that handles WFI in user space,
    but that costs the in-kernel GIC.

  [verified-on-machine]
- The physical timer is presumably also in-kernel. `CNTP_*` sysregs become accessible once a GIC exists
  [verified-on-machine]. Delivery of INTID 30 was not tested [from-docs/unverified].
- The run loop should still handle `VTIMER_ACTIVATED` defensively: log it and unmask.

**Counter offset:**

- The relation is `CNTVCT_EL0 = mach_absolute_time() - vtimer_offset`, per vCPU [from-header].
- The default offset is 0. The guest's CNTVCT matched the host's `mach_absolute_time()` within a few hundred
  ticks [verified-on-machine].
- For a guest clock that starts near 0, set the same offset (`mach_absolute_time()` at boot) on **every**
  vCPU before its first run. Otherwise SMP guests see skewed counters [from-docs/unverified reasoning].
- The offset is also the save/restore hook for timer state. CNTV_CTL/CVAL are ordinary sysregs.

## 9. In-kernel GICv3 (`hv_gic_*`, macOS 15+)

### Ordering

The spike verified this sequence: `hv_vm_create` → `hv_gic_config_create` → `set_distributor_base` /
`set_redistributor_base` / (`set_msi_region_base` + `set_msi_interrupt_range`) → `hv_gic_create` →
`hv_vcpu_create`.

- The header says the GIC must be created after the VM and before any vCPU. Doing it the other way was not tested.
- There is one GIC per VM. A second `hv_gic_create` returns `HV_BUSY`. [verified-on-machine]
- The GIC bases need not be the QEMU-virt ones: `macvmm doctor` creates its probe GIC with the distributor at
  IPA 0x0 and the redistributor region at 0x1_0000, and `hv_gic_create` returns `HV_SUCCESS`.
  [verified-on-machine, M0, 2026-11-18]

### Geometry on M5 Pro [verified-on-machine]

| Region | Size | Base alignment | QEMU-virt base used |
|---|---|---|---|
| Distributor | 0x10000 | 0x10000 | 0x0800_0000 ✓ |
| Redistributor (per vCPU: RD_base + SGI_base frames) | 0x20000 | — | — |
| Redistributor region (total) | 0x200_0000 (32 MiB = 256 slots) | 0x10000 | 0x080A_0000 ✓ (also 0x40_0000_0000 with 40-bit IPA ✓) |
| MSI frame (GICv2m-style) | 0x10000 | 0x10000 | 0x0802_0000 ✓ |
| SPI INTIDs | 32 .. 1019 (count 988) | | |

### Which accesses the kernel handles [verified-on-machine, `gicprobe`]

- **Handled in the kernel (no exit):**
  - the 64 KiB distributor
  - the 128 KiB redistributor slot of each **created** vCPU
  - the 64 KiB MSI frame
- **Exit to the VMM as ordinary data aborts:**
  - redistributor slots of vCPUs that don't exist
  - the rest of the 32 MiB redistributor window
  - one byte past each region

  That is why PL011 at 0x0900_0000 and virtio-mmio at 0x0a00_0000 keep working even though they sit inside
  the nominal 32 MiB window that starts at 0x080A_0000.
- The DTB should give `reg` for the redistributor as `nr_vcpus * 0x20000`. This fits QEMU's 0xF6_0000 window
  up to 123 vCPUs; we are capped at 64 anyway. Accesses to absent slots should be RAZ/WI in the VMM.
  [verified-on-machine geometry; DTB sizing is our decision]

### Registers seen through the API [verified-on-machine]

| Register | Value | Meaning |
|---|---|---|
| `GICD_TYPER` | 0x0478_001f | ITLinesNumber=31 (1024 INTIDs), IDbits=16, **LPIS=0** (no ITS/LPIs), MBIS=0, SecurityExtn=0 |
| `GICD_PIDR2` | 0x30 | ArchRev=3 |
| `GICD_CTLR` at reset | 0x50 | ARE=1, **DS=1**: a single security state, so the guest sees a non-secure-only GIC and Group 1 |
| `GICD_CTLR` after the guest wrote 0x13 | 0x53 | |
| `ICC_SRE_EL1` | 0x7 | SRE/DFB/DIB. System-register interface only. There is no GICv2 memory-mapped CPU interface. |
| `ICC_PMR_EL1` | 0xf8 after writing 0xff | 5 priority bits |
| `GICM_TYPER` | 0x8050_0040 | v2m MSI_TYPER: SPI base 80, count 64 — exactly the configured `set_msi_interrupt_range(80, 64)` |

- The DTB needs a `gicv2m`-style `msi-controller` frame (`arm,gic-v2m-frame`), not an ITS.
  [verified geometry; DTB binding choice from-docs/unverified]
- `GICR_TYPER` for vCPU *n* has Affinity = MPIDR[23:0 | 39:32 packed], ProcNum = vcpu id, and Last=1 only on
  the highest vcpu id. [verified-on-machine]
- **Quirk:** a guest *32-bit* read of GICR_TYPER returned 0, while a 64-bit read returned 0x10. Linux uses a
  64-bit read (`gic_read_typer`); bare-metal test guests must do the same. [verified-on-machine]

### Redistributor placement vs MPIDR [verified-on-machine]

- `hv_gic_get_redistributor_base(vcpu)` returns `HV_BAD_ARGUMENT` until MPIDR_EL1 has been **written**, even
  if you write the same value 0. After that, it returns `GICR_BASE + vcpu_id * 0x20000`.
- **Slots follow vCPU creation order, not MPIDR.** In the SMP test, Aff0 was set to the reverse of creation
  order, and slots still followed creation order. The guest discovers its frame by matching
  GICR_TYPER.Affinity, so any order works.
- Rule for the VMM: create vCPU *i* sequentially and set MPIDR so that Aff0 = i. For more than 16 CPUs, use
  Aff1 = i/16 and Aff0 = i%16, mirroring QEMU's GICv3 cluster size [from-docs/unverified].
- The MPIDR value must include RES1 bit 31.

### Interrupt injection

| API | Behaviour | Tag |
|---|---|---|
| `hv_gic_set_spi(intid, level)` | Called from a **non-vCPU thread** while the guest sat in in-kernel WFI. It woke the vCPU, which took IRQ INTID 33 (~35 ms after the call was scheduled 30 ms out). `level=false` deasserts it. | [verified-on-machine] |
| Level vs edge | `level=true` also produces an edge for edge-triggered interrupts; `false` is ignored for edge. An intid outside the SPI range, or inside the MSI range, gives `HV_BAD_ARGUMENT`. Virtio-mmio interrupts are level-triggered: assert while `InterruptStatus != 0`, deassert after the guest ACKs. | [from-header]; virtio semantics [from-docs/unverified] |
| `hv_gic_send_msi(ipa_of_GICM_SETSPI_NSR, intid)` | Host-initiated MSI, for virtio-pci later. | [from-header] |
| SGIs (IPIs) | Handled entirely in the kernel through `ICC_SGI1R_EL1`. | [from-docs/unverified]; to be verified at the SMP milestone |
| `hv_vcpu_{get,set}_pending_interrupt` | Return `HV_UNSUPPORTED` once a GIC exists. | [verified-on-machine] |

### Host-side register access

These calls give the VMM read/write access to GIC state:

- `hv_gic_{get,set}_distributor_reg`, `_msi_reg`: enum value = register offset, so you can loop over offsets.
- `hv_gic_{get,set}_redistributor_reg(vcpu, …)`: owning thread only. The offsets are from RD_base; SGI-frame
  registers sit at +0x10000.
- `hv_gic_{get,set}_icc_reg(vcpu, …)`: owning thread only.
- `ich` / `icv` registers: only with EL2 enabled.

[from-header]. The reads in the table above were [verified-on-machine].

### Save, restore and reset

1. `hv_gic_state_create()` requires the VM to be stopped. Then call `hv_gic_state_get_size`, then
   `hv_gic_state_get_data`. The data is opaque and versioned. On this machine it is a **binary plist**
   (starts with `bplist00`) of 126 363 bytes for 1 vCPU. [verified-on-machine]
2. The blob covers everything **except the ICC CPU registers**. Save those per vCPU with `hv_gic_get_icc_reg`.
   [from-header]
3. `hv_gic_set_state(buf, len)` must come after the GIC and vCPUs are created and before any run, according
   to the header. It returned `HV_SUCCESS` even after the vCPU had run. Don't rely on that. A restore may fail
   across macOS updates. [header + verified-on-machine]
4. `hv_gic_reset()` resets the distributor, redistributors and internal state; GICD_CTLR returned to 0x50.
   Use it for SYSTEM_RESET. [verified-on-machine]

## 10. Interrupts without a GIC (for completeness only)

- `hv_vcpu_set_pending_interrupt(vcpu, HV_INTERRUPT_TYPE_IRQ|FIQ, true)` asserts the vCPU's IRQ/FIQ line for
  the next run only. It "is automatically cleared after hv_vcpu_run returns". [from-header]
- `get_pending_interrupt` succeeded without a GIC. [verified-on-machine]
- `set_pending_interrupt(IRQ, true)` **succeeds without a GIC** and the guest takes the IRQ at
  `VBAR_EL1 + 0x280` (risk R19 closed: `hvf_gic_live` test `nogic_pfr0_and_pending_interrupt`, and the
  `timer_nogic` e2e test: 10 × 100 ms intervals, 10 VTIMER_ACTIVATED and 10 WFI exits). [verified-on-machine, M8]
- **The line is held for the whole `hv_vcpu_run`, not just until the IRQ is taken.** A guest handler that
  silenced CNTV and returned (`eret`) with PSTATE.I clear re-took the same IRQ immediately, forever, without one
  exit (9.8 s of guest exec time, no progress, until `--timeout`). The VMM can only drop the line at the next
  exit, so while the line is up it forces one: a one-shot `hv_vcpus_exit` ~1 ms after each entry
  (`timer::LineKicker`), after which the before-entry rule sees `ENABLE = 0` and stops asserting. With that,
  `guests/timer-nogic`'s plain handler (no `SPSR_EL1.I` trick) passes 10/10 (M8 review fix). A real controller
  avoids this because the acknowledge/EOI is something the controller (here: a trap) sees.
  [verified-on-machine, M8]
- With this model the VMM must emulate GICD/GICR MMIO and trap the ICC sysregs itself, as QEMU's TCG-GIC + HVF
  does. We do **not** do this; the in-kernel GIC is the decision.

## 11. EL2 / nested virtualization (macOS 15+, M3 and later)

| Fact | Tag |
|---|---|
| `hv_vm_config_get_el2_supported` = true on M5 Pro. `set_el2_enabled(cfg, true)` and then `hv_vm_create` succeed. | [verified-on-machine] |
| Default CPSR is still 0. With CPSR=0x3c9 the guest runs at EL2 (`CurrentEL` read 0x8). | [verified-on-machine] |
| HCR_EL2 default = 0x8000_0000 (RW=1). The EL2 sysregs listed in `hv_sys_reg_t` (HCR/SCTLR/TCR/TTBR0/1/VBAR/ESR/ELR/SPSR/FAR/HPFAR/VTCR/VTTBR/CNTHCTL/CNTVOFF/... `_EL2`) become accessible. | [verified-on-machine] |
| Guest ID_AA64PFR0_EL1.EL2 still reads 0 through `hv_vcpu_get_sys_reg` in the EL2 VM. Whether the guest itself sees EL2 advertised was not checked. | [verified-on-machine] for the API read |
| HVC executed **at vEL2** is taken to the guest's own VBAR_EL2 vector. It is not a VMM exit. In the spike, VBAR_EL2=0 led to an instruction-abort exit at IPA 0x200. | [verified-on-machine] |
| Exits from a vEL2 guest still report EC 0x24 (from a "lower EL") for MMIO. | [verified-on-machine] |
| PMU registers with EL2 enabled are governed by ID_AA64DFR0_EL1.PMUVer. With PMUVer=0 (the default here), a PMU access is UNDEFINED *inside the guest*: guest ESR_EL2 EC=0x0, no VMM exit. With a non-zero PMUVer, the framework emulates the PMU. | [verified-on-machine] (PMUVer=0 case); emulation [from-header] |
| With EL2 enabled, the GIC adds ICH_* (list registers, VMCR, HCR) and ICV_* accessors, plus maintenance IRQ 25 and EL2 phys timer IRQ 26. `hv_vcpu_*_pending_interrupt` cannot inject into a nested guest. | [from-header] |
| The macvmm plan does not need EL2. Linux and FreeBSD boot at EL1. EL2 matters for running a guest hypervisor and possibly for the macOS-guest stretch goal. | design note |

## 12. SME summary

- Max SVL is 64 bytes (512-bit streaming vectors). The `ID_AA64SMFR0_EL1` value is 0x02f15cff00000000.
  [verified-on-machine]
- The guest can use SME if the ID registers advertise it, which is the default. The VMM must save and
  restore SME state for snapshots: `hv_vcpu_get_sme_state` plus Z/P/ZA/ZT0. Z/P are only readable while
  streaming mode is on, and ZA/ZT0 while PSTATE.ZA is set. [from-header]
- **A Linux guest will detect SME.** Hide it by writing a modified `ID_AA64PFR1_EL1` / `ID_AA64SMFR0_EL1`
  with `hv_vcpu_set_sys_reg` if needed. Whether those ID registers are writable was not tested.
  [from-docs/unverified]

## 13. Open questions / not yet verified

1. Delivery of the EL1 physical timer (INTID 30) and of SGIs/IPIs between vCPUs with the in-kernel GIC.
2. `hv_gic_send_msi` and guest writes to `GICM_SETSPI_NSR`.
3. Whether ID registers (PFR1/SMFR0/DFR0) accept `set_sys_reg` writes to hide features.
4. What `hv_gic_create` does if called after a vCPU exists. The header says it errors.
5. ~~The real guest stage-1 4K-page kernel on the 16 K stage-2 granule.~~ **Answered in M10 (§19):** Alpine's
   4 KiB-page 6.18 kernel boots to a shell on HVF's stage 2 unchanged. [verified-on-machine]
6. Which other sysregs trap with EL2 off. **Partly answered in M5 (§17)** for a hand-picked set; the full
   list a real kernel touches came from logging EC 0x18 during the Linux boot: **answered in M10 (§19)**, a
   stock 6.18 boot traps only `OSDLR_EL1` and `OSLAR_EL1`. [verified-on-machine] Note `MDCCSR_EL0`
   is forwarded and currently UNDEF by policy: a kernel with `CONFIG_HVC_DCC` would take that UNDEF.
7. The cause of the 2–4 ms vtimer wake-up lateness from WFI (§8), and whether any knob reduces it. Under
   Linux (M10, §19) the whole cost of a 10 ms `usleep` (fork/exec of the applet included) is ~1.2 ms, so the
   lateness does not show at Linux's timer granularity; its cause is still unknown.
8. Whether `hv_vcpus_exit` stickiness can bite us. A kick that arrives just after a run returns makes the next
   run return immediately; this is harmless if the loop simply re-checks its flags.

## 14. M1 re-verification through the `hvf` crate (2026-11-18, macOS 27.2, M5 Pro)

PLAN M1 re-ran the spike's key observations through the safe wrappers instead of raw FFI.
Each item below is now **[verified-on-machine]** by a named test in `crates/hvf/tests/smoke.rs`
(`cargo test -p hvf --features hvf-tests -- --test-threads=1`, 15/15 passing) or by
`scripts/check-ffi.sh`:

| Fact | Evidence |
|---|---|
| Second `hv_vm_create` (raw, bypassing the singleton) returns `HV_BUSY`; create/destroy repeats, with and without a GIC | `vm_create_twice_is_busy`, `vm_recreate_after_destroy` |
| 16 KiB map at a 4 KiB-aligned IPA, or a 4 KiB length, returns `HV_BAD_ARGUMENT`; overlap returns `HV_ERROR` | `map_requires_16k_alignment`, `vm::hvf_tests::owned_mapping_roundtrip_and_remap` |
| HVC exit: ESR exactly `0x5a000000`, PC already past the HVC; SMC exit: PC at the SMC | `hvc_pc_already_advanced`, `smc_pc_not_advanced`, `macvmm first-exit` |
| `str w2, [x1, #0x18]` to unmapped `0x0900_0000`: EC 0x24, ISV 1, SAS 2, SRT 2, WnR 1, IPA and FAR both `0x09000018` (MMU off) | `mmio_exit_reports_full_ipa_and_isv` |
| `stp` to MMIO gives ISV 0 | `stp_to_mmio_gives_isv0` |
| `mrs x4, PMCR_EL0` traps as EC 0x18 with ISS `0x30e499`; `SysReg::from_iss` gives 0xdce0 | `pmcr_read_traps_ec_0x18` |
| `hv_vcpus_exit` from another thread → CANCELED; a kick before `run` is sticky and consumed by one run | `vcpus_exit_from_other_thread`, `sticky_kick_returns_canceled` |
| The inline-asm setter for Q5 is seen by the guest itself (`umov x0, v5.d[0]` / `v5.d[1]`), not only by `hv_vcpu_get_simd_fp_reg`; a mutated trampoline that puts a different vector in `v0` fails the test | `simd_q5_roundtrip` |
| GIC geometry: distributor 0x10000, redistributor 0x20000, region 0x200_0000, both alignments 0x10000, MSI region 0x10000, SPIs 32 + 988; vtimer INTID 27, EL1 phys timer 30; GICD_TYPER.ITLinesNumber 31 | `gic_sizes_match_m5` |
| `hv_gic_get_redistributor_base` refuses until MPIDR_EL1 is written; then slot 0 = GICR base; GICR_TYPER.Last = 1 for a single vCPU | `redistributor_base_requires_mpidr` |
| `hv_gic_set_spi(33, true)` from a non-vCPU thread wakes a vCPU in in-kernel WFI; the guest reads INTID 33 from ICC_IAR1_EL1 | `gic_set_spi_from_other_thread_wakes_wfi` |
| `hv_vcpu_get_reg` from a non-owner thread returns `HV_BAD_ARGUMENT` | `vcpu_get_reg_from_other_thread_fails` |
| **ABI:** 366 constants (including all 152 `HV_SYS_REG_*`, built in Rust from ARM ARM coordinates) and 47 type sizes/alignments/field offsets in `ffi.rs` equal what clang computes from the 27.2 SDK headers; all 81 statically linked functions compile at `-mmacosx-version-min=15.0 -Werror=unguarded-availability-new` | `scripts/check-ffi.sh` |
| **Availability (correction to §1/§6 framing):** besides the four symbols ADR-0002 lists, `hv_sme_config_get_max_svl_bytes` and all ten `hv_vcpu_{get,set}_sme_*` functions are `API_AVAILABLE(macos(15.2))`, and `hv_vm_config_get_default_ipa_granule` / `hv_vm_config_get_ipa_granule` are 26.0 like the setter. Under the 15.0 baseline they must be resolved with `dlsym` too; `crates/hvf/src/optional.rs` does so for all 18, and `check-ffi.sh` proves each one is clean at its stated release and an availability error one release earlier | `scripts/check-ffi.sh` step 5 (clang against the header) |
| `hv_sme_zt0_uchar64_t` (a 64-byte `ext_vector_type`) has size 64 but **alignment 16**, not 64; `hv_simd_fp_uchar16_t` is size 16, align 16 | `check-ffi.sh` layout lines |

## 15. M3 findings: the run loop with real guests (2026-11-18, macOS 27.2, M5 Pro)

Measured while bringing up PLAN M3 (`scripts/test-e2e.sh guests`, 9/9 passing).

| Fact | Evidence | Tag |
|---|---|---|
| **HVF answers `hvc #0` in the kernel, without an exit, for W0 in `0xC600_0000..=0xC600_001F`** (the first 32 IDs of the SMC64 vendor-specific *hypervisor* service range, OEN 6). The guest gets `x0 = 0x0000_0000_ffff_ffff` back and the VMM never sees the call. Every other ID probed exits normally with EC 0x16: `0xC600_0020..=0xC600_03FF`, `0x8600_0000..=0x8600_003F`, `0xC500_0000..=0xC500_003F`, `0xC400_0000..=0xC400_001F`, `0x8400_0000..=0x8400_0008`, `0x8000_0000..=0x8000_000F`. | Raw `--raw` probe guests that loop `hvc #0` over each ID range and count the exits the VMM logs (992 of 1024 in the `0xC600` range: exactly `0x00..=0x1F` missing). A guest calling `0xC600_0001` (the originally planned DEBUG_PUTC) printed nothing; DEBUG_EXIT `0xC600_0002` was ignored, so the guest spun in its `wfi` fallback until `--timeout`. | [verified-on-machine] |
| Consequence: the macvmm debug hypercalls moved from `0xC600_0001..4` (architecture §8.6, PLAN M3) to **`0xC600_4D01..4`** (`0x4D` = 'M'), in `crates/vmm/src/smccc.rs` and `guests/common/hvc.rs`. The lead should update architecture §8.6 and CURRICULUM. Anything else we put in OEN 6 must avoid `0x00..=0x1F` too. | `e2e_guests` (hello, memtest, exit-bench all pass with the new IDs) | [verified-on-machine] |
| **Exit round-trip cost, with our handling:** `guests/exit-bench` makes 100,000 `hvc #0` calls with the unknown ID `0xC600_00FF` (the VMM decodes the exit, dispatches, answers -1 and rate-limits its warning). Measured from the guest's `CNTVCT_EL0` (24 MHz): **1014, 1091, 1102 and 1143 ns per exit** in four runs (debug build of `macvmm`). This is the full guest → HVF → VMM → HVF → guest trip including macvmm's decode and dispatch, and at about 1.0–1.15 µs it falls within, at the low end of, the spike's 1.0–1.6 µs host-side `hv_vcpu_run` range: our decode and dispatch cost is not measurable at this resolution, and the trap itself dominates. | `exit_bench` e2e test output, e.g. `exit-bench: 100000 hvc in 2434723 ticks, 1014 ns/exit` | [verified-on-machine] |
| A vCPU whose MPIDR was set, PC/X0–X3/CPSR written, `SCTLR_EL1.{M,C,I}` cleared and the vtimer offset set to `mach_absolute_time()` runs an ELF linked at `0x4008_0000` from `GuestRam` mapped RWX; `str w9, [x8]` to the hole at `0x0c00_0000` exits with ESR `0x93890046` (ISV 1, SAS 2, SRT 9, WnR 1) and IPA `0xc000000`. | `mmio_poke` e2e test (`[stderr] unhandled MMIO write at 0xc000000 size 4 pc 0x40081010`, exit 3) | [verified-on-machine] |


## 16. M4 findings: exit decode, MMIO emulation, the fatal dump (2026-11-18, macOS 27.2, M5 Pro)

Measured while bringing up PLAN M4 (`scripts/test-e2e.sh guests`, 14/14 passing).

| Fact | Evidence | Tag |
|---|---|---|
| **The ch06 self-fault chain happens exactly as the lesson describes.** With `SCTLR_EL1.A = 1` and `VBAR_EL1 = 0`, an unaligned `ldr x` at EL1 is taken **at EL1** (no VM exit): `ESR_EL1 = 0x96000021` (EC 0x25 data abort same EL, IL 1, **ISV 0**, DFSC 0x21 alignment fault), `ELR_EL1` = the load (`0x40081094`), `FAR_EL1` = the unaligned address. The vector fetch at `VBAR_EL1 + 0x200 = 0x200` (flash, unmapped without `--bios`) is the VMM's first non-HVC exit: `ESR_EL2 = 0x82000006` (instruction abort, translation fault), IPA `0x200`, PC `0x200`, `CPSR = 0x824003c5` (EL1h, DAIF masked). | `self_fault` e2e (exit 3, the dump on stderr) | [verified-on-machine] |
| ISV = 1 syndromes for every load/store width and sign-extending form reach the VMM as the ARM ARM describes: `strb/strh/str w/str x`, `ldrb/ldrh/ldr w/ldr x`, `str xzr` and `ldr xzr` (SRT = 31), `ldrsb w`, `ldrsh x`, `ldrsw x` against the testdev at `0x0b00_0000`; 22 data-abort exits, all emulated, 10/10 checks pass. | `mmio_probe` e2e and its trace markers (`mmio-probe.trace.txt`) | [verified-on-machine] |
| An `svc` at EL1 is taken by the guest's own vector table (EC 0x15, `ESR_EL1 = 0x5600004d` for `svc #0x4d`) and never exits to the VMM. | `regcheck` e2e (`regcheck: vectors ok …`) | [verified-on-machine] |
| `mrs CurrentEL` = `0x4`, `MPIDR_EL1` = `0x80000000`, `SCTLR_EL1.M` = 0 and `DAIF` = `0x3c0` after `Vcpu::reset` with `CPSR = 0x3c5`. `SCTLR_EL1` reads `0x30000182` at the fault above (after the guest set A): HVF's reset value has the RES1 bits set and M/C/I clear. | `regcheck` and `self_fault` e2e | [verified-on-machine] |
| **`open(2)` with `O_NOFOLLOW | O_NOFOLLOW_ANY` fails with `EINVAL`** on macOS 27.2; each flag alone works, and both refuse a final-component symlink with `ELOOP`. `HostIo::open_output` therefore uses `O_NOFOLLOW_ANY` alone (after resolving the parent directory, since `/tmp` and `$TMPDIR` themselves contain symlinks). | A C probe in M4 (create/existing/symlink × each flag combination); `hostio::tests::output_policy`, `paths.rs` trace cases | [verified-on-machine] |
| Exit round-trip cost with M4's per-exit bookkeeping (PC read, clock, `ExitRecord`, ring push, counters; no `--trace`): **1153, 1170, 1171, 1234, 1240, 1265, 1283 ns** per `hvc` (debug build), against 1014–1143 ns in M3 (§15): about +100 ns, roughly 10 %. | `exit_bench` e2e, seven runs | [verified-on-machine] |

## 17. M5 findings: sysreg traps, injection, PSCI, reboot (2026-11-18, macOS 27.2, M5 Pro)

Measured while bringing up PLAN M5 (`scripts/test-e2e.sh guests`). Probes: one-instruction `--raw` guests
(`mrs x4, <reg>; b .`, VBAR_EL1 = 0) run through `macvmm` with `--trace exits:F`, plus a throwaway `hvf`
smoke test comparing a VM with and without the in-kernel GIC.

| Fact | Evidence | Tag |
|---|---|---|
| **The in-kernel GIC changes sysreg trapping.** `mrs x4, PMCR_EL0` exits as EC 0x18 (ESR `0x6230e499`) on a VM *without* a GIC (with or without MPIDR set), but on a VM *with* `hv_gic_create` there is no EC 0x18 exit: the guest takes an UNDEF at EL1 (`ESR_EL1 = 0x02000000`, `ELR_EL1` = the `mrs`), and the first VMM exit is its vector fetch at `0x200` (EC 0x20). Same for `PMUSERENR_EL0`, `PMCCNTR_EL0`, `PMCNTENSET_EL0`, `PMEVCNTR0_EL0`, `PMSIDR_EL1`, `AMCR_EL0`, a trace ID register and `S3_{0,1,3,4,5,6,7}_C15_C0_0`. | temporary `hvf` smoke test (2×2 matrix GIC × MPIDR); the raw probes | [verified-on-machine] |
| Forwarded as EC 0x18 with the GIC: `OSLAR_EL1`, `OSLSR_EL1`, `OSDLR_EL1`, `MDCCSR_EL0`, `LORID_EL1`. No exit (framework-handled): `MDSCR_EL1`, `DBGBVR0_EL1`, `DBGCLAIMSET_EL1`, `DBGAUTHSTATUS_EL1`, `ERRIDR_EL1`, `ID_AA64DFR0_EL1`. | raw probes; `sysreg_probe` e2e trace | [verified-on-machine] |
| **VMM-side UNDEF injection works**: writing `ELR_EL1`, `SPSR_EL1`, `ESR_EL1 = 0x02000000`, `CPSR = 0x3c5` and `PC = VBAR_EL1 + 0x200` through `hv_vcpu_set_{sys_,}reg` makes the guest's EL1h synchronous vector run with exactly those values; `ERET` resumes after the hook skips the `mrs`. | `sysreg_probe` e2e (`MDCCSR_EL0`, `"action":"inject_undef"`, `sysreg-probe: mdccsr undef count=1 ec=0x0`; before the M5 review fixes it used `LORID_EL1`, which is now RAZ) | [verified-on-machine] |
| The OS lock reads back as emulated: `OSLSR_EL1 = 0xa` after `OSLAR_EL1 = 1`, `0x8` after `0`. | `sysreg_probe` e2e | [verified-on-machine] |
| SMCCC/PSCI IDs used by M5 all exit as EC 0x16: `0x8000_0000/1`, `0x8400_0000..0A`, `0xC400_0001/3/4`, and the SiP ID `0x8200_0000` (answered -1 by macvmm with a warning). | `psci_probe_reboot` e2e and its trace | [verified-on-machine] |
| **In-process reboot is cheap**: a guest that calls SYSTEM_RESET as its first instruction drives 11 full machine rebuilds (VM + GIC + 64 MiB RAM + vCPU) to the reset-storm verdict in **6.5–13 ms** of wall time (debug build, two runs), about 0.6–1.2 ms per reboot, against the ~10 ms architecture §14.5 estimated. | `reset_storm` e2e (`reset_storm: stopped after 12.96925ms`, `6.522334ms`) | [verified-on-machine] |
| A guest-side atomic read-modify-write (`fetch_add`) with the MMU off faults with `ESR_EL1 = 0x96000035` (EC 0x25, DFSC 0x35, unsupported exclusive/atomic access): all memory is Device-nGnRnE then. Guests must use plain loads and stores until they enable the MMU. | the first `sysreg_probe` run | [verified-on-machine] |

## 18. M17 findings: ISV = 0 data aborts with the guest MMU on (2026-11-18, macOS 27.2, M5 Pro)

Measured while bringing up PLAN M17 (`scripts/test-e2e.sh guests hostile`: `isv0_probe`, `hostile_isv0`).

| Fact | Evidence | Tag |
|---|---|---|
| Pairs (`stp`/`ldp`/`ldpsw`, W and X, offset/pre/post), single-register writeback forms (`str x, [x0, #8]!`, `ldrsh x, [x0], #2`) and SIMD stores (`str q0/d0/s0`, `stp q0, q1`, `st1 {v0.16b}`) and loads (`ldr q0`) to an unmapped IPA all exit with EC 0x24 and **ISV = 0**; plain `ldr`/`str` keep ISV = 1. The isv0-probe trace has 15 `"isv":false` and 24 `"isv":true` records. | `isv0_probe` e2e + `isv0-probe.trace.txt` | [verified-on-machine] |
| With the guest MMU on (4 KiB granule, T0SZ 25, alias VA `0x0b10_0000` → IPA `0x0b00_0000`), `exception.physical_address` is the **IPA** (`0xb0000a0` for an `ldp` through the alias) and `virtual_address` is the VA; the PC is a VA, so the VMM must walk the guest tables to fetch the instruction. | `isv0_probe` check 13 (`ldp x via stage-1 alias ok`) | [verified-on-machine] |
| A pair whose second element is outside the faulting device, both at a device-window end with the MMU off (`stp x` at `0x0b00_0ff8`) and across a page whose next page maps the PL011, reports the **first** element's IPA (`0xb000ff8`). | `hostile_isv0` stderr: `ISV=0 write at 0xb000ff8 ... (pair is not inside one device window ...)`, `(second element at 0x9000000, expected 0xb001000)` | [verified-on-machine] |
| A VMM-injected synchronous external abort (`ESR_EL1` EC 0x25, DFSC 0x10, WnR, `FAR_EL1` = the VA) is taken by the guest's EL1h vector exactly like an UNDEF injection (§17); 12/12 counted, and no device register was written by a refused store pair. | `hostile_isv0`, `isv0_probe` (`simd store -> sync external abort ok`) | [verified-on-machine] |
| `stp x, [sp, #-16]!` at EL1t with SP_EL0 pointed at MMIO uses SP_EL0 (read and written back through `HV_SYS_REG_SP_EL0`), and SP_EL1 is untouched. | `isv0_probe` check 14 | [verified-on-machine] |

## 19. M10 findings: Linux 6.18 boots to a shell (2026-11-19, macOS 27.2, M5 Pro)

Measured while bringing up PLAN M10 (`scripts/test-e2e.sh linux`): Alpine `linux-virt` 6.18.60-0-virt
(`Image-virt`, sha256-pinned), our test initramfs, `--mem 512M`, one vCPU, the in-kernel GICv3, debug build.

| Fact | Evidence | Tag |
|---|---|---|
| **The stock kernel boots unmodified to `/ # ` and powers off through PSCI SYSTEM_OFF** in about 0.34–0.47 s of wall time (`Run /init` at 0.12 s guest time). The 4 KiB-granule stage 1 on HVF's 16 KiB stage 2 needs nothing from the VMM (open question 5). | `linux_boot` (`wall 338.934667ms`, `468.894625ms`), `linux_shell` | [verified-on-machine] |
| **The only EC 0x18 traps of a whole boot are `OSDLR_EL1` (enc `0x809c`) and `OSLAR_EL1` (enc `0x8084`)**, one write each, from `clear_os_lock`/the debug-monitors init; both are in the policy table (`arch/sysreg.rs`, OS lock emulation) and traced `"action":"sysreg"`. No UNDEF was injected. Everything else the kernel touches (ID registers, `ICC_*`, PMU probes under the GIC, the debug registers) is handled inside HVF. | `linux_boot_exits`: `EC 0x18 seen: ["OSDLR_EL1", "OSLAR_EL1"]` (trace `exits:F:sysreg,hvc`) | [verified-on-machine] |
| **The SMCCC calls of a boot** (all HVC, EC 0x16): `PSCI_VERSION`, `PSCI_MIGRATE_INFO_TYPE`, `PSCI_FEATURES` (×5), `SMCCC_VERSION`, `SMCCC_ARCH_FEATURES` (×4: the Spectre workaround probes), `TRNG_VERSION`, `VENDOR_HYP_CALL_UID` (×2), `PSCI_SYSTEM_OFF`. The last three non-PSCI probes are answered -1 by the `PROBES` table (`smccc.rs`, anchor `smccc_known_probes`) without a warning; no `0xC600_*` debug call was made or answered (HC-2: off for an Image under `DebugHvc::Auto`). | `linux_boot_exits` (`HVC calls seen: [...]`, asserts no `DEBUG_*`); stderr has no `unknown SMCCC` | [verified-on-machine] |
| **Risk R3 is resolved.** Linux logs `CPU features: detected: GICv3 CPU interface`, `GICv3: 988 SPIs implemented`, `GICv3: CPU0: found redistributor 0 region 0:0x00000000080a0000`, and the PL011 and PL031 interrupts work (the shell reads typed input). No sysreg-interface complaint, so nothing was needed beyond M8's `hv_gic_create` ordering. | `linux_boot` serial log; `linux_shell` | [verified-on-machine] |
| **vtimer latency under Linux:** 100 × `usleep 10000` timed with `/proc/uptime` takes **1.12–1.13 s** (six runs), i.e. ~1.2 ms over 10 ms per iteration, fork/exec of the busybox applet included. `--stats` for that run: `vtimer 0, wfx 0` exits (the GIC handles the timer and WFI in the kernel, §0 item 4), `exec 0.14 s, wfi 1.07 s`, host CPU 0.25 s over 1.28 s wall (20 %). | `linux_timer_latency` (`took 1.13 s`); three `--stats` runs (`took 1.12 s`) | [verified-on-machine] |
| Linux names the timer `arch_timer: cp15 timer running at 24.00MHz (virt).` (singular; the PLAN text had `timer(s)`, the marker follows the capture). Linux also detects SME and SME2 on this host (`CPU features: detected: SME2`), so HVF exposes SME to EL1 by default. | `linux_boot` serial log | [verified-on-machine] |
| A boot's exit mix: ~33 000 exits for the `timer-latency` case, of which 32 956 are data aborts (PL011 traffic: 12 156 bytes written, plus the driver's flag-register reads), 16 HVC, 2 sysreg. The PL011 is the dominant exit source of a console boot. | `--stats` `vcpu0 exits:` line | [verified-on-machine] |
| SIGUSR1 while Linux idles at the prompt prints `vcpu0: last 256 exits, oldest first:` and 256 records on stderr; the guest keeps running and answers the next command. SIGINT at the prompt ends the run with exit code 130 in 4.5–7 ms. | `linux_ring_dump`; `linux_sigint` (`exited 6.946458ms after SIGINT`) | [verified-on-machine] |
