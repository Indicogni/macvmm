# U-Boot `qemu_arm64` on macvmm: compatibility record (PLAN M18)

What stock U-Boot does on macvmm's `virt` machine, as **observed on the dev machine** (Apple M5 Pro,
macOS 27.2, 2026-11-19). Every claim below comes from a real run; the commands are given so it can
be repeated. Course chapter 21 and the U-Boot primer (`course/primers/u-boot.md`) point here.

| Item | Value |
|---|---|
| Firmware | U-Boot 2026.04 (Apr 21 2026), `qemu_arm64` build, from Alpine `u-boot-qemu-2026.04-r1.apk` |
| `u-boot.bin` | 1,453,944 bytes, sha256 `e0155e525781e6f781eb90a8dbd680c9ecb53b21081fffdc636c8a7da63f7f12` (`scripts/fetch.sh uboot`; derived by `cargo xtask derive extract-apk`, pinned) |
| Command | `macvmm run --bios .cache/macvmm/u-boot.bin --mem 512M [--disk D] [--on-reset exit]` |
| Tests | `scripts/test-e2e.sh firmware`: `uboot_prompt`, `uboot_reset`, `uboot_no_disk`, `uboot_autoboot_dsr` (all pass) |

## 1. Which PLAN M18 path was taken

**Path 1: no `flash@0` DT node, writes ignored.** The CFI-01 state machine (path 2) was **not**
built: U-Boot neither hangs nor aborts without it. Two things *were* needed that the plan did not
list, both found by running U-Boot and reading the VMM's own diagnostics:

1. **The ISV = 0 instruction fetch from flash** (the "Known risk" PLAN M18 recorded after M17). The
   very first stores U-Boot makes are two `STP` pairs executed *in place from flash*:
   `save_boot_params` (`board/emulation/qemu-arm/lowlevel_init.S`) saves `x0..x3` into its own
   `.data`, which is inside the image at `0x12c668`. A pair store has no syndrome (ISV = 0), so the
   VMM must read the instruction, and before M18 it could read instructions only through
   `GuestMemory` (RAM). Observed before the fix:
   `ISV=0 write at 0x12c668 pc 0x17c not emulated (pc 0x17c translates to 0x17c, outside RAM):
   injecting a synchronous external abort`, after which U-Boot ran off into its (not yet set up)
   vectors. Fix: `arch::stage1_walk::fetch_insn_rom` asks a read-only `InsnRom` hook
   (`RomRegion::read_u32`: aligned, bounds-checked) when the PC's IPA is not RAM. `GuestMemory`
   was not widened, so DMA still cannot reach the ROM (`rom_unreachable_by_dma`).
2. **Flash bank 1 must be readable.** U-Boot keeps its environment in flash
   (`CONFIG_ENV_IS_IN_FLASH`, `ENV_ADDR = 0x0400_0000`, `ENV_SIZE = 0x40000`) and `env_flash`
   reads it **memory-mapped**, byte by byte for the CRC, whether or not the CFI driver found a
   flash device. With bank 1 unmapped the boot stopped at once:
   `guest fatal: unhandled MMIO read at 0x4000004 size 1 pc 0xe44`. Fix: both banks are one
   128 MiB `RomRegion` mapped READ+EXEC; bank 1 is all zero, so the CRC fails and U-Boot prints
   `*** Warning - bad CRC, using default environment`, exactly as on a fresh QEMU machine.

A third fix was in the virtio-mmio transport (section 5).

## 2. The boot as seen on the serial console

```text
Bloblist at 0 not found (err=-2)
alloc space exhausted ptr 400 limit 0
Bloblist at 0 not found (err=-2)

U-Boot 2026.04 (Apr 21 2026 - 09:17:42 +0000)

DRAM:  512 MiB
using memory 0x5e65a000-0x5f69a000 for malloc()
Core:  15 devices, 9 uclasses, devicetree: board
Flash: 0 Bytes
Loading Environment from Flash... *** Warning - bad CRC, using default environment

In:    serial,usbkbd
Out:   serial,vidconsole
Err:   serial,vidconsole
No USB controllers found
Net:   No ethernet found.
Hit any key to stop autoboot: 2
=> virtio scan; virtio info
Device 0: MMVM VirtIO Block Device
            Type: Hard Disk
            Capacity: 16.0 MB = 0.0 GB (32768 x 512)
=> poweroff
poweroff ...
```

