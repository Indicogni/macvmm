# Guest boot research: Linux direct boot, FreeBSD via U-Boot, EDK2

Status: research notes, written 2026-11-18. Audience: whoever implements `crates/vmm` loaders, the FDT
generator and the firmware path, plus the course authors.

**Evidence tags** used throughout:

- **[V]**: verified in this research session, either by downloading the artifact and inspecting its bytes
  (`file`, `xxd`, small stdlib-only Python parsers; nothing was executed), or by reading the current
  upstream source/doc text quoted here.
- **[S]**: taken from a specification or upstream document read for this note but not exercised
  (for example the DT spec, or what QEMU *does*, which is not necessarily what a guest *needs*).
- **[U]**: unverified. Recalled from memory or inferred. Must be confirmed by running it on our VMM.

Nothing in this document has been booted on macvmm yet. "Boots" claims below refer to QEMU behaviour.

Primary sources:

- Linux `Documentation/arch/arm64/booting.rst` (master, fetched 2026-11-18)
- Linux `drivers/of/fdt.c`, `drivers/amba/bus.c`, `drivers/tty/serial/amba-pl011.c`,
  `drivers/clocksource/arm_arch_timer.c` (master)
- QEMU `hw/arm/virt.c`, `hw/arm/boot.c`, `hw/char/pl011.c`, `hw/rtc/pl031.c` (master)
- Devicetree Specification v0.4, chapter 5 "Flattened Devicetree (DTB) Format"
- U-Boot `board/emulation/qemu-arm/qemu-arm.c`, `configs/qemu_arm64_defconfig`, `doc/board/emulation/qemu-arm.rst`
- FreeBSD `sys/arm/arm/generic_timer.c`, `sys/dev/virtio/mmio/virtio_mmio.c` (main)

---

## 1. Linux arm64 direct boot

### 1.1 The Image header (booting.rst §4) [V]

The kernel has no self-decompressor on arm64 (§3). The boot loader (us) must hand it a raw `Image`. That
`Image` starts with a 64-byte little-endian header:

| Off | Size | Field         | Notes |
|----:|-----:|---------------|-------|
| 0   | u32  | `code0`       | Executable. With `CONFIG_EFI` it is the `MZ` PE signature encoded as a harmless instruction. |
| 4   | u32  | `code1`       | Executable (branch to `stext`). |
| 8   | u64  | `text_offset` | Load offset from a 2 MiB-aligned base. Only meaningful if `image_size != 0`; if `image_size == 0` (pre-3.17), assume `0x80000`. Modern kernels: `0`. |
| 16  | u64  | `image_size`  | Effective size, *including BSS*. At least this many bytes from the image start must be free RAM. This is more than the file size. |
| 24  | u64  | `flags`       | bit 0: endianness (1 = BE). bits 1-2: page size (0 = unspecified, 1 = 4K, 2 = 16K, 3 = 64K). bit 3: physical placement (0 = as close to DRAM base as possible, 1 = anywhere within 48-bit PA). bits 4-63 reserved. |
| 32  | u64  | `res2`        | 0 |
| 40  | u64  | `res3`        | 0 |
| 48  | u64  | `res4`        | 0 |
| 56  | u32  | `magic`       | `0x644d5241` = bytes `"ARM\x64"` |
| 60  | u32  | `res5`        | PE header offset (for the EFI stub), otherwise reserved. |

Placement rules (§4):

- Load the Image at `text_offset` above a **2 MiB-aligned** base in usable RAM. Keep `image_size` bytes free from there.
- Memory below the image is usable by the kernel (since v4.6) unless it is reserved with `/memreserve/`.
- The **initrd** must lie entirely within a 1 GiB-aligned window of up to 32 GiB that also covers the kernel image.
- The **DTB** must be **8-byte aligned** and **≤ 2 MiB** (§2). It must not share a 2 MiB block with memory that
  needs non-cacheable attributes. All of our RAM is Normal memory, so this only means: never put it in MMIO.

Observed in the Alpine `virt` kernel (6.18.60, after unwrapping, see §2) [V]:
`text_offset=0x0`, `image_size=0x22a0000` (34.6 MiB; the file is 36,306,944 bytes, so here BSS sits inside the file
size), `flags=0xa` (LE, 4K pages, placement anywhere), `magic=0x644d5241`, `res5=0x40`.
Debian trixie installer kernel [V]: `text_offset=0`, `image_size=0x24f0000`, `flags=0xa`.

