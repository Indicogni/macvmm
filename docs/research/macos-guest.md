# Feasibility study: a macOS guest on a from-scratch Hypervisor.framework VMM

Status: research, 2026-11-18. Author role: hypervisor researcher (macOS guest track).
Scope: whether `macvmm`, our Rust VMM on Hypervisor.framework (HVF), can boot an arm64 macOS guest,
what that would take, and what the project should ship now and later.

> **Bottom line.** QEMU's `vmapple` machine shows that a third-party VMM *can* boot macOS on Apple
> Silicon, but only in a narrow window: macOS 12 guests, on M1–M3 hosts, with
> ParavirtualizedGraphics APIs that changed in macOS 15.4. **On this dev machine (M5 Pro, macOS 27.2)
> every modern-guest path we know of needs the private `com.apple.private.hypervisor` entitlement.
> Using it means turning off SIP and AMFI. We confirmed the denial here: `hv_vm_create` returns
> `HV_DENIED`.** A shippable, ad-hoc-signed `macvmm` therefore cannot promise a macOS boot on current
> hardware. Recommendation: ship this study, an S0 companion tool built on Virtualization.framework,
> and an experimental S1 ("AVPBooter runs in our VMM and we log its first device probe"). Build the
> reusable pieces (PCIe/virtio-pci, ISV=0 load/store emulation) because Linux and FreeBSD benefit
> too. Treat S2 and later stages as research with no boot promise.

---

## 0. Legend and method

Every factual claim carries one of these tags:

| Tag | Meaning |
|---|---|
| **[V-local]** | Verified on this machine (M5 Pro `Mac17,16`, macOS 27.2.1 build 26B131, Darwin 27.2.0) with a command or a small test program. The test sources were in the session scratchpad and are not part of the repo. |
| **[V-src]** | Verified by reading a primary source: Apple SDK headers on this machine, QEMU `master` source, or the macOS SLA text shipped on this machine. |
| **[R]** | Reported by a secondary source (mailing-list patch, issue tracker, blog, forum). We read it but did not reproduce it. |
| **[U]** | Unverified inference or educated guess. Treat it as a hypothesis. |

Method note: we inspected Apple binaries only with `ls`, `shasum`, `strings`, `codesign -d`, the
SDK `.tbd` export lists, and the Objective-C runtime (`class_copyMethodList`). **We did not
disassemble or decompile anything.** The SLA forbids that; see §6. Device semantics below come from
QEMU's GPL source, which is the public reimplementation, and not from Apple binaries.

---

## 1. What is on this machine

### 1.1 Firmware and resources inside Virtualization.framework [V-local]

`/System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/` (framework bundle
`CFBundleVersion 308.2.7`) contains:

| File | Size | sha256 | What it is |
|---|---|---|---|
| `AVPBooter.vmapple2.bin` | 335 KB | `9cefbfa5e7478945ab909c4300bd375072bd2ae4d4d5c28c63f50ece5162f928` | The pre-boot ROM for the `vmapple2` (macOS guest) platform. Raw AArch64 code from offset 0 (no Mach-O or Img4 wrapper). Banner string: `AVPBooter for vmapple2 Copyright 2007-2026, Apple Inc.`, `mBoot-20457.41.3`. |
| `AVPBooter.vresearch1.bin` | 336 KB | `451d69dc…a3324b` | ROM for the Security Research VM / PCC VRE platform (`vresearch101`). Out of scope. |
| `AVPSEPBooter.vresearch1.bin` | 168 KB | `1578e7d2…ae74a3` | Virtual SEP boot ROM for vresearch1. Out of scope. |
| `VZG11.fd`, `VZG21.fd` | 2.1 MB, 1.0 MB | `59c8cdaf…7113`, `a85f954a…e6` | EFI firmware volumes, presumably for `VZEFIBootLoader` (Linux and other generic guests) [U]. |

Strings in `AVPBooter.vmapple2.bin` that bear on the design [V-local] (`strings` output only):
`Apple DDI Secure Boot Root CA - G11` (an embedded certificate, so the booter verifies signatures),
`SDOM:%02X CPID:%04X … ECID:%016llX` (iBoot-style identity, hence the ECID requirement),
`virt_syscfg`, `synth_syscfg` and `SysConfig3` (it reads a config region), `virtio-usb`, `boot-args`,
`boot-breadcrumbs`, `iBoot Panic`. These match QEMU's description of AVPBooter as an iBoot
derivative that reads a configuration region and loads the next stage from disk.

Also present: `/System/Library/Kernels/kernel.release.vmapple` (17 MB), the host OS's copy of the
guest-platform kernel [V-local]. We will not use it. The real guest loads its own kernelcache from
the guest disk.

**Policy:** we load `AVPBooter.vmapple2.bin` read-only from this system path at run time. We never
copy, commit, bundle, or redistribute it.

### 1.2 The Virtualization.framework API surface [V-src: SDK headers]

All of these are `API_AVAILABLE(macos(12.0))` unless noted:

- `VZMacPlatformConfiguration`: properties `hardwareModel`, `machineIdentifier`, `auxiliaryStorage`.
- `VZMacHardwareModel`: an opaque `dataRepresentation` plus `isSupported`. You get one from
  `VZMacOSRestoreImage.mostFeaturefulSupportedConfiguration.hardwareModel`. The header says the
  hardware model "abstracts a set of virtualized hardware elements and configurations" and must be
  preserved for later boots.