- The three lines before the banner are harmless; the U-Boot primer notes they appear under QEMU
  too (a hand-off area for earlier boot stages this machine does not have).
- `Flash: 0 Bytes`: no `flash@0` node, so the CFI driver finds nothing. `saveenv` therefore fails
  instead of writing; nothing persists across boots (writes would be ignored anyway, MMIO-10).
- `devicetree: board`: U-Boot uses our generated DTB from the start of RAM as its control tree
  (it also received `x0` = `0x4000_0000`; it saves it in `save_boot_params`, the ignored write of
  `0x40000000` below).
- Time to the `Hit any key` line: about 10 ms after the process starts (measured with
  timestamps on the stdout pipe).
- Letting the countdown expire: `Scanning for bootflows in all bootdevs`, the `efi_mgr` bootmeth
  (`Cannot persist EFI variables without system partition`, `Missing TPMv2 device`, `Missing RNG
  device`), `No more bootdevs`, then the bootflow count and the prompt. `qfw` (fw_cfg) is
  skipped silently. With an empty 16 MiB `--disk` the count is `(1 bootflow, 1 valid)`: the
  `efi_mgr` bootflow is tried and fails (`Loading Boot0000 'virtio 0' failed`, `Boot failed
  (err=-14)`); `uboot_autoboot_dsr` runs exactly this.

## 3. What the VMM saw (exit trace)

Run: `--trace exits:F:all`, a full boot, the countdown expiring, `virtio scan; virtio info`,
`reset` (about 4.5 s of guest time).

| Exit class | Count | Notes |
|---|---|---|
| Data abort (EC 0x24) | 794,225 | 792,553 PL011 reads: U-Boot polls `UARTFR` in a busy loop while it waits for a key (no WFI in its console loop). 1,624 PL011 writes, 45 virtio-mmio accesses, 3 flash writes |
| HVC (EC 0x16) | 3 | `PSCI_VERSION`, `PSCI_FEATURES`, `PSCI_SYSTEM_RESET` |
| System-register traps (EC 0x18) | **0** | U-Boot at EL1 touches nothing HVF traps |
| Unknown SMCCC calls | **0** | |
| ISV = 0 data aborts | **2** | the two `STP x0,x1` / `STP x2,x3` of `save_boot_params` at pc `0x17c`, `0x180` (into flash); emulated as four 8-byte writes, each ignored |

The PL011 polling keeps one host core busy at the prompt: `--stats` for 3.4 s spent mostly
idle at `=> ` reported `host cpu 3.411 s over 3.412 s wall (100%)`, `wfx 0`, 2,123,964 data
aborts. It is U-Boot's design (a polling console with no WFI), not a VMM bug; Linux, by
contrast, idles in WFI.

## 4. Flash writes (MMIO-10)

Every boot logs exactly these (rate-limited `guest_warn!`, the first ten per call site, then one in
1000):

```text
flash: ignored 8-byte write of 0x40000000 at offset 0x12c668 (flash is read-only, write 1 to this bank)
flash: ignored 8-byte write of 0x0 at offset 0x12c670 (... write 2 ...)
flash: ignored 8-byte write of 0x0 at offset 0x12c678 (... write 3 ...)
flash: ignored 8-byte write of 0x0 at offset 0x12c680 (... write 4 ...)
flash: ignored 4-byte write of 0x1 at offset 0xed4 (... write 5 ...)
```

Each bank has its own `FlashDevice`, so offsets and the write count are per bank; all five
writes go to bank 0. The first four are `save_boot_params` (above); the fifth is a pre-relocation flag in `.data`. On
QEMU the same stores go to `pflash_cfi01`, which treats them as unknown commands and drops them;
U-Boot does not depend on them (it re-reads its state after relocation to RAM).