**What QEMU does** (`hw/arm/boot.c` `load_aarch64_image`) [V]: if `image_size != 0` it loads at
`RAM_base + text_offset`, and adds 2 MiB if that would overlap its boot stub. So a `text_offset=0` kernel lands at
**`0x4020_0000`**. It puts the initrd at `RAM_base + min(ram/2, 128 MiB)` (page-aligned, and above the kernel's end),
and the DTB right after the initrd, aligned up to 2 MiB. QEMU also transparently gunzips and unwraps EFI zboot
images. We should do the same as a host-side loader step.

**Recommended macvmm layout for direct boot** (RAM at `0x4000_0000`):

| What   | Where | Why |
|--------|-------|-----|
| DTB    | `0x4000_0000` (cap 2 MiB) | Same address firmware boot uses (U-Boot/EDK2 read the DTB from RAM base), so one code path. 8-byte aligned. |
| Kernel | `0x4020_0000` + `text_offset` | 2 MiB aligned, identical to QEMU. |
| initrd | `align_up(kernel_base + image_size, 2 MiB)`, or `0x4800_0000` if larger | Must not overlap `image_size`. Must stay inside the 1 GiB window. |

All three ranges must be bounds-checked against RAM with `checked_add`. Reject an Image if any of these hold:
the magic is wrong, `flags` bit 0 is set (BE), the page size is 64K (unsupported by our MMU plan; 4K and 16K are fine) [U],
or `image_size` would run past the end of RAM.

### 1.2 CPU state at entry (booting.rst §4 "Before jumping into the kernel") [V]

| Requirement | macvmm action |
|---|---|
| Quiesce all DMA-capable devices | Trivial: devices start reset. |
| `x0` = physical address of the DTB. `x1`, `x2`, `x3` = 0 (reserved) | Set via `hv_vcpu_set_reg`. Secondary CPUs get `x0..x3 = 0`, except that PSCI `CPU_ON` passes `context_id` in `x0`. |
| PSTATE: all of DAIF masked | `CPSR = 0x3c5` (EL1h, DAIF set). |
| Non-secure, at **EL2 (recommended) or EL1**. All CPUs at the same EL | Start at **EL1**. Linux then uses the virtual timer, which is exactly what HVF's vtimer exit models. See the timer note below. |
| MMU off. I-cache may be on with no stale lines. Image cleaned to PoC | HVF vCPUs start with `SCTLR_EL1.M = 0`. We write the image from the host, and HVF maps guest memory coherently. **MMU-off guest writes are visible to the VMM without cache maintenance, and host writes of the image are visible to the MMU-off guest [verified-on-machine]** (PLAN M3: `guests/memtest` runs with `SCTLR_EL1.{M,C,I} = 0`, writes 8 patterns over 16 MiB, and its own FNV-1a-64 equals the VMM's DEBUG_MEMHASH of the same window, read through the cacheable host mapping; the ELF the host copied in executes correctly). No explicit cache maintenance is needed on Apple Silicon for this direction or the image load. |
| `CNTFRQ_EL0` programmed with the timer frequency. `CNTVOFF` identical on all CPUs | HVF presets `CNTFRQ_EL0` to the host frequency. **Read it, don't assume 24 MHz** [U]. Use one `vtimer_offset` for all vCPUs. |
| With EL1 entry, `CNTHCTL_EL2.EL1PCTEN` set where available | Handled by HVF [U]. |
| All CPUs in the same coherency domain | Yes. |
| Every writable sysreg at or below the entry EL initialised by higher-EL software | HVF provides reset values. Booting.rst lists feature-specific EL2/EL3 trap requirements: FP/SIMD `CPTR` (not trapped), SVE/SME `ZCR/SMCR` LEN consistent across CPUs, PtrAuth, MTE, etc. With EL1 entry under HVF these are HVF's responsibility. If HVF hides a feature in the ID registers, Linux won't touch it [U]. |
| **GICv3**: if EL3 exists, `ICC_SRE_EL3.{Enable,SRE}`. With EL1 entry, `ICC_SRE_EL2.{Enable,SRE}=1`. The DT must describe a GICv3 | HVF's in-kernel GIC exposes the system-register CPU interface to EL1 [U: confirm `ICC_SRE_EL1.SRE` reads 1]. The DT must say `arm,gic-v3`. |

SMP (§4, "enable-method"): every `cpu` node needs `enable-method`. With `"psci"`, secondaries stay outside the
kernel until `PSCI_CPU_ON` (SMCCC function ID `0xC4000003` for SMC64/HVC64). The DT should have a `/psci` node.
Secondary entry state is the same as the primary's, with `x0` = `context_id` per the PSCI spec.

**Timer selection** (`arm_arch_timer.c` `arch_timer_select_ppi`) [V]:

- If the kernel runs at EL2 with VHE, it uses the **EL2 virtual timer** (PPI 12, INTID 28) if listed, otherwise the EL2 physical timer (PPI 10).
- Else if no hyp mode is available (EL1 entry), it uses the **virtual timer** (PPI 11, INTID 27).
- Else (non-VHE EL2) it uses the NS physical timer (PPI 14).

So **EL1 entry ⇒ the vtimer ⇒ `HV_EXIT_REASON_VTIMER_ACTIVATED` maps 1:1**. If we later enable HVF's EL2 support, the timer
story changes completely.

### 1.3 Command line and initrd in `/chosen` [V]

- `bootargs`: `console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1`
  - `earlycon=pl011,<addr>` gives output from the first instructions after the MMU is on, before the AMBA driver probes.
    Default iotype is `UPIO_MEM`, which does 8-bit accesses [U: check `pl011_putc`]. Our MMIO decoder must handle `strb`/`ldrb`
    as well as 32-bit accesses. A plain `earlycon` (no args) also works when `stdout-path` is set.
  - `panic=-1` makes a panic reboot immediately (PSCI `SYSTEM_RESET`). That is handy for e2e tests: no hang.
  - `rdinit=/init` is the default. Override it to run a test program from the initramfs.
- `linux,initrd-start` / `linux,initrd-end`: physical addresses. **End is exclusive**. Linux reads them with
  `of_read_number(prop, len/4)`, so either 1 cell (u32) or 2 cells (u64) work. Use 2 cells (u64).
- `stdout-path = "/pl011@9000000"` (QEMU uses the node path. An alias such as `serial0` also works).
- Optional: `kaslr-seed` (u64) and `rng-seed` (bytes). These help early entropy. A random value from the host is fine.

`CONFIG_VIRTIO_MMIO_CMDLINE_DEVICES=y` in Alpine [V] allows `virtio_mmio.device=0x200@0xa000000:<irq>`. However, the
`<irq>` there is a Linux IRQ number, not a GIC INTID, so it is unreliable on DT systems. **Use DT nodes** [U].

### 1.4 Minimal DTB for the macvmm "virt-like" machine

*M7 (2026-11-18):* implemented in `crates/vmm/src/fdt/machine.rs`; the frozen decompiled tree is
`crates/vmm/tests/golden/virt-1cpu-512m.dts` (`dtc` clean). Deviations from the sketch below, per
architecture §12.2 and PLAN §1: virtio-mmio interrupts are **level** (`<0 16+i 4>`), not QEMU's edge; `bootargs`
is omitted when there is no command line (test guests); `/chosen` also carries `rng-seed` (64 bytes) and
`kaslr-seed` from `getentropy(2)`. Whether Linux probes PL011/PL031 with this tree is confirmed in M10.

This mirrors QEMU `virt` (`hw/arm/virt.c`, verified property-by-property [V]). Interrupt specifiers for
`arm,gic-v3` are 3 cells `<type number flags>`:

- `type`: 0 = SPI, 1 = PPI. `number`: SPI n → INTID 32+n, PPI n → INTID 16+n.
- `flags`: 1 = edge rising, 4 = level high.

```dts
/dts-v1/;
/ {
    compatible = "linux,dummy-virt";      // QEMU's value; any string works for Linux
    model = "macvmm-virt";
    #address-cells = <2>;
    #size-cells = <2>;
    interrupt-parent = <&gic>;
    dma-coherent;                          // QEMU sets this on root; virtio nodes too

    chosen {
        bootargs = "console=ttyAMA0 earlycon=pl011,0x09000000 panic=-1";
        stdout-path = "/pl011@9000000";
        linux,initrd-start = <0x0 0x42600000>;   // u64 form
        linux,initrd-end   = <0x0 0x42f00000>;   // exclusive
    };

    memory@40000000 {
        device_type = "memory";
        reg = <0x0 0x40000000 0x0 0x40000000>;   // 1 GiB
    };

    cpus {
        #address-cells = <1>;              // 2 if any MPIDR has Aff3 != 0
        #size-cells = <0>;
        cpu@0 {
            device_type = "cpu";
            compatible = "arm,arm-v8";     // QEMU '-cpu host' uses this
            reg = <0x0>;                   // MUST equal MPIDR_EL1 affinity bits we program per vCPU
            enable-method = "psci";        // QEMU only emits it when ncpus>1; always emitting is fine
        };
        cpu@1 { device_type = "cpu"; compatible = "arm,arm-v8"; reg = <0x1>; enable-method = "psci"; };
    };

    psci {
        compatible = "arm,psci-1.0", "arm,psci-0.2", "arm,psci";
        method = "hvc";                    // we trap HVC #0 and implement SMCCC/PSCI
        // No cpu_on/cpu_off ids needed for 0.2+; QEMU adds legacy ids for 'arm,psci' only.
    };

    timer {
        compatible = "arm,armv8-timer", "arm,armv7-timer";
        always-on;                         // QEMU sets it unconditionally (virt.c)
        interrupts = <1 13 4>,             // secure phys   (INTID 29)
                     <1 14 4>,             // NS EL1 phys   (INTID 30)
                     <1 11 4>,             // virtual       (INTID 27)  <- HVF vtimer
                     <1 10 4>;             // NS EL2 phys   (INTID 26)
        // GICv2 would OR a CPU mask into flags bits 8..15; GICv3: plain 4.
    };

    gic: intc@8000000 {
        compatible = "arm,gic-v3";
        #interrupt-cells = <3>;
        interrupt-controller;
        #address-cells = <2>;
        #size-cells = <2>;
        ranges;
        #redistributor-regions = <1>;
        reg = <0x0 0x08000000 0x0 0x10000>,          // GICD (64 KiB)
              <0x0 0x080a0000 0x0 0x40000>;          // GICR: ncpus * 0x20000 (RD + SGI frame per CPU)
        // No 'interrupts' (maintenance IRQ) unless we expose EL2.
        // No ITS child: virtio-mmio uses wired SPIs, not MSIs.
    };

    apb_pclk: apb-pclk {                   // REQUIRED: AMBA bus enables "apb_pclk" before probing
        compatible = "fixed-clock";
        #clock-cells = <0>;
        clock-frequency = <24000000>;
        clock-output-names = "clk24mhz";
    };

    pl011@9000000 {
        compatible = "arm,pl011", "arm,primecell";
        reg = <0x0 0x09000000 0x0 0x1000>;
        interrupts = <0 1 4>;              // SPI 1 = INTID 33, level
        clocks = <&apb_pclk>, <&apb_pclk>;
        clock-names = "uartclk", "apb_pclk";
    };

    pl031@9010000 {
        compatible = "arm,pl031", "arm,primecell";
        reg = <0x0 0x09010000 0x0 0x1000>;
        interrupts = <0 2 4>;              // SPI 2 = INTID 34
        clocks = <&apb_pclk>;
        clock-names = "apb_pclk";
    };

    virtio_mmio@a000000 {                  // slot i: base 0x0a000000 + i*0x200, SPI 16+i
        compatible = "virtio,mmio";
        reg = <0x0 0x0a000000 0x0 0x200>;
        interrupts = <0 16 1>;             // SPI 16 = INTID 48, EDGE (QEMU uses edge for virtio-mmio)
        dma-coherent;
    };
    // QEMU emits 32 transports in reverse order, so the lowest address comes first in the tree.
    // We should emit only populated slots.
};
```

Notes and pitfalls:

1. **The fixed-clock is mandatory for PL011/PL031 under Linux** [V]. `drivers/amba/bus.c` `amba_get_enable_pclk()`
   does `clk_get(dev, "apb_pclk")` and fails the probe if that is missing. Only earlycon works without it. The PL011 driver
   also uses `uartclk` for baud math.
2. **PrimeCell ID registers** [V]. The AMBA bus reads `PeriphID0-3`/`PCellID0-3` at offsets `0xFE0-0xFFC`
   (8 × 32-bit, low byte each) and matches against the driver tables. Values (QEMU):
   - PL011: `11 10 14 00 | 0d f0 05 b1` → periphid `0x00141011`. Linux matches `0x00041011` with mask `0x000fffff`.
   - PL031: `31 10 14 00 | 0d f0 05 b1` → periphid `0x00141031`.
   - PCellID = `0xB105F00D`. An `arm,primecell-periphid` DT property can override the read [S].
3. `cpu@N/reg` must equal the MPIDR affinity we set with `hv_vcpu_set_sys_reg(MPIDR_EL1)`. The GIC redistributor of each
   vCPU (GICR_TYPER affinity) must agree. Get the redistributor and distributor sizes from
   `hv_gic_get_redistributor_size()` / `hv_gic_get_distributor_size()` instead of hard-coding `0x20000`/`0x10000` [U].
4. GICR window: QEMU reserves `0x080A_0000 + 0xF6_0000` (123 CPUs). We only describe `ncpus * redist_size`.
   GICD at `0x0800_0000`. The ITS slot (`0x0808_0000`) is left unused.
5. Unit-address in node names must be the lowercase hex of the first `reg` address, without `0x` or leading zeros.
   `dtc` warns about mismatches, and some code looks nodes up by name.
6. Device node order doesn't matter to Linux. Emit memory and cpus first anyway, for readability and debugging.

### 1.5 FDT binary format, enough to write a generator (DT spec v0.4 ch. 5) [verified-on-machine]

*Re-tagged by M7 (2026-11-18):* `crates/vmm/src/fdt/writer.rs` implements exactly this layout; `dtc 1.8.1`
decompiles its output with no warnings (`fdt_machine.rs::golden_dts_matches`, e2e `dtb_out_dtc_clean`), and the
bare-metal guest `guests/dtb-reader` parses the copy in guest RAM at `x0 = 0x4000_0000` on this Mac (e2e
`dtb_reader`). Header 40 bytes, reservation map at offset 40 (8-aligned), structure block 4-aligned, strings
deduplicated.

All header fields and tokens are **big-endian u32**. The layout is: header, then memory reservation block, then
structure block, then strings block. Recommended padding: 8 bytes before the reservation map, 4 bytes for the structure block.

Header (`struct fdt_header`, 40 bytes):

| Off | Field | Value |
|---:|---|---|
| 0  | `magic` | `0xd00dfeed` |
| 4  | `totalsize` | entire blob, including padding |
| 8  | `off_dt_struct` | offset of structure block |
| 12 | `off_dt_strings` | offset of strings block |
| 16 | `off_mem_rsvmap` | offset of memory reservation block (8-byte aligned) |
| 20 | `version` | `17` |
| 24 | `last_comp_version` | `16` |
| 28 | `boot_cpuid_phys` | `reg` of the boot CPU (0) |
| 32 | `size_dt_strings` | bytes |
| 36 | `size_dt_struct` | bytes |

**Memory reservation block**: pairs of `{u64 address, u64 size}` (BE). It is terminated by `{0, 0}`. Ours is normally
just the terminator. Linux reserves the DTB and initrd itself.

**Structure block**: a token stream, 4-byte aligned:

| Token | Value | Payload |
|---|---|---|
| `FDT_BEGIN_NODE` | `0x1` | node name, NUL-terminated, zero-padded to 4. The root node's name is `""`. |
| `FDT_END_NODE`   | `0x2` | none |
| `FDT_PROP`       | `0x3` | `u32 len`, `u32 nameoff` (offset into strings block), then `len` bytes of value, zero-padded to 4 |
| `FDT_NOP`        | `0x4` | none (ignored, used for in-place deletion) |
| `FDT_END`        | `0x9` | exactly once, last |

Properties of a node must come before its child nodes.

**Strings block**: concatenated NUL-terminated property names, with no alignment. Deduplicate names, so `nameoff` is shared.

Value encodings:

- `u32` cell: BE. `u64`: two cells, high first.
- string: bytes + NUL. stringlist: concatenated NUL-terminated strings (`"arm,pl011\0arm,primecell\0"`).
- empty (boolean) property: `len = 0`.
- `phandle`: a u32 property named `phandle`. References are plain u32 cells.
- `reg`: `(#address-cells + #size-cells)` cells per entry, taken from the **parent** node. If those properties are
  missing, the spec says assume 2/1. Always emit them explicitly.

Generator tips:

- Build an in-memory tree (or a streaming writer with a string table). Serialize, then check:
  `totalsize ≤ 2 MiB` (booting.rst) and 8-byte alignment of the load address.
- Leave some slack (for example 4 KiB) at the end and include it in `totalsize`. U-Boot copies and grows the tree
  for EFI anyway, but slack helps tooling that edits in place [U]. *M7 emits no slack* (the blob is exactly
  `totalsize`, which keeps the golden DTS byte-stable); revisit in M18 if U-Boot needs room in place.
- Test oracle: macOS has no `dtc` by default. `brew install dtc` gives `dtc -I dtb -O dts` for golden tests (dev-only, not a
  runtime dependency). Alternatively, write a small parser in the test module itself (that is also a lesson).

---

## 2. Obtaining a kernel + initramfs on macOS without a cross-compiler

### 2.1 Candidates inspected (2026-11-18)

| Artifact | URL (pinned path) | Format found | Verdict |
|---|---|---|---|
| **Alpine 3.24.4 `vmlinuz-virt`** | `https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/netboot-3.24.4/vmlinuz-virt` | **EFI zboot PE** [V]: `MZ`, `"zimg"` at +4, payload off `0xca78`, size `0x9dfb4b`, comp `"gzip"`. Inner payload = raw arm64 Image, 6.18.60-0-virt, 10.4 MB file | **Primary** |
| Alpine `initramfs-virt` | same dir | gzip'd cpio newc [V], 9 MB (25.7 MB unpacked), 288 entries. Contains `init` (Alpine shell script), dynamic busybox, `virtio_mmio.ko`, `virtio_blk.ko`, `squashfs.ko`, `vfat.ko` (uncompressed `.ko`). **No `ext4.ko`** | Primary (stock + appended overlay) |
| Alpine `config-6.18.60-0-virt` | same dir | text [V] | Pin it too. It documents the kernel features. |
| Debian 13 installer `linux` | `https://deb.debian.org/debian/dists/trixie/main/installer-arm64/20250803+deb13u7/images/netboot/debian-installer/arm64/linux` | **raw Image** [V] (`ARMd` at 0x38, PE stub). sha256 published in `SHA256SUMS`: `9c37ace5…0db67` | Good secondary: no unwrap needed. The paired `initrd.gz` is the d-i installer, not a test userland. |
| Ubuntu 24.04 `…-vmlinuz-generic` (cloud-images `unpacked/`) | `https://cloud-images.ubuntu.com/noble/current/unpacked/noble-server-cloudimg-arm64-vmlinuz-generic` | **gzip of raw Image** [V] | OK. `current/` floats, so pin a dated build dir. |
| Ubuntu 26.04 `…-vmlinuz-generic` | `…/resolute/current/unpacked/…` | **PE with many `.dtbauto` sections, no `zimg` header** [V]. A systemd-stub/UKI-style wrapper | Avoid: we would need to parse PE sections to find `.linux`. |
| Fedora 44 pxeboot `vmlinuz` | `https://dl.fedoraproject.org/pub/fedora/linux/releases/44/Everything/aarch64/os/images/pxeboot/vmlinuz` | **EFI zboot, `zstd`** [V] | Needs zstd. Homebrew `zstd` is present on this Mac, but Python 3.9 stdlib has no zstd. |

Alpine kernel config facts relevant to us [V] (`config-6.18.60-0-virt`):

- Built in (`=y`): `EFI_ZBOOT`, `KERNEL_GZIP`, `ARM64_4K_PAGES`, `ARM64_PA_BITS=48`, `ARM_GIC_V3`, `ARM_GIC_V3_ITS`,
  `ARM_PSCI_FW`, `ARM_ARCH_TIMER`, `SERIAL_AMBA_PL011(_CONSOLE)`, `SERIAL_EARLYCON`, `RTC_DRV_PL031`, `COMMON_CLK`, `VIRTIO`,
  `VIRTIO_PCI`, `VIRTIO_CONSOLE`, `DEVTMPFS(_MOUNT)`, `RD_GZIP`, `RD_ZSTD`, …
- Modules (`=m`): **`VIRTIO_MMIO=m`, `VIRTIO_BLK=m`, `EXT4_FS=m`**, `SQUASHFS=m`, `ISO9660_FS=m`.
  Consequence: virtio-mmio and virtio-blk only appear after `insmod`/`modprobe` from the initramfs.
  For a "console only" milestone this doesn't matter.
- `MODULE_SIG=y` but `MODULE_SIG_FORCE` is not set, so stray modules still load (tainting).
- `ARM64_SVE/SME/MTE/PTR_AUTH=y`: the kernel will use whatever HVF advertises in `ID_AA64*`.

### 2.2 Recommendation: Alpine 3.24.4 netboot `virt` flavour

Why: it is small (10 + 9 MB) and lives on a release-versioned path (`netboot-3.24.4/`, not the floating `netboot/`).
It is a virtualization-tuned kernel with PL011, PL031, GICv3 and PSCI built in. The initramfs carries
version-matched `virtio_mmio.ko`/`virtio_blk.ko` and a busybox userland. The zboot wrapper teaches a real loader step.

**Pinned sha256** (computed 2026-11-18 from the files downloaded over HTTPS; Alpine doesn't publish per-file
hashes for netboot members) [V]:

```
cd05fed9e617b5df93dc62ece9b78c422fd94e9b432a2f7c092714b139d5eef4  vmlinuz-virt
189402937646965374ef2df5d37f76467135179ae168c88175df2fe3e264a0b0  initramfs-virt
b7643cddcd3ba109183a2aaafa3c911d91e7d89485fd7b2caf5ede9396bf78ca  config-6.18.60-0-virt
a2cecb9b6fdbd83e87bd43c8040de67300d5b8dde1fc50c34714faa272888f17  Image-virt   (derived: unwrapped raw Image)
```

How to pin and why it is trustworthy:

- `scripts/fetch` downloads with `curl --proto '=https' -fSL` into `./.cache/macvmm/<name>.part`, runs
  `shasum -a 256`, compares against the manifest, and only then renames. A mismatch is a hard error.
- The values above are trust-on-first-use. For stronger provenance, cross-check once against the **signed** tarball
  `alpine-netboot-3.24.4-aarch64.tar.gz` (433 MB; its sha256 `9d10f909…9745e` is in `latest-releases.yaml`, with a
  `.asc` GPG signature). Extract it and compare the member hashes [U: not done here because of size].
- Do not pin the floating `latest-stable/` or `netboot/` paths. Note that `main/aarch64/*.apk` package files
  **churn**: the repo has already moved to `linux-virt-6.18.63-r0` while the release netboot is 6.18.60, and
  superseded apks vanish from the mirror [V for the version skew; U that old apks are deleted].

**Turning `vmlinuz-virt` into a raw `Image`** (stdlib only; this is what QEMU's `unpack_efi_zboot_image` does) [V]
[verified-on-machine 2026-11-19, M9: `cargo xtask unzboot` (Rust, `/usr/bin/gzip -dc`, 256 MiB cap) reproduces the
pinned `Image-virt` sha256 `a2cecb9b…` exactly, via `scripts/fetch.sh linux`].
The zboot header is: `+0 "MZ"`, `+4 "zimg"`, `+8 u32 LE payload_offset`, `+12 u32 LE payload_size`,
`+0x18 char[32] comp_type` ("gzip", "zstd", "lzma", "xzkern", "lz4", "lzo"). The research script used:

```python
# python3 -I unzboot.py vmlinuz-virt Image   (ran on this Mac; output verified with `file`)
b = open(src,'rb').read()
assert b[0:2]==b'MZ' and b[4:8]==b'zimg'
off, size = struct.unpack_from('<II', b, 8); comp = b[0x18:0x20].rstrip(b'\0')
assert off + size <= len(b)
img = gzip.decompress(b[off:off+size])          # comp == b'gzip'
assert img[56:60] == b'ARM\x64'
```

For production, do it **in Rust inside the VMM loader** (zboot detection plus a gzip inflater) or as a
host-side prepare step. The DEFLATE decoder is a dependency question: `miniz_oxide` is the obvious candidate
(justify it in `docs/dependencies.md`). Alternatively the fetch script produces `Image` with Python and pins the
derived hash too. Either way, cap the decompressed size (QEMU caps at `LOAD_IMAGE_MAX_DECOMPRESSED_BYTES`) and
validate offsets with `checked_add`. For zstd kernels (Fedora): `/opt/homebrew/bin/zstd` exists on this Mac, and
Python ≥ 3.14 has `compression.zstd`. System Python is 3.9.6, so it doesn't.

### 2.3 Tiny test initramfs on macOS

**Option A (recommended, zero extra downloads): append an overlay cpio to the stock initramfs.**
The kernel unpacks concatenated cpio archives in order, and later entries overwrite earlier ones
(`Documentation/driver-api/early-userspace/buffer-format.rst`) [S] [verified-on-machine 2026-11-19, M9:
`cargo xtask mkinitramfs` built `initramfs-virt || pad4 || overlay` (sha256 `d98e064d…`, reproducible across
builds); Alpine 6.18.60 under macvmm ran the overlay's `/init`, which printed
`macvmm-initramfs: ready 6.18.60-0-virt` and powered off]. Each member may be compressed
independently. So:

```
initramfs-test = initramfs-virt (gzip, as downloaded)  ||  overlay.cpio (uncompressed newc, 4-byte padded)
```

`overlay.cpio` contains only `init` (mode `0100755`), plus optionally `dev/console` (char 5:1, mode `020600`). newc
can encode device nodes without root privileges. The stock archive already provides `/bin/sh`→busybox (dynamic,
musl loader included [V]), and `bin`, `lib`, `sbin` are symlinks into `usr/` [V]. Example `/init`:

```sh
#!/bin/sh
/bin/busybox mount -t proc proc /proc
/bin/busybox mount -t sysfs sysfs /sys
/bin/busybox mount -t devtmpfs devtmpfs /dev
echo "MACVMM-BOOT-OK $(/bin/busybox uname -r)"
# virtio-blk smoke test (modules are version-matched, shipped in the same initramfs):
/bin/busybox insmod /lib/modules/$(/bin/busybox uname -r)/kernel/drivers/virtio/virtio_mmio.ko
/bin/busybox insmod /lib/modules/$(/bin/busybox uname -r)/kernel/drivers/block/virtio_blk.ko
[ -b /dev/vda ] && /bin/busybox sha256sum /dev/vda | /bin/busybox sed 's/^/MACVMM-VDA /'
/bin/busybox poweroff -f        # reboot(2) POWER_OFF -> kernel -> PSCI SYSTEM_OFF (HVC)
```

The host test asserts on `MACVMM-BOOT-OK` and on `MACVMM-VDA <sha>` (the hash of the raw disk the host created).
It also asserts that the VMM exited through PSCI `SYSTEM_OFF`. The newc writer is ~40 lines of Python stdlib.
Entry format: `"070701"` + 13 × 8 hex ASCII fields (ino, mode, uid, gid, nlink, mtime, filesize, devmajor,
devminor, rdevmajor, rdevminor, namesize incl. NUL, check=0), then name, padded to 4, then data, padded to 4,
and a final `TRAILER!!!` entry [S].
(The `.ko` paths above are real: `usr/lib/modules/6.18.60-0-virt/kernel/drivers/{virtio/virtio_mmio,block/virtio_blk}.ko` [V].)

**Option B: standalone initramfs with static busybox.** Alpine `busybox-static-1.37.0-r31.apk` (main/aarch64)
contains `bin/busybox.static`, an `ELF 64-bit aarch64, static-pie` [V]
(apk sha256 `965777e0…bc75`, file sha256 `999cb969…6d22`). The apk is a concatenation of gzip members (signature,
control, data). Python `gzip.decompress` plus `tarfile.open(..., ignore_zeros=True)` reads it [V]. Downside: repo apks churn
(see above), so this artifact is less stable than release files.

**Option C: a ~200-byte hand-made static ELF `/init`** (no libc), generated by a Python or Rust build step.
It uses raw syscalls: `write(1, msg, n)` = `svc #0` with `x8=64`, then `reboot(0xfee1dead, 0x28121969,
0x4321fedc /*POWER_OFF*/)` with `x8=142`. Alternatively build it as a Rust `aarch64-unknown-none` binary in `guests/`.
The kernel `exec`s any static ELF. This is pedagogically nice ("the smallest userland"), with zero third-party binaries [U: not built yet].
If `/init` exits instead, the kernel panics "Attempted to kill init!", which is also a usable signal together with `panic=-1`.

**Stock initramfs alone:** booting `initramfs-virt` unmodified with no network or boot media should end in
Alpine's "initramfs emergency recovery shell" (busybox `sh` on the console). Adding `single` to the cmdline also
yields a shell [U: from reading `/init`, not run].

### 2.4 Rootfs disk for virtio-blk

Constraints: Alpine's netboot initramfs has no `ext4.ko` [V], and macOS has no `mkfs.ext4` [V: not on PATH].

1. **Milestone 1: raw block test (no filesystem).** Use a host-generated pattern file as the disk. Assert the in-guest
   `sha256sum /dev/vda` (Option A above). This needs nothing beyond the stock artifacts.
2. **Milestone 2: ext4 rootfs.**
   - Contents: Alpine minirootfs `https://dl-cdn.alpinelinux.org/alpine/v3.24/releases/aarch64/alpine-minirootfs-3.24.4-aarch64.tar.gz`
     (sha256 `4b14c18f7e90a063b61462ea1462a5732c154bf6adad594974fe6487cd98a8de`, published in `latest-releases.yaml` and `.sha256`) [V].
   - Image builder: `brew install e2fsprogs` (keg-only, `/opt/homebrew/opt/e2fsprogs/sbin/mkfs.ext4`), then
     `mkfs.ext4 -F -L root -d <unpacked-dir> rootfs.img 256M` [U]. Caveats: files keep the macOS uid (501), which mke2fs `-d` copies, and
     APFS is case-insensitive by default. Extract the tarball with Python `tarfile` straight into the
     image builder's staging dir, and fix ownership with `-E root_owner=0:0` plus in-guest `chown -R` on first boot [U].
   - Modules: `ext4.ko` + deps (`jbd2`, `mbcache`, `crc16`/`crc32c` as modules.dep says) for **6.18.60-0-virt** live in
     `modloop-virt` (squashfs, 17 MB, same release dir). Extract with `unsquashfs` (`brew install squashfs`). Append them to
     the overlay cpio, `insmod` them, then `switch_root` to `/dev/vda` [U].
3. **Alternative: a prebuilt raw cloud disk.** Debian 13 `debian-13-genericcloud-arm64.raw` from
   `https://cloud.debian.org/images/cloud/trixie/<dated-build>/` (SHA512SUMS published) [V for existence/hashes].
   It is a GPT disk with an ESP and ext4. It boots via **firmware** (U-Boot or EDK2, then GRUB, then the Debian kernel), so it pairs
   with §3, not with direct boot. Direct boot would need the kernel and initrd extracted from ext4, which needs host ext4 tools.

---

## 3. FreeBSD/arm64 via U-Boot (and EDK2)

### 3.1 How QEMU virt + U-Boot `qemu_arm64` boots [V unless marked]

- QEMU maps `-bios u-boot.bin` into the flash at **`0x0`** (`VIRT_FLASH` = `0x0`, size `0x0800_0000`, two 64 MiB CFI banks,
  DT node `flash@0`, `compatible = "cfi-flash"`, `bank-width = <4>`).
  The vCPU starts at PC = 0, in EL1 for `virtualization=off` (EL2 if on).
- U-Boot `qemu_arm64` is linked at `CONFIG_TEXT_BASE = 0x0`: the first header doubleword at +8 of our `u-boot.bin` is 0 [V].
  It executes in place from flash (U-Boot's mem_map maps `0x0-0x0800_0000` as **Normal** memory), relocates itself to the top of RAM,
  and continues from there. `CONFIG_SYS_LOAD_ADDR = 0x4020_0000`, `ENV_ADDR = 0x0400_0000` (env in flash bank 1).
- **DTB source**: `board_fdt_blob_setup()` returns `CFG_SYS_SDRAM_BASE` = **`0x4000_0000`** ("QEMU loads a generated DTB for
  us at the start of RAM"). QEMU's `arm_setup_firmware_boot()` copies the DTB to the base of RAM when firmware is used.
  The DTB is U-Boot's *control* DT and is also what it passes to the OS (EFI configuration table, or `booti`).
  RAM size comes from the DT (`fdtdec_setup_mem_size_base()`), so **our generated DTB is the only hardware description U-Boot gets**.
- `board_late_init()` calls `virtio_init()`, which enumerates virtio-mmio devices from DT nodes `virtio,mmio`.
  U-Boot's virtio drivers poll and need no IRQ [U].
- Default env, from `strings` of the Alpine 2026.04 binary [V]: `bootcmd=bootflow scan -lb`,
  `boot_targets=qfw usb scsi virtio nvme dhcp`, `fdt_addr=0x40000000`, `scriptaddr=0x40200000`,
  `pxefile_addr_r=0x40300000`, `kernel_addr_r=0x40400000`, `ramdisk_addr_r=0x44000000`.
  The standard boot (bootstd) EFI bootmeth finds `efi/boot/bootaa64.efi` on the virtio disk's ESP and runs it.
- Reset and poweroff go through PSCI (`CONFIG_SYSRESET_PSCI`), discovered from the DT `/psci` `method`.

**Prebuilt `u-boot.bin` sources:**

| Source | Path inside | Notes |
|---|---|---|
| **Alpine `u-boot-qemu-2026.04-r1.apk`** (`https://dl-cdn.alpinelinux.org/alpine/v3.24/main/aarch64/`) | `usr/share/u-boot/qemu_arm64/u-boot.bin` (1,453,944 bytes) | [V] apk sha256 `b87f1d7ab06549d123a0776f65ddd82a81ae91d9cc4b0aebf2ae811a17e1ccb0`. `u-boot.bin` sha256 `e0155e525781e6f781eb90a8dbd680c9ecb53b21081fffdc636c8a7da63f7f12`. Version string "U-Boot 2026.04 (Apr 21 2026)". Repo churn applies, so mirror a copy into `.cache` and pin. |
| Debian `u-boot-qemu` (trixie, `all`) | `/usr/lib/u-boot/qemu_arm64/u-boot.bin` (+ `uboot.elf`) | [V] from packages.debian.org filelist. A `.deb` is an `ar` archive with `data.tar.xz`; Python stdlib (`lzma` + `tarfile`) can extract it. Debian pool URLs are stable per version. |

### 3.2 FreeBSD arm64 VM images [V]

Base: `https://download.freebsd.org/releases/VM-IMAGES/<ver>/aarch64/Latest/`, with `CHECKSUM.SHA256` and
`CHECKSUM.SHA512` in the same directory. Available on 2026-11-18: 14.4, 14.5, 15.0, 15.1 RELEASE, and 15.2-BETA.

| Image | sha256 (from CHECKSUM.SHA256) |
|---|---|
| `FreeBSD-15.1-RELEASE-arm64-aarch64-ufs.raw.xz` (595 MB compressed) | `36028829cbd5a74a050d9964cd5fd391c9d12edca1c3d520cbcce257e1d999c8` |
| `FreeBSD-14.4-RELEASE-arm64-aarch64-ufs.raw.xz` | `9b28d7eab208dfd7dc8da53960875831784015a3b96c42494b0750e607812525` |
| (`-zfs`, `BASIC-CLOUDINIT-*`, `.qcow2.xz`, `.vhd.xz`, `.vmdk.xz` variants also exist) | |

Layout of 15.1 ufs.raw, parsed from the first 16 MB of the stream [V]:

- GPT, ~6.03 GiB disk.
- p1 **EFI System** "efiboot0": LBA 34, 32.5 MiB, FAT32, label `EFISYS`. Contains `EFI/BOOT/BOOTAA64.EFI`, which is FreeBSD's `loader.efi` [V for the path; U that it is byte-identical to loader.efi].
- p2 freebsd-swap: 1 GiB.
- p3 freebsd-ufs "rootfs": 5 GiB.

Decompress on the host with `xz -dc` (Homebrew xz present) or Python stdlib `lzma` (streaming). Verify the
`.xz` sha256 before decompressing. The disk is presented to the guest as **virtio-blk over virtio-mmio**.

Boot chain: U-Boot → EFI bootmeth → `BOOTAA64.EFI` (loader.efi) → reads `/boot/kernel/kernel` from UFS through EFI block I/O →
`ExitBootServices` → FreeBSD kernel with the DTB from the EFI config table. EFI runtime services stay resident in U-Boot.

### 3.3 What FreeBSD needs from the VMM

| Need | Detail |
|---|---|
| GICv3 | `arm,gic-v3` with GICD + GICR. **ITS optional**: virtio-mmio uses wired SPIs, and MSI/ITS only matters for PCIe [U]. |
| Generic timer | `arm,armv8-timer`. FreeBSD reads DT `clock-frequency` if present, otherwise `CNTFRQ_EL0` [V]. Selection [V]: VHE (EL2) → hyp phys timer. **No hyp (EL1 entry) → virtual timer**. Otherwise (EL2 non-VHE) → physical timers. So at EL1 under HVF it uses the vtimer, same as Linux. |
| PL011 | `arm,pl011` + `stdout-path`. loader.efi uses the U-Boot EFI console. |
| virtio-mmio blk | FreeBSD `virtio_mmio` accepts **Version 1 (legacy) and 2 (modern)**. For v2 it sets `FEATURES_OK` and fails if the device clears it. The ISR reads `InterruptStatus` and writes the same value to `InterruptACK` [V]. Use modern (v2) with `VIRTIO_F_VERSION_1`. |
| PSCI | `CPU_ON` for SMP. `SYSTEM_RESET`/`SYSTEM_OFF` via the EFI runtime `ResetSystem` (U-Boot → PSCI) or directly [U]. |
| RTC | FreeBSD prefers EFI runtime `GetTime`. U-Boot implements it only with a DM RTC driver; the Alpine binary contains `arm,pl031` [V string]. Whether FreeBSD has a native PL031 driver: [U]. Without an RTC the time is wrong, but boot still proceeds. |
| Memory | DT `memory` node. U-Boot adds EFI memory-map reservations for itself (runtime services) and the DTB. |

**Known and likely pitfalls**

1. **Flash at 0 must be executable memory.** Instruction fetch cannot practically be emulated through MMIO exits.
   So map the firmware image with `hv_vm_map(READ|EXEC)` and **no WRITE**. Guest writes then fault (data abort) to the VMM.
   - U-Boot's CFI driver (`cfi-flash` node) probes by writing CFI-query commands (`0x98` to offset `0x55`·width) and then
     *reading back the query table*. That only works if the region is switched from "array/ROM mode" to MMIO for that bank.
     This is what QEMU's `pflash_cfi01` "romd" mode does (unmap on command write, remap on read-array `0xFF`).
   - Options: (a) don't describe `flash@0` in the DT at all. U-Boot then runs with no MTD and the default env
     ("bad CRC, using default environment") [U: confirm U-Boot doesn't hang without the flash node]. (b) Implement a minimal
     CFI-01 state machine with romd unmap/remap. (a) is the right first step. (b) is needed for EDK2 variables.
2. **DTB at `0x4000_0000` must be fully populated** (memory, cpus, psci, timer, gic, uart+clock, rtc, virtio).
   U-Boot doesn't synthesize hardware. Leave space after the DTB; U-Boot relocates its own copy.
3. **GIC ITS absent:** fine for virtio-mmio. Don't emit an `msi-controller` child we don't implement. HVF has an
   MSI-frame config API (`hv_gic_config_set_msi_region_*`), which is GICv2m-like, not ITS [U].
4. **EL choice:** at EL2 both FreeBSD and Linux switch to the EL2 timers (see above). Stay at EL1 until EL2 is deliberate.
5. **`boot_targets` starts with `qfw` (fw_cfg).** Without a fw_cfg node it just skips that target [U].
6. **U-Boot 2026.04 enables TPM2-MMIO, SMBIOS, PCI ECAM, E1000, AHCI, NVMe** (from defconfig [S]). With no DT nodes for
   them they stay inert. The U-Boot mem_map still maps the PCIe ECAM/MMIO windows as Device memory, which is harmless if unbacked:
   accesses would fault to us [U].
7. U-Boot's own **PSCI usage**: `SYSRESET_PSCI` issues `SYSTEM_RESET` via the DT method. We must implement the SMCCC
   `PSCI_VERSION` / `PSCI_FEATURES` queries, and `SMCCC_VERSION` (`0x80000000`) returning a sane value or `NOT_SUPPORTED` (-1).
   Never ignore an unknown HVC silently.

### 3.4 EDK2 ArmVirtQemu alternative

Artifact (Alpine community/aarch64, [V]):
`aavmf-0.0.202605-r0.apk` (sha256 `1b02ca32f3b5b5bc51da39ce2308b5ff6c1d5a79e646215437fc25d8d157a805`) contains:

- `usr/share/AAVMF/QEMU_EFI.fd` (3 MiB)
- `QEMU_VARS.fd` (768 KiB)
- `AAVMF_CODE.fd` / `AAVMF_VARS.fd` (64 MiB each, pre-padded for QEMU pflash)

Debian `qemu-efi-aarch64` provides the same (`/usr/share/qemu-efi-aarch64/QEMU_EFI.fd`, `/usr/share/AAVMF/AAVMF_CODE.fd`) [U for exact paths].

Needs, compared with U-Boot:

- **pflash bank 0 at `0x0`** with the code (XIP, as above). **Bank 1 at `0x0400_0000`** is the variable store, and it needs a
  **working CFI-01 write/erase path** (NorFlashDxe). That makes pitfall 1(b) mandatory [S]. Whether ArmVirtQemu falls back
  to an emulated (RAM) variable store when bank 1 is unusable: [U]. Treat it as required.
- **DTB at `0x4000_0000`** (`PcdDeviceTreeInitialBaseAddress`), parsed by FdtClientDxe. Same DT as above [S].
- **PL031 RTC** (ArmVirtPkg's PL031 lib finds `arm,pl031` from the DT), the generic timer (PPIs from the DT), GICv3,
  and PL011 (`stdout-path`), plus virtio-mmio (VirtioFdtDxe) [S].
- **fw_cfg** (`qemu,fw-cfg-mmio` at `0x0902_0000`, size `0x18`) is used for kernel/initrd loading, boot order and ACPI tables.
  Without it, EDK2 uses the DT, boots from the disk ESP, and has no ACPI [U: likely OK on RELEASE builds; DEBUG builds may assert].
- PSCI via DT `method` for reset and poweroff (ArmVirtPsciResetSystemLib) [S].
- Field evidence: UTM and QEMU `-accel hvf` run EDK2 on Apple Silicon routinely. Nothing here is fundamentally
  HVF-hostile [U for our implementation].

---

## 4. What each guest needs from the VMM

| Item | Linux direct boot | FreeBSD via U-Boot | EDK2 (any OS) |
|---|---|---|---|
| Entry | PC = Image base, x0 = DTB, x1-x3 = 0, EL1h DAIF masked | PC = `0x0` (flash), registers don't matter | PC = `0x0` (flash) |
| Kernel or firmware prep | zboot unwrap + gunzip on host, header validation | `u-boot.bin` into flash bank 0 | `QEMU_EFI.fd` into bank 0, vars into bank 1 |
| DTB | at `0x4000_0000` (or anywhere 8-aligned, ≤2 MiB), with `/chosen` bootargs + initrd | **must** be at `0x4000_0000`; bootargs ignored | **must** be at `0x4000_0000` |
| Flash `0x0` | not needed | RX memory mapping. CFI optional (omit `flash@0` at first) | RX code mapping + **CFI-01 write/erase for vars** |
| GICv3 (HVF in-kernel) | required | required | required |
| Generic timer (vtimer @ EL1) | required (PPI 11 / INTID 27) | required (same) | required |
| PSCI over HVC | CPU_ON (SMP), SYSTEM_OFF/RESET, VERSION, FEATURES | same + U-Boot sysreset | same |
| PL011 + ID regs + fixed-clock DT | required (console) | required | required |
| PL031 RTC | optional (built in, nice for time) | U-Boot EFI GetTime [U] | required [S] |
| virtio-mmio | optional (`.ko` in initramfs; needed for blk) | **required** (disk) | **required** (disk) |
| fw_cfg | no | no (qfw target skipped) | optional [U] |
| Artifacts (pinned) | Alpine 3.24.4 `vmlinuz-virt`, `initramfs-virt` | Alpine `u-boot-qemu` u-boot.bin + FreeBSD 15.1 `ufs.raw.xz` | Alpine `aavmf` + FreeBSD/Debian raw disk |

## 5. Open questions to settle on hardware

1. HVF vCPU reset state: confirm `SCTLR_EL1.M=0`, the `CNTFRQ_EL0` value on M5, and that `ICC_SRE_EL1.SRE=1` with `hv_gic_create`.
2. Redistributor size and alignment requirements from `hv_gic_get_redistributor_size()` / region base alignment. Check the headers.
3. Does U-Boot 2026.04 `qemu_arm64` boot cleanly with **no** `flash@0` node, and with the flash mapped RX and writes ignored?
4. Does Alpine's kernel pick up SVE/SME/MTE as advertised by HVF on M5, and does it need anything extra (e.g. SME traps)?
5. Earlycon access width on PL011 (8-bit vs 32-bit). The MMIO decoder must support both.