- `VZMacMachineIdentifier`: an opaque `dataRepresentation`. **[V-local]** On macOS 27.2 the
  representation is a property list with one key, `ECID` (an integer). **[re-verified M20, macOS 27.2.1]**: the
  integer is an unsigned 64-bit value and can exceed `Int64.max` (`0xca8d706a46fe7143` seen). This is what QEMU's
  `contrib/vmapple/uuid.sh` extracts (`plutil -extract machineId … | plutil -extract ECID`). The value
  feeds QEMU's `-M vmapple,uuid=` and ends up in the cfg region's `ecid` field.
- `VZMacAuxiliaryStorage`: `initCreatingStorageAtURL:hardwareModel:options:error:`, `initWithURL:`
  (13.0+). It behaves like NVRAM plus boot-policy storage. QEMU's docs say to strip its first `0x4000`
  bytes of metadata before use (`dd … bs=0x4000 skip=1`) [V-src: QEMU docs].
- `VZMacOSBootLoader`, `VZMacOSInstaller`, `VZMacOSRestoreImage`, and
  `VZMacOSConfigurationRequirements`.
- New in macOS 27: `VZMacGuestProvisioningOptions`, which sets up the first user, auto-login, and
  SSH on first boot after restore. It needs a macOS 27 guest. This is useful for S0 automation.
- Graphics: `VZMacGraphicsDeviceConfiguration`, which is ParavirtualizedGraphics behind the scenes.

### 1.3 How Apple's own implementation is privileged [V-local]

The device process is
`…/XPCServices/com.apple.Virtualization.VirtualMachine.xpc` (14 MB). Its entitlements, from
`codesign -d --entitlements`, include **`com.apple.private.hypervisor`**,
`com.apple.private.virtualization`, `com.apple.private.AppleVirtualPlatformIdentity`,
`com.apple.private.FairPlayIOKitUserClient.Virtual.access`, `com.apple.private.PCIPassthrough.access`,
`com.apple.vm.networking`, and others, alongside the public `com.apple.security.hypervisor`.

C++ class names from `strings` give an inventory of Apple's devices:
`VzCore::Hardware::AppleAesEngine`, `SepCoprocessor`, `MmioPvPanicDevice` (`qemu,pvpanic-mmio`
compatible), `ParavirtualizedGraphicsGpuDeviceArm`, `ParavirtualizedGraphicsIoSurfaceMapper`,
`Storage::AvpAuxiliaryStorage`. Platform strings: `AVPBooter.vmapple1`, `AVPBooter.vmapple2`,
`apple,virtualization-generic-platform`, `disable_ecid_checks`.

**Lesson for the course:** Apple's macOS-guest VMM is not an ordinary HVF client. It runs with
private entitlements that a third-party, ad-hoc-signed binary cannot hold.

### 1.4 Experiments on this host [V-local]

Each experiment was a small C program, ad-hoc signed with **only** `com.apple.security.hypervisor`,
matching our signing policy.

| Experiment | Result | Meaning |
|---|---|---|
| `hv_vm_create(NULL)` | `HV_SUCCESS` | Baseline. |
| `__hv_vm_config_set_isa(cfg, 3)` then `hv_vm_create(cfg)` | `set_isa` returns `0`; **`hv_vm_create` returns `0xfae94007` = `HV_DENIED`** | The private Apple-ISA mode is gated by an entitlement. QEMU's RFC says modern macOS guests need it (§3.3). |
| `__hv_vcpu_config_set_fgt_enabled(cfg, true)` then `hv_vcpu_create` | both `0` | The fine-grained-trap knob is exported (no header) and accepted with the public entitlement. We did not check whether traps actually fire [U]. |
| `sysctl hw.optional.arm.FEAT_SSBS` | `0` | M5 Pro lacks FEAT_SSBS, like M4. Older macOS guests misbehave on such hosts (§3.3). |
| `sysctl hw.optional.arm.FEAT_SME / SME2` | `1 / 1` | SME is present. Guests must not see features they cannot handle; CPU feature masking matters. |
| `hv_gic_create` with dist `0x1000_0000`, redist `0x1001_0000` (the vmapple bases) | `HV_SUCCESS` | The in-kernel GICv3 accepts the vmapple layout. Dist size `0x10000`, per-CPU redist `0x20000`, redist region `0x2000000`, 64 KB alignment, SPIs 32..1019, MSI region `0x10000`. |

Exported-but-undocumented HVF symbols in `Hypervisor.tbd` [V-src]: `__hv_vm_config_set_isa`,
`__hv_vm_get_isa`, `__hv_vcpu_config_set_fgt_enabled`, `__hv_vcpu_config_set_vmkey`,
`__hv_vcpu_config_set_tlbi_workaround_enabled`, and `hv_vcpu_get_amx_*`. Our policy is hand-written
FFI to the *public* API, so any use of these needs an explicit ADR.

### 1.5 ParavirtualizedGraphics changed under QEMU's feet [V-src + V-local]