`uboot_prompt` asserts the first line on stderr: only the VMM prints it, and it proves both the
ISV = 0 ROM fetch and the write-ignore path.

## 5. virtio-mmio: DRIVER without ACKNOWLEDGE

With the M11 transport as it was, `virtio scan; virtio info` printed nothing and stderr said
`virtio-mmio: Status 2 after 0 ignored: bits out of order`. The MMIO trace shows why:

1. at bind time U-Boot resets the slot and sets ACKNOWLEDGE (Status 0 → 1);
2. at `virtio scan` (driver probe) it writes Status **0** (a reset) and then Status **2**
   (DRIVER) without setting ACKNOWLEDGE again, then DriverFeatures, then FEATURES_OK.

The strict machine refused step 2, so FEATURES_OK never latched and U-Boot set FAILED. virtio 1.2
§3.1.1 says the driver *should* set ACKNOWLEDGE first, but ACKNOWLEDGE only means "the guest
found a virtio device" (§2.1) and gates nothing in the device, and QEMU accepts the sequence. So
the transport now takes a write that sets DRIVER as setting ACKNOWLEDGE too
(`virtio/mmio.rs`, `write_status`). The steps that commit to something keep their checks:
FEATURES_OK still requires DRIVER and `accepted ⊆ offered` + VERSION_1 (VQ-14, VQ-15), DRIVER_OK
still requires FEATURES_OK (`status_bits_only_in_order` covers both). After the change U-Boot
negotiates normally and reports `Device 0: MMVM VirtIO Block Device`, 32768 × 512 sectors.

## 6. Terminal-size query and the `safe` filter (risk R18)

U-Boot's EFI console probes the terminal size when the `efi_mgr` bootmeth starts:
`ESC 7`, `ESC [r`, `ESC [999;999H`, **`ESC [6n`** (DSR, "report cursor position"), `ESC 8`, and
waits for the reply. Observed:

- with the default `--serial stdio` (`safe`), the `ESC [6n` is **dropped** (TTY-3); the other
  four sequences pass (cursor save/restore and moves are not queries). Checked byte by byte with
  `od -c`; with `--serial stdio,raw` the `ESC [6n` is present;
- the cost is the wait for a reply that never comes: **100 ms** (from the `efi_mgr'` line to the
  `ESC 8`, measured on the stdout pipe: 100.1 ms and 100.1 ms in two `safe` runs, 100.1 ms with
  `raw` into a pipe, where nothing answers either). U-Boot then assumes 80×25;
- it happens only when autoboot runs the bootflow scan. `uboot_prompt`, `uboot_reset` and
  `uboot_no_disk` stop the countdown, so they never pay it (and so cannot show the filter at
  work). `uboot_autoboot_dsr` lets it expire under `safe` and asserts that stdout holds
  `ESC 7`, `ESC [r`, `ESC [999;999H`, `ESC 8` back to back, with the `ESC [6n` gone from between
  them. The control, by hand: the same boot with `--serial stdio,raw` has one `ESC [6n` on
  stdout, the `safe` run none (re-checked 2026-11-19 with `grep -c`). No test needs
  `--serial stdio,raw`; the default stays `safe`.

## 7. Reset and power-off

- `poweroff` → PSCI `SYSTEM_OFF` → exit code 0 (`uboot_prompt`, `uboot_no_disk`).
- `reset` → PSCI `SYSTEM_RESET` (U-Boot prints `resetting ...`) → exit code 4 with
  `--on-reset exit` (`uboot_reset`), or a fresh boot of U-Boot with the default `reboot`.

## 8. Repeating these observations

```sh
scripts/fetch.sh uboot
cargo run -p macvmm -- run --bios .cache/macvmm/u-boot.bin --mem 512M          # interactive
cargo run -p macvmm -- run --bios .cache/macvmm/u-boot.bin --mem 512M \
    --trace exits:/tmp/uboot.jsonl:all --on-reset exit                          # then: reset
scripts/test-e2e.sh firmware
```