The SDK `PGDevice.h` on macOS 27 marks `PGTask_t`, `createTask`, `destroyTask`, `mapMemory`,
`unmapMemory`, `readMemory`, `addTraceRange` and `removeTraceRange` as
`API_OBSOLETED("No longer supported", macos(11.0, 27.0, 27.0))` with the note *"The legacy memory
mapping path has been removed."* It also obsoletes `PGNewDeviceWithDescriptor` in favour of
`PGCreateDeviceWithDescriptor` (15.2+) and deprecates `PGCopyOptionROMURL`.

ObjC runtime introspection on this host [V-local] shows the replacement, which is private and
unheadered:

- `PGDeviceDescriptor` gained `memoryMapDescriptor`, `usingIOSurfaceMapper`, `enableProcessIsolation`,
  `deviceFeatureLevel`, and others.
- `PGMemoryMapDescriptor` has `-addRange:(PGGuestPhysicalRange_s){u64 gpa; u64 len; void *host}`.
  This is a static table of guest-physical to host-virtual ranges, given once at device creation.
- `PGIOSurfaceHostDeviceDescriptor` (the second MMIO window that vmapple needs) now has **only**
  `mmioLength`, `raiseInterrupt` and `memoryMapDescriptor`. **`setMapMemory:` no longer exists**, so
  QEMU `master`'s `apple-gfx-mmio.m`, which still calls it, would die with "unrecognized selector".
  That matches QEMU issue #2913 on macOS 15.4 [R].

The public `PGDeviceSpec.h` describes the PCI flavour (vendor `0x106b`, device `0xeeee`, 16 KB BAR,
one MSI vector). vmapple uses an MMIO flavour that is not in public headers.

---

## 2. How Virtualization.framework boots macOS (the "high-level API")

The flow follows Apple's sample "Running macOS in a virtual machine on Apple silicon" and the headers
[V-src]. Personalization details are [U].

1. **Restore image.** Use `VZMacOSRestoreImage.fetchLatestSupported` or load a local `.ipsw`. Its
   `mostFeaturefulSupportedConfiguration` gives a `hardwareModel` plus minimum CPU and memory.
2. **Create the artefacts.** Make a raw disk image, a `VZMacAuxiliaryStorage` created for that hardware
   model, and a fresh `VZMacMachineIdentifier` (a new ECID). Persist `HardwareModel` and
   `MachineIdentifier` as their `dataRepresentation` blobs.
3. **Install.** `VZMacOSInstaller(virtualMachine:restoringFromImageAt:)` boots the VM in a restore mode.
   The cfg region has `run_installer1/2` fields for this [V-src: QEMU cfg.c]. The installer partitions
   the disk and installs the OS. [U] Like a physical Mac, the boot objects are probably personalized
   (signed by Apple's TSS) for this ECID, which would explain why the machine identifier must stay
   stable and why QEMU must be given the same ECID.
4. **Boot.** `VZMacOSBootLoader` starts `AVPBooter.vmapple2.bin`. It reads the config region, reads the
   aux and root disks through the "backdoor" block interface, verifies, and hands off to the next
   stages and the kernelcache. [R: QEMU commit messages; consistent with the strings in §1.1.]
5. **Run.** The devices are virtio (blk/net/console/sockets/balloon/fs) over PCIe, an XHCI USB keyboard
   and trackpad, ParavirtualizedGraphics, AES engine, pvpanic, an RTC, and a GPIO power button.
   VZ enforces at most **two concurrent macOS VMs** per host for `VZMacPlatformConfiguration`
   [R: Apple DTS, forum thread 845455; VZErrorDomain code 6 per Eclectic Light].

The installation step is why every third-party macOS-guest effort so far, including QEMU, **installs
with Virtualization.framework first and only boots the result elsewhere.**

---

## 3. QEMU's `vmapple` machine (the existence proof)

History [V-src: QEMU git log for `hw/vmapple`]: Alexander Graf (Amazon, 2023) wrote the original
reverse engineering. Phil Dennis-Jordan revived it, and it was merged on 2025-03-04 for QEMU 10.0.
The `apple-gfx` display device (by Phil Dennis-Jordan) was merged earlier. Later commits are
maintenance only (header moves, Kconfig).

### 3.1 Memory map and interrupts [V-src: `hw/vmapple/vmapple.c`]

| Region | Base | Size | IRQ (SPI#) |
|---|---|---|---|
| Firmware (AVPBooter, RAM-backed) | `0x0010_0000` | 1 MiB | |
| Config region (`vmapple-cfg`, RAM) | `0x0040_0000` | 64 KiB | |
| GICv3 distributor | `0x1000_0000` | 64 KiB | |
| GICv3 redistributors | `0x1001_0000` | 4 MiB | |
| PL011 UART | `0x2001_0000` | 64 KiB | 1 |
| PL031 RTC | `0x2005_0000` | 4 KiB | 2 |
| PL061 GPIO (pin 3 is the power button via `gpio-key`) | `0x2006_0000` | 4 KiB | 5 |
| pvpanic-mmio | `0x2007_0000` | 2 B | |
| "Backdoor" block interface (`bdif`) | `0x3000_0000` | 2 MiB | |
| apple-gfx (PG GPU MMIO) | `0x3020_0000` | 64 KiB | 0x11 |
| apple-gfx IOSurface mapper MMIO | `0x3021_0000` | 64 KiB | 0x10 |
| AES engine window 1 / 2 | `0x3022_0000` / `0x3023_0000` | 16 KiB each | 0x12 |
| PCIe ECAM (GPEX) | `0x4000_0000` | 256 MiB | |
| PCIe MMIO window (identity-mapped) | `0x5000_0000` | ~512 MiB | 0x20..0x2f (INTx) |
| RAM | `0x7000_0000` | configured | |

CPU setup: no EL2 and no EL3, PSCI over **HVC**, secondaries start powered off, the virtual timer is
on PPI 27, and reset sets the PC to `0x0010_0000`. No DTB is loaded (`skip_dtb_autoload`); the
booter builds the Apple device tree itself. No MSI/MSI-X in the merged version, so XHCI needs the
`conditional-intr-mapping` quirk. Max 32 vCPUs. Virtio-PCI is `disable-legacy=on`.

**Implication for our codebase:** this layout conflicts with the `virt` map in our brief (RAM at
`0x4000_0000` there is ECAM here). `macos` would be a second machine profile. `layout.rs` should
hold a `MachineProfile` (`Virt`, `VmApple`) rather than global constants. This adds a profile; it
does not reopen the `virt` decision.

### 3.2 Devices, one by one [V-src: QEMU source unless marked]

| Device | QEMU file (lines) | What it does | Effort for us |
|---|---|---|---|
| **cfg** | `hw/vmapple/cfg.c` (195) | A RAM page that the booter reads: `version=2`, `nr_cpus`, `ecid`, `ram_size`, `run_installer1/2`, `rnd`, MAC addresses, `cpu_ids[]`, `serial` ("1234"), `model` ("VM0001"), `soc_name` ("Apple M1 (Virtual)"), and several fields labelled `unkN` with magic constants. | S: a static struct in guest memory. |
| **bdif** ("backdoor") | `hw/vmapple/bdif.c` (274) | MMIO block interface that AVPBooter/iBoot uses to read the **aux** (devid `0x1_0000`) and **root** (devid `0`) disks. The guest writes a GPA to `REG_CMD`. The device reads a `{sector, data, retval}` descriptor triple from guest memory, does a 512-byte-sector read, DMAs the result back, and writes a status byte. Read-only; QEMU caps `len` at 128 MiB. | S–M. A good **hostile-input lesson**: every address and length comes from the guest. |
| **pvpanic-mmio** | `hw/misc/pvpanic-mmio.c` (60) | Guest panic notification. VZ uses the same `qemu,pvpanic-mmio` compatible [V-local: strings]. | XS. |
| **AES engine** | `hw/vmapple/aes.c` (581) | A command FIFO (KEY, IV, DATA, STORE_IV, FLAG, …) with DMA from and to guest memory, AES-ECB and AES-CBC only (QEMU rejects every other block-mode value; see `docs/macos-guest-requirements.md`) with 128/192/256-bit keys, and "built-in" hardware keys (QEMU uses placeholder keys `{1}`, `{2}`, `{3}`). macOS's `IOAESAccelerator` drives it. | M. Needs AES; our minimal-deps rule means writing it ourselves or justifying a crate. Placeholder keys interact with any data VZ encrypted during install [U]. |
| **vmapple-virtio-blk** | `hw/vmapple/virtio-blk.c` (204) | Ordinary virtio-blk over **PCI**, except: (a) the `max_secure_erase_sectors` config field is reused as an "apple type" (aux or root); (b) an extra request type `0x10000` = BARRIER (QEMU treats it as a no-op). | S, once virtio-pci exists. |
| **virtio-net-pci** | stock | Network. QEMU uses slirp. | M. Our brief has no networking entitlement by default; vmnet needs `com.apple.vm.networking`. |
| **XHCI + usb-kbd + usb-tablet** | stock, plus 3 XHCI fixes | Input. macOS's XHCI driver uses event rings 1 and 2 even without MSI, which forced the quirk. | L. A USB host controller is a large device. |
| **apple-gfx-mmio** | `hw/display/apple-gfx{,-mmio}.m` (882+285) | Bridges two MMIO windows and two IRQs to `ParavirtualizedGraphics.framework` (`PGDevice`, plus the private `PGIOSurfaceHostDevice`). Metal renders the guest's frames. | L–XL from Rust: ObjC runtime FFI, Blocks ABI for callbacks, private classes, and macOS 15.4+ memory-map changes. |
| GICv3, PL011, PL031, PL061, GPEX PCIe host | stock | Standard ARM parts at vmapple addresses. | GIC/PL011/PL031: reuse ours. PL061: S. PCIe ECAM host + INTx: M. |

### 3.3 Guest and host support, and why it is narrow

| Constraint | Evidence | Status |
|---|---|---|
| **Guest: macOS 12 only.** "Versions 13 and later fail during early boot." | QEMU docs on `master`; v17 cover letter [V-src/R] | Still documented as 12-only on `master`. |
| **Host macOS 15.4+ broke `apple-gfx-mmio`** (removed `setMapMemory:`; new `PGMemoryMapDescriptor`) | QEMU issue #2913 [R]; selector absence on this host [V-local] | Fix series by Mohamed Mediouni ("vmapple: making it work on the latest macOS host releases", v1 Oct 2025 → RFC v7 Mar 2026) [R]. **Not on `master` as far as we can see** (`master` still uses the legacy blocks) [V-src]. One patch reverts "Do not build VMapple machine by default", so vmapple was dropped from default builds at some point [R]. |
| **M4 hosts (no FEAT_SSBS) cannot boot macOS < 13.4** even in VZ | Eclectic Light, MacRumors, Nov 2024 [R]; QEMU RFC "hvf: arm64: add workaround for Apple M4 to run older macOS versions" emulates `SCTLR_EL1.DSSBS` with private FGT traps [R] | **This M5 Pro also lacks FEAT_SSBS** [V-local]. So macOS 12, the only QEMU-proven guest, probably needs the FGT workaround here [U]. Eclectic Light (Nov 2026) says macOS 12 is the VM floor "regardless of chip" [R], but we found no explicit statement that the M4 bug was fixed. |
| **Modern guests (e.g. macOS 26 "Tahoe") need private Apple ISA mode** | RFC v7 7/7 "hvf: do not merge: enable private ISA": `_hv_vm_config_set_isa(cfg, 3)` plus the `com.apple.private.hypervisor` entitlement; **"Apple PAC is paravirtualised … hvc #0 … the guest dutifully goes into an infinite loop"** without it; testing needs SIP off and AMFI bypassed [R] | **On this host, `hv_vm_create` with ISA 3 under the public entitlement returns `HV_DENIED`** [V-local]. Not shippable. |
| **Modern guests also issue ISV=0 data aborts** (MMIO accesses whose syndrome does not describe the instruction) | Same RFC ("Tahoe uses ISV=0"); Lucas Amaral's "target/arm: ISV=0 data abort emulation library" v6, Apr 2026 [R] | Needs a load/store instruction decoder in the VMM. **Worth building anyway**: it is a strong lesson, and FreeBSD/EDK2 can produce ISV=0 too [U]. |

Our reading: QEMU's vmapple worked for macOS 12 guests on M1–M3 hosts running macOS 12–15.3. On
an M5 host with macOS 27 and a current guest, the known path runs through a private entitlement,
SIP off, and a private ISA level. We have not observed any third-party VMM boot macOS 27 under the
public entitlement [U: absence of evidence].

### 3.4 QEMU's documented workflow [V-src: `docs/system/arm/vmapple.rst`]

1. Install macOS 12 with a VZ-based tool (the docs assume `macosvm`).
2. `uuid.sh macosvm.json` extracts the ECID from the machine identifier.
3. Trim aux: `dd if=aux.img of=aux.img.trimmed bs=$((0x4000)) skip=1`.
4. Run:

```sh
qemu-system-aarch64 -serial mon:stdio -m 4G -accel hvf \
  -M vmapple,uuid="$ECID" \
  -bios /System/Library/Frameworks/Virtualization.framework/Resources/AVPBooter.vmapple2.bin \
  -drive file=aux.img.trimmed,if=pflash,format=raw \
  -drive file=disk.img,if=pflash,format=raw \
  -drive file=aux.img.trimmed,if=none,id=aux,format=raw \
  -drive file=disk.img,if=none,id=root,format=raw \
  -device vmapple-virtio-blk-pci,variant=aux,drive=aux \
  -device vmapple-virtio-blk-pci,variant=root,drive=root \
  -netdev user,id=net0,ipv6=off,hostfwd=tcp::2222-:22,hostfwd=tcp::5901-:5900 \
  -device virtio-net-pci,netdev=net0
```

Each disk is attached twice, once to the booter's bdif ("pflash" slots) and once as a virtio-pci
device for the kernel. Access is over SSH and VNC from inside the guest.

---

## 4. Licensing and EULA constraints [V-src: SLA text on this machine]

Source: `/System/Library/CoreServices/Setup Assistant.app/Contents/Resources/en.lproj/OSXSoftwareLicense.rtf`
("Software License Agreement for macOS", as shipped with 27.2). This is not legal advice; the project
owner should read the clauses.

- **§2B(iii), virtualization grant:** "…to install, use and run up to two (2) additional copies or
  instances of the Apple Software, or any prior macOS or OS X operating system software or
  subsequent release of the Apple Software, within virtual operating system environments on each
  Apple-branded computer you own or control that is already running the Apple Software, for
  purposes of: (a) software development; (b) testing during software development; (c) using macOS
  Server; or (d) personal, non-commercial use."
- The next paragraph bars service-bureau, time-sharing, terminal-sharing and relay use (except leasing
  under §3), and forbids virtualizing iOS, iPadOS, watchOS or tvOS on Macs.
- **§2N, No Reverse Engineering:** "You may not … decompile, reverse engineer, disassemble, attempt
  to derive the source code … decrypt, modify, or create derivative works of the Apple Software …
  (except as and only to the extent any foregoing restriction is prohibited by applicable law …)."

What this means for macvmm:

1. **Apple hardware only.** A macOS guest is allowed only on a Mac that is itself running macOS. HVF
   already guarantees this technically.
2. **At most two macOS guest instances per host, for the listed purposes.** VZ enforces the cap; our
   VMM would not be subject to VZ's check, so **we should enforce it ourselves** (a per-user lock
   directory with two slots) and document it. Teaching and course development fit "software
   development" and "personal, non-commercial use". A hosted or CI-farm product would not.
3. **No redistribution of Apple bits.** No AVPBooter, IPSW, aux image or disk image in the repo, the
   course site, or any release artefact. Learners use the copies on their own Mac.
4. **No reverse engineering by this project.** Device semantics come from QEMU's GPL-licensed
   reimplementation and public headers. Reading QEMU's code is fine. **Copying it is not fine for an
   MIT/Apache project**: QEMU is GPL-2.0-or-later. Write our implementations clean-room from
   documented behaviour (register offsets and struct layouts are facts; prose and code are not).
   Record the provenance of each device's knowledge in its module doc comment.
5. **Gray area to escalate.** S1/S2 debugging means watching which MMIO addresses AVPBooter touches
   in our VMM. That observes the behaviour of Apple software running as intended. Whether it counts as
   "reverse engineering" under §2N (and under local law, e.g. interoperability exceptions in EU/US
   law) is for the owner to decide. Recommendation: limit traces to verifying our implementation of
   QEMU-documented devices, never publish raw traces of Apple firmware, and never disassemble.
6. **Private entitlements.** Running with `com.apple.private.hypervisor` means disabling SIP and AMFI.
   That violates our "minimal entitlements, no sudo" rule and weakens the learner's machine. **We will
   not ship or instruct this.** At most, a clearly fenced "research note" can say it exists.

---

## 5. Work items for macvmm

Sizes: XS < 1 day, S 1–3 days, M 1–2 weeks, L 2–4 weeks, XL > 1 month, for one engineer who already
knows the codebase.

| # | Work item | Size | Reusable for Linux/FreeBSD? |
|---|---|---|---|
| W1 | `MachineProfile` abstraction in `arch/layout.rs` (virt vs vmapple maps, IRQ maps) | S | Yes (cleaner design) |
| W2 | Firmware loader: map a host file read-only from `/System/…/AVPBooter.vmapple2.bin` at `0x10_0000` (QEMU uses writable RAM; check whether the booter writes to itself [U]) | XS | Yes |
| W3 | vmapple CPU bring-up: EL1 entry, no DTB, HVC PSCI conduit (already in our design), secondaries off, `MPIDR` affinity | S | Mostly |
| W4 | Device: cfg region (populated struct in guest RAM, ECID from the `MachineIdentifier` plist) | S | No |
| W5 | Device: bdif backdoor block reads (hostile-input hardened) | S–M | No (but a great lesson) |
| W6 | Devices: pvpanic-mmio, PL061 + power-button GPIO, PL031/PL011 at new bases | S | pvpanic: yes |
| W7 | **PCIe host bridge (ECAM + INTx swizzle, BAR sizing/assignment)** | M–L | **Yes** (EDK2 and FreeBSD prefer PCI) |
| W8 | **virtio-pci modern transport** (common cfg, notify, ISR, device cfg caps) | M | **Yes** |
| W9 | vmapple virtio-blk variant (apple type field, BARRIER `0x10000`) | S | No |
| W10 | AES engine (FIFO, DMA, ECB/CBC; AES itself is a dependency decision) | M | No |
| W11 | XHCI + USB HID keyboard/tablet | L–XL | Somewhat |
| W12 | ParavirtualizedGraphics bridge from Rust: ObjC runtime FFI (`objc_msgSend`), Blocks ABI for `raiseInterrupt`, the private `PGIOSurfaceHostDevice`/`PGMemoryMapDescriptor` classes, a Metal-backed window | L–XL | No |
| W13 | virtio-net-pci + host backend (vmnet needs an extra entitlement; user-mode NAT is a big lesson of its own) | M–L | Yes |
| W14 | **ISV=0 data-abort emulation**: decode AArch64 LDR/STR (imm, reg, pair, pre/post-index, LDP/STP, exclusive?) and emulate against MMIO | M | **Yes** |
| W15 | CPU feature masking (ID registers): hide SME and other features the guest's era cannot handle; SSBS/FGT workaround for old guests on M4/M5 (uses a private, unheadered HVF symbol) | S–M (+ADR) | Partly |
| W16 | Private Apple ISA mode / PAC paravirtualization | **Blocked** (`HV_DENIED`) | No |
| W17 | 2-instance SLA guard, VM bundle format (disk, aux, HardwareModel, MachineIdentifier) | S | No |

---

## 6. Staged plan

### S0: companion tool using Virtualization.framework ("high-level vs low-level")

**What:** a small, separate tool (proposed `tools/vz-macos/`, Swift, since VZ is an ObjC/Swift API)
that:
1. takes a user-supplied `.ipsw`, or fetches `VZMacOSRestoreImage.latestSupported` into
   `~/.cache/macvmm` and records its sha256 on first download;
2. creates a VM bundle (`disk.img`, `aux.img`, `HardwareModel.bin`, `MachineIdentifier.bin`), installs
   macOS, and optionally uses `VZMacGuestProvisioningOptions` (macOS 27 guests) for a first user and
   SSH;
3. boots the bundle under VZ;
4. **also boots the same Linux Image/initramfs that macvmm boots**, with `VZLinuxBootLoader`, so learners
   can compare. VZ needs ~40 lines of configuration. macvmm needs thousands of lines, but you can see
   every exit.
5. prints the ECID from the machine identifier and produces a trimmed aux image for later stages.

**Lesson:** VZ is a *policy-rich, closed* VMM: private entitlements (§1.3), personalization, a
two-VM cap, devices you cannot inspect. HVF is a *mechanism*: you own every device and every
exit, and you get no Apple-only privileges. Some things are only possible with the high-level API
(installing macOS, modern macOS guests); others only with the low-level one (custom devices,
introspection, teaching).

**Entitlement:** `com.apple.security.virtualization` (public; ad-hoc signing is enough
**[verified-on-machine 2026-11-18, M20]**: ad hoc + hardened runtime with only this key validates
and boots a Linux guest; without it VZ refuses with `VZErrorDomain 2`. See `docs/macos/status.md`). Keep it out of the `macvmm` binary so the main VMM keeps exactly one entitlement.

**Effort:** 3–5 days, plus 1–2 days for the lesson. **Risk:** low. Install time is about 20–40 min
per run.

**Decisions for the lead:** (a) Swift in a Rust repo (the alternative, Rust over ObjC FFI to VZ, is
possible but teaches little); (b) the IPSW download is trust-on-first-use plus Apple's own signature
checks, not a pre-pinned manifest, because Apple rotates URLs. That needs an exception in our
download rule.

### S1: boot AVPBooter in macvmm and reach the first device probe

**What:** `macvmm --machine vmapple --bios /System/…/AVPBooter.vmapple2.bin` (feature-flagged
`experimental-vmapple`): profile W1, loader W2, CPU W3, in-kernel GIC at vmapple bases (accepted on
this host [V-local]), PL011 at `0x2001_0000`, and an "unknown MMIO" handler that logs
`(pc, gpa, width, r/w, value)`, returns 0, and continues (or stops after N unknown accesses).

**Exit criterion (observable):** the log shows AVPBooter executing and its first accesses to the cfg
region, bdif, the UART, or other device addresses, plus any HVC/SMC calls it makes. That is all we
claim. **It is not a boot.**

**Unknowns:** whether AVPBooter itself makes PAC-paravirt HVCs that need private ISA. If it does, S1
stops at "first HVC we cannot satisfy", which is still a valid, honest teaching endpoint [U].
Whether it prints anything to the PL011 [U].

**Effort:** 3–5 days once the Linux path has a working vCPU loop, GIC and PL011.

### S2: early devices (cfg, bdif, pvpanic, RTC, GPIO)

Populate cfg (W4) with the ECID from the S0 bundle. Implement bdif (W5) over the S0 bundle's aux
and root images, plus W6. **Exit:** bdif reads of the root disk succeed and the booter moves past
AVPBooter to its next stage (seen as new MMIO patterns, pvpanic, or UART text).
**Risk:** high. Personalization or ECID checks may fail without our knowing why (§2, step 3 [U]).
Guest version matters: macOS 12 is the only QEMU-proven guest, and it may not run on this M5
without W15. **Effort:** 1–2 weeks.

### S3: PCIe + virtio-pci + vmapple virtio-blk

W7, W8, W9. **Exit:** the XNU kernel probes the PCIe bus and opens the root disk. Without the private
ISA this is plausible only for older guests [U]. **Effort:** 3–5 weeks. W7 and W8 pay for themselves
on the Linux and FreeBSD tracks.

### S4: AES engine, ISV=0 emulation, CPU feature masking

W10, W14, W15. **Exit:** the kernel gets past storage and crypto bring-up. **Effort:** 3–4 weeks.

### S5: interaction (console, network, input)

W13 (virtio-net, for SSH as the first "it's alive" signal) and W11 (XHCI/HID). **Effort:** 4–8 weeks.

### S6: graphics

W12, ParavirtualizedGraphics from Rust. **Effort:** 4–8 weeks. **Risk:** very high: private classes that
Apple has already changed once (15.4), and process isolation.

### S7: modern guests

W16 is **blocked** for a public-entitlement VMM. Re-check each WWDC: if Apple documents a public
API for macOS-guest CPU modes, revisit.

### Effort summary

| Stage | Effort | Confidence it works on this M5 / macOS 27 host |
|---|---|---|
| S0 VZ companion | 1 week | High |
| S1 AVPBooter first probe | 3–5 days | High for "first MMIO observed"; medium for "gets far" |
| S2 early devices | 1–2 weeks | Low–medium |
| S3 PCIe/virtio-pci | 3–5 weeks | Infrastructure high; macOS kernel progress low |
| S4 AES/ISV=0/features | 3–4 weeks | Low |
| S5 net/input | 4–8 weeks | Low |
| S6 graphics | 4–8 weeks | Very low |
| S7 modern guests | n/a | **Blocked** (HV_DENIED) |

Total to a hypothetical "macOS 12 at a login prompt over SSH" is about 3–5 person-months, and it may
still be impossible on M4/M5 hosts. QEMU, a much larger codebase with devices already built, needed
years of part-time work to reach macOS 12 only.

---

## 7. Recommendation

**Ship now (this project iteration):**
1. This study, plus a course lesson "Why macOS guests are hard", built around the evidence table in
   §3.3 and the `HV_DENIED` experiment (learners can reproduce it in 20 lines of C or Rust).
2. **S0** companion tool and its "high-level vs low-level API" lesson.
3. **S1** behind `--features experimental-vmapple`, with the claim stated exactly: "AVPBooter executes
   in macvmm and we observe its first device accesses." Never say "boots macOS".
4. Build the **reusable** infrastructure that S3/S4 need when the Linux/FreeBSD tracks want it anyway:
   `MachineProfile` (W1), PCIe ECAM (W7), virtio-pci (W8), ISV=0 emulation (W14), ID-register masking
   (W15, public part).

**Later (research track, no promises):** S2 → S4, in that order, as a capstone. Each stage ends with an
honest status line in the docs ("observed X; blocked at Y").

**Not at all:** anything that needs `com.apple.private.hypervisor`, SIP/AMFI changes, shipping Apple
binaries, disassembling Apple firmware, or copying GPL QEMU code into our tree.

---

## 8. Risks and open questions

- **R1, entitlement wall (high, confirmed):** modern guests need private ISA mode, which is denied to
  us [V-local + R].
- **R2, M4/M5 CPU differences (high):** no FEAT_SSBS on this host [V-local]; older guests misbehave
  [R]. The workaround uses an unheadered HVF symbol, which needs an ADR.
- **R3, private PG API churn (high):** already broke QEMU once (15.4) [R + V-local].
- **R4, personalization/ECID (medium, unknown):** we do not know which checks AVPBooter makes on the cfg
  fields marked `unkN` [U].
- **R5, legal gray area around tracing (medium):** §4 item 5, needs an owner decision.
- **R6, licence hygiene (medium):** QEMU is GPL. Our implementation must be clean-room from documented
  facts.
- **R7, scope creep (high):** PCIe, XHCI and PG are each larger than our whole Linux MVP. Keep them
  out of the critical path.
- **Open:** Does AVPBooter make HVCs before its first MMIO? Does the hardware model blob from a
  macOS 27 restore image tie the guest to a platform version our cfg must report? Did Mediouni's
  series (v8+) land after 2026-03? Check `hw/display/apple-gfx-mmio.m` on QEMU `master` before S6.

---

## 9. Sources

Primary, on this machine:
- `/System/Library/Frameworks/Virtualization.framework/Versions/A/Resources/` (file list, sizes, sha256)
- SDK: `$(xcrun --show-sdk-path)/System/Library/Frameworks/{Virtualization,ParavirtualizedGraphics,Hypervisor}.framework`
  (headers and `.tbd` export lists)
- `/System/Library/CoreServices/Setup Assistant.app/Contents/Resources/en.lproj/OSXSoftwareLicense.rtf` (SLA §2B(iii), §2N)

QEMU (GPL-2.0-or-later; read, not copied):
- Docs: <https://www.qemu.org/docs/master/system/arm/vmapple.html>
- Source: <https://gitlab.com/qemu-project/qemu/-/tree/master/hw/vmapple>, `hw/display/apple-gfx.m`, `hw/display/apple-gfx-mmio.m`, `contrib/vmapple/uuid.sh`
- v17 cover letter (device list, limitations): <https://patchew.org/QEMU/20250112210056.16658-1-phil@philjordan.eu>
- Issue #2913, vmapple unusable on macOS 15.4: <https://gitlab.com/qemu-project/qemu/-/issues/2913>
- Mediouni series: RFC v1 (M4 workaround) <https://patchew.org/QEMU/20251007201837.28992-1-mohamed@unpredictable.fr>,
  v5 apple-gfx 15.4 memory map <https://patchew.org/QEMU/20260306145246.10274-1-mohamed@unpredictable.fr/20260306145246.10274-2-mohamed@unpredictable.fr>,
  RFC v7 <https://patchew.org/QEMU/20260324204855.29759-1-mohamed@unpredictable.fr>,
  7/7 private ISA <https://patchew.org/QEMU/20260324204855.29759-1-mohamed@unpredictable.fr/20260324204855.29759-8-mohamed@unpredictable.fr>,
  6/7 gicv2m macOS quirk <https://patchew.org/QEMU/20260324204855.29759-1-mohamed@unpredictable.fr/20260324204855.29759-7-mohamed@unpredictable.fr>
- ISV=0 emulation library (Lucas Amaral): <https://patchew.org/QEMU/20260409220614.65558-1-lucaaamaral@gmail.com>

Other:
- Apple DTS on the two-Mac-VM cap: <https://developer.apple.com/forums/thread/845455>
- Eclectic Light, how Apple limits VMs: <https://eclecticlight.co/2022/08/04/virtualisation-on-apple-silicon-macs-8-how-apple-limits-vms/>
- Eclectic Light, M4 cannot virtualise older macOS: <https://eclecticlight.co/2024/11/14/m4-macs-cant-virtualise-older-macos/>
- MacRumors, M4 < 13.4: <https://www.macrumors.com/2024/11/18/m4-macs-do-not-run-early-macos-vms>
- Eclectic Light, Nov 2026, older macOS on Apple silicon: <https://eclecticlight.co/2026/11/06/install-an-older-version-of-macos-on-an-apple-silicon-mac/>
- macosvm (VZ CLI that QEMU's docs assume): <https://github.com/s-u/macosvm>
