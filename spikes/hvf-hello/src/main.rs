//! hvf-hello: a throwaway spike that proves Hypervisor.framework works on this Mac and pins down
//! the API behaviours the real VMM depends on. Each mode runs in its own process (see run.sh):
//!
//! * `info`   - host/framework capabilities (IPA sizes, EL2, granule, SME, max vCPUs).
//! * `basic`  - no GIC. Runs hand-encoded A64 code and decodes every exit kind we care about:
//!   HVC, MMIO write/read data aborts, SMC, MSR/MRS trap, WFI/WFE, stage-2 permission
//!   fault, VTIMER_ACTIVATED (+ auto-mask semantics), hv_vcpus_exit, instruction abort.
//! * `gic`    - in-kernel GICv3 at the QEMU-virt addresses. The guest programs GICD/GICR/ICC
//!   itself, arms the virtual timer, WFIs; we check how the timer PPI and a host-raised
//!   SPI reach it, and exercise GIC state save.
//! * `el2`    - VM with EL2 (nested virt) enabled; vCPU starts in EL2h.
//! * `align`  - hv_vm_map alignment / IPA-size / granule rules.
//! * `dump`   - print the encoded guest programs (consumed by check-encodings.sh).
//!
//! This spike intentionally lives outside the workspace and keeps `unsafe` everywhere; the real
//! crates quarantine it in `crates/hvf`.

mod enc;
mod ffi;

use core::ffi::c_void;
use enc::*;
use ffi::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const RAM_BASE: u64 = 0x4000_0000;
const PL011_BASE: u64 = 0x0900_0000;
const GICD_BASE: u64 = 0x0800_0000;
const GICR_BASE: u64 = 0x080A_0000;
const GIC_MSI_BASE: u64 = 0x0802_0000; // QEMU virt GICv2m frame
const QEMU_GICR_REGION_SIZE: u64 = 0x00F6_0000; // QEMU virt VIRT_GIC_REDIST size
const SPI_UART: u32 = 33; // QEMU virt: UART is SPI 1 -> INTID 32 + 1
/// EL1h with D, A, I, F all masked.
const CPSR_EL1H_MASKED: u64 = 0x3c5;
/// EL2h with D, A, I, F all masked.
const CPSR_EL2H_MASKED: u64 = 0x3c9;

// ---------------------------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------------------------

fn rs(r: hv_return_t) -> String {
    format!("{} ({:#010x})", ret_name(r), r as u32)
}

fn ck(what: &str, r: hv_return_t) -> hv_return_t {
    println!("  {what:<58} -> {}", rs(r));
    r
}

fn must(what: &str, r: hv_return_t) {
    if r != HV_SUCCESS {
        println!("FATAL: {what} -> {}", rs(r));
        std::process::exit(1);
    }
}

fn page_size() -> usize {
    unsafe { sysconf(_SC_PAGESIZE) as usize }
}

fn host_cntfrq() -> u64 {
    let v: u64;
    unsafe { core::arch::asm!("mrs {}, cntfrq_el0", out(reg) v) };
    v
}

fn get_reg(vcpu: hv_vcpu_t, r: hv_reg_t) -> u64 {
    let mut v = 0;
    must("hv_vcpu_get_reg", unsafe {
        hv_vcpu_get_reg(vcpu, r, &mut v)
    });
    v
}
fn set_reg(vcpu: hv_vcpu_t, r: hv_reg_t, v: u64) {
    must("hv_vcpu_set_reg", unsafe { hv_vcpu_set_reg(vcpu, r, v) });
}
fn get_sys(vcpu: hv_vcpu_t, r: hv_sys_reg_t) -> Result<u64, hv_return_t> {
    let mut v = 0;
    let rc = unsafe { hv_vcpu_get_sys_reg(vcpu, r, &mut v) };
    if rc == HV_SUCCESS { Ok(v) } else { Err(rc) }
}
fn set_sys(vcpu: hv_vcpu_t, r: hv_sys_reg_t, v: u64) {
    must("hv_vcpu_set_sys_reg", unsafe {
        hv_vcpu_set_sys_reg(vcpu, r, v)
    });
}
fn vtimer_masked(vcpu: hv_vcpu_t) -> bool {
    let mut m = false;
    must("hv_vcpu_get_vtimer_mask", unsafe {
        hv_vcpu_get_vtimer_mask(vcpu, &mut m)
    });
    m
}
fn advance_pc(vcpu: hv_vcpu_t) {
    let pc = get_reg(vcpu, HV_REG_PC);
    set_reg(vcpu, HV_REG_PC, pc + 4);
}

/// Guest RAM: host memory from hv_vm_allocate, mapped at `ipa`.
struct Ram {
    host: *mut u8,
    size: usize,
}
impl Ram {
    fn alloc(size: usize) -> Ram {
        let mut p: *mut c_void = core::ptr::null_mut();
        must("hv_vm_allocate", unsafe { hv_vm_allocate(&mut p, size, 0) });
        Ram {
            host: p as *mut u8,
            size,
        }
    }
    fn write(&self, off: usize, bytes: &[u8]) {
        assert!(off + bytes.len() <= self.size);
        unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), self.host.add(off), bytes.len()) };
    }
    fn at(&self, off: usize) -> *mut c_void {
        unsafe { self.host.add(off) as *mut c_void }
    }
}

/// A watchdog thread that kicks the vCPU out of hv_vcpu_run via hv_vcpus_exit (from a
/// *different* thread - this is exactly how the real VMM will interrupt a running vCPU).
struct Watchdog {
    deadline: Arc<Mutex<Option<Instant>>>,
    fired: Arc<AtomicU64>,
}
impl Watchdog {
    fn new(vcpu: hv_vcpu_t) -> Watchdog {
        let deadline: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let fired = Arc::new(AtomicU64::new(0));
        let (d, f) = (deadline.clone(), fired.clone());
        std::thread::spawn(move || {
            loop {
                std::thread::sleep(Duration::from_millis(2));
                let mut g = d.lock().unwrap();
                if let Some(t) = *g
                    && Instant::now() >= t
                {
                    *g = None;
                    let mut v = vcpu;
                    let rc = unsafe { hv_vcpus_exit(&mut v, 1) };
                    f.fetch_add(1, Ordering::SeqCst);
                    if rc != HV_SUCCESS {
                        println!("  [watchdog] hv_vcpus_exit -> {}", rs(rc));
                    }
                }
            }
        });
        Watchdog { deadline, fired }
    }
    fn arm(&self, ms: u64) {
        *self.deadline.lock().unwrap() = Some(Instant::now() + Duration::from_millis(ms));
    }
    fn disarm(&self) {
        *self.deadline.lock().unwrap() = None;
    }
}

fn run(
    vcpu: hv_vcpu_t,
    exit: *const hv_vcpu_exit_t,
    wd: &Watchdog,
    ms: u64,
) -> (hv_vcpu_exit_t, Duration) {
    wd.arm(ms);
    let t0 = Instant::now();
    let rc = unsafe { hv_vcpu_run(vcpu) };
    let dt = t0.elapsed();
    wd.disarm();
    must("hv_vcpu_run", rc);
    // SAFETY(spike): the framework owns *exit and rewrites it on every hv_vcpu_run.
    (unsafe { core::ptr::read_volatile(exit) }, dt)
}

fn reason_name(r: u32) -> &'static str {
    match r {
        HV_EXIT_REASON_CANCELED => "CANCELED",
        HV_EXIT_REASON_EXCEPTION => "EXCEPTION",
        HV_EXIT_REASON_VTIMER_ACTIVATED => "VTIMER_ACTIVATED",
        _ => "UNKNOWN",
    }
}

fn ec_name(ec: u64) -> &'static str {
    match ec {
        0x00 => "Unknown reason",
        0x01 => "WFI/WFE",
        0x07 => "SVE/SIMD/FP access",
        0x0e => "Illegal execution state",
        0x15 => "SVC (AArch64)",
        0x16 => "HVC (AArch64)",
        0x17 => "SMC (AArch64)",
        0x18 => "MSR/MRS/System instruction trap",
        0x20 => "Instruction Abort from lower EL",
        0x21 => "Instruction Abort from same EL",
        0x22 => "PC alignment fault",
        0x24 => "Data Abort from lower EL",
        0x25 => "Data Abort from same EL",
        0x3c => "BRK",
        _ => "?",
    }
}

/// Pretty-print an ESR_EL2 value as reported in hv_vcpu_exit_t.exception.syndrome.
fn decode(ex: &hv_vcpu_exit_exception_t) -> String {
    let esr = ex.syndrome;
    let ec = (esr >> 26) & 0x3f;
    let il = (esr >> 25) & 1;
    let iss = esr & 0x1ff_ffff;
    let mut s = format!(
        "ESR={esr:#010x} EC={ec:#04x} ({}) IL={il} ISS={iss:#09x} FAR(VA)={:#x} IPA={:#x}",
        ec_name(ec),
        ex.virtual_address,
        ex.physical_address
    );
    match ec {
        0x16 | 0x17 => s += &format!("\n      imm16={:#x}", iss & 0xffff),
        0x01 => {
            s += &format!(
                "\n      TI={} ({})",
                iss & 3,
                ["WFI", "WFE", "WFIT", "WFET"][(iss & 3) as usize]
            )
        }
        0x18 => {
            let op0 = (iss >> 20) & 3;
            let op2 = (iss >> 17) & 7;
            let op1 = (iss >> 14) & 7;
            let crn = (iss >> 10) & 0xf;
            let rt = (iss >> 5) & 0x1f;
            let crm = (iss >> 1) & 0xf;
            let dir = iss & 1;
            let hvid = (op0 << 14) | (op1 << 11) | (crn << 7) | (crm << 3) | op2;
            s += &format!(
                "\n      op0={op0} op1={op1} CRn={crn} CRm={crm} op2={op2} Rt=x{rt} dir={} -> hv_sys_reg_t {hvid:#06x}",
                if dir == 1 { "read(MRS)" } else { "write(MSR)" }
            );
        }
        0x24 | 0x20 => {
            let isv = (iss >> 24) & 1;
            let sas = (iss >> 22) & 3;
            let sse = (iss >> 21) & 1;
            let srt = (iss >> 16) & 0x1f;
            let sf = (iss >> 15) & 1;
            let ar = (iss >> 14) & 1;
            let fnv = (iss >> 10) & 1;
            let s1ptw = (iss >> 7) & 1;
            let wnr = (iss >> 6) & 1;
            let fsc = iss & 0x3f;
            let fsc_s = match fsc {
                0x04..=0x07 => "translation fault",
                0x08..=0x0b => "access flag fault",
                0x0c..=0x0f => "permission fault",
                _ => "other",
            };
            if ec == 0x24 {
                s += &format!(
                    "\n      ISV={isv} SAS={sas} ({}B) SSE={sse} SRT=x{srt} SF={sf} AR={ar} FnV={fnv} S1PTW={s1ptw} WnR={wnr} ({}) DFSC={fsc:#04x} ({fsc_s}, level {})",
                    1 << sas,
                    if wnr == 1 { "write" } else { "read" },
                    fsc & 3
                );
            } else {
                s += &format!("\n      IFSC={fsc:#04x} ({fsc_s}, level {})", fsc & 3);
            }
        }
        _ => {}
    }
    s
}

// ---------------------------------------------------------------------------------------------
// info
// ---------------------------------------------------------------------------------------------

fn info() {
    println!("== info: host + framework capabilities ==");
    println!(
        "  host page size (sysconf)                                   = {:#x}",
        page_size()
    );
    println!(
        "  host CNTFRQ_EL0                                            = {} Hz",
        host_cntfrq()
    );
    unsafe {
        let mut n = 0u32;
        ck("hv_vm_get_max_vcpu_count", hv_vm_get_max_vcpu_count(&mut n));
        println!("    max vCPUs = {n}");
        let (mut max, mut def) = (0u32, 0u32);
        ck(
            "hv_vm_config_get_max_ipa_size",
            hv_vm_config_get_max_ipa_size(&mut max),
        );
        ck(
            "hv_vm_config_get_default_ipa_size",
            hv_vm_config_get_default_ipa_size(&mut def),
        );
        println!(
            "    max IPA = {max} bits ({} GiB), default IPA = {def} bits ({} GiB)",
            (1u64 << max) >> 30,
            (1u64 << def) >> 30
        );
        let mut el2 = false;
        ck(
            "hv_vm_config_get_el2_supported",
            hv_vm_config_get_el2_supported(&mut el2),
        );
        println!("    EL2 (nested virt) supported = {el2}");
        let mut g = 99u32;
        ck(
            "hv_vm_config_get_default_ipa_granule",
            hv_vm_config_get_default_ipa_granule(&mut g),
        );
        println!(
            "    default IPA granule = {g} ({})",
            match g {
                0 => "4KB",
                1 => "16KB",
                _ => "?",
            }
        );
        let mut svl = 0usize;
        let rc = ck(
            "hv_sme_config_get_max_svl_bytes",
            hv_sme_config_get_max_svl_bytes(&mut svl),
        );
        if rc == HV_SUCCESS {
            println!("    SME max SVL = {svl} bytes ({} bits)", svl * 8);
        }
        let c = hv_vm_config_create();
        let mut cur = 0u32;
        ck(
            "hv_vm_config_get_ipa_size(fresh config)",
            hv_vm_config_get_ipa_size(c, &mut cur),
        );
        println!("    fresh config IPA size = {cur}");
        let mut gg = 99u32;
        ck(
            "hv_vm_config_get_ipa_granule(fresh config)",
            hv_vm_config_get_ipa_granule(c, &mut gg),
        );
        println!("    fresh config granule = {gg}");
        let mut e = true;
        ck(
            "hv_vm_config_get_el2_enabled(fresh config)",
            hv_vm_config_get_el2_enabled(c, &mut e),
        );
        println!("    fresh config el2_enabled = {e}");
        ck(
            "hv_vm_config_set_ipa_size(max+1) [expect error]",
            hv_vm_config_set_ipa_size(c, max + 1),
        );
        os_release(c);

        // vCPU feature registers (no VM needed for the config object)
        let vc = hv_vcpu_config_create();
        let names = [
            "ID_AA64DFR0_EL1",
            "ID_AA64DFR1_EL1",
            "ID_AA64ISAR0_EL1",
            "ID_AA64ISAR1_EL1",
            "ID_AA64MMFR0_EL1",
            "ID_AA64MMFR1_EL1",
            "ID_AA64MMFR2_EL1",
            "ID_AA64PFR0_EL1",
            "ID_AA64PFR1_EL1",
            "CTR_EL0",
            "CLIDR_EL1",
            "DCZID_EL0",
            "ID_AA64SMFR0_EL1",
            "ID_AA64ZFR0_EL1",
        ];
        for (i, n) in names.iter().enumerate() {
            let mut v = 0u64;
            let rc = hv_vcpu_config_get_feature_reg(vc, i as u32, &mut v);
            println!("    feature {n:<18} = {v:#018x} [{}]", ret_name(rc));
            if *n == "ID_AA64MMFR0_EL1" {
                let pa = v & 0xf;
                let pa_bits = [32, 36, 40, 42, 44, 48, 52, 56]
                    .get(pa as usize)
                    .copied()
                    .unwrap_or(0);
                println!(
                    "      PARange={pa} ({pa_bits} bits) TGran16={:#x} TGran64={:#x} TGran4={:#x} (TGran4/64: 0=supported, 0xf=not; TGran16: 0=not, >=1 supported)",
                    (v >> 20) & 0xf,
                    (v >> 24) & 0xf,
                    (v >> 28) & 0xf
                );
            }
            if *n == "ID_AA64PFR0_EL1" {
                println!(
                    "      EL0={:#x} EL1={:#x} EL2={:#x} EL3={:#x} GIC={:#x} SVE={:#x}",
                    v & 0xf,
                    (v >> 4) & 0xf,
                    (v >> 8) & 0xf,
                    (v >> 12) & 0xf,
                    (v >> 24) & 0xf,
                    (v >> 32) & 0xf
                );
            }
        }
        os_release(vc);
    }
}

// ---------------------------------------------------------------------------------------------
// basic: exits without a GIC
// ---------------------------------------------------------------------------------------------

struct BasicProg {
    asm: Asm,
    spin: u64,
    after_spin: u64,
}

fn basic_program() -> BasicProg {
    let mut a = Asm::new(RAM_BASE);
    a.movz(0, 42, 0);
    a.hvc(0x1); // #1: x0 should be 42; observe PC
    a.movz(1, 0x41, 0);
    a.movz(2, (PL011_BASE >> 16) as u32, 1);
    a.str_w(1, 2, 0); // MMIO write to unmapped UARTDR
    a.ldr_w(3, 2, 0x18); // MMIO read from unmapped UARTFR
    a.hvc(0x2); // #2: x3 should hold the value we injected
    a.stp_x(1, 3, 2); // pair store to MMIO: no single Rt, so ISV must be 0
    a.smc(0x3);
    a.mrs(4, PMCR_EL0); // PMU access with EL2 disabled -> trap
    a.wfi();
    a.wfe(); // ERET into the guest sets the event register, so the 1st WFE completes...
    a.wfe(); // ...and only the 2nd one would actually wait (and so can trap)
    a.movz(5, 0x4000, 1);
    a.movk(5, 0x4000, 0); // x5 = 0x4000_4000 (read-only page)
    a.str_x(0, 5, 0); // write to a READ-only stage-2 mapping
    a.movk(5, 0x8000, 0); // x5 = 0x4000_8000 (RW page)
    a.str_x(0, 5, 0); // succeeds silently
    a.hvc(0x4); // #4: host write-protects the RW page (dirty-tracking pattern)
    a.str_x(0, 5, 8); // faults; host re-enables write and re-executes (no PC advance)
    a.hvc(0x5); // #5: host checks the retried store landed
    a.mrs(6, CNTVCT_EL0);
    a.mrs(7, CNTFRQ_EL0);
    a.hvc(0x3); // #3: report counter + frequency
    a.add_lsr(6, 6, 7, 6); // cval = now + freq/64 (~15.6 ms)
    a.msr(CNTV_CVAL_EL0, 6);
    a.movz(9, 1, 0);
    a.msr(CNTV_CTL_EL0, 9); // ENABLE=1, IMASK=0
    a.isb();
    let spin = a.here();
    a.b(spin);
    let after_spin = a.here();
    a.movz(10, 0x1000, 1);
    a.br(10); // jump to unmapped IPA 0x1000_0000 -> instruction abort
    BasicProg {
        asm: a,
        spin,
        after_spin,
    }
}

fn basic() {
    println!("== basic: VM without GIC ==");
    let prog = basic_program();
    let ps = page_size();
    unsafe {
        let mut max = 0u32;
        hv_vm_config_get_max_ipa_size(&mut max);
        let cfg = hv_vm_config_create();
        ck(
            "hv_vm_config_set_ipa_size(40)",
            hv_vm_config_set_ipa_size(cfg, 40.min(max)),
        );
        must(
            "hv_vm_create(config)",
            ck("hv_vm_create(config)", hv_vm_create(cfg)),
        );
        os_release(cfg);
        ck(
            "hv_vm_create again [expect error]",
            hv_vm_create(core::ptr::null_mut()),
        );
    }
    // 4 host pages: [0] code RWX, [1] read-only, [2..] RW
    let ram = Ram::alloc(4 * ps);
    ram.write(0, &prog.asm.bytes());
    unsafe {
        must(
            "map code",
            ck(
                "hv_vm_map(code page, RWX)",
                hv_vm_map(
                    ram.at(0),
                    RAM_BASE,
                    ps,
                    HV_MEMORY_READ | HV_MEMORY_WRITE | HV_MEMORY_EXEC,
                ),
            ),
        );
        must(
            "map ro",
            ck(
                "hv_vm_map(page 1, READ only)",
                hv_vm_map(ram.at(ps), RAM_BASE + ps as u64, ps, HV_MEMORY_READ),
            ),
        );
        must(
            "map rw",
            ck(
                "hv_vm_map(pages 2-3, RW)",
                hv_vm_map(
                    ram.at(2 * ps),
                    RAM_BASE + 2 * ps as u64,
                    2 * ps,
                    HV_MEMORY_READ | HV_MEMORY_WRITE,
                ),
            ),
        );
        ck(
            "hv_vm_map(overlapping page 0) [expect error]",
            hv_vm_map(ram.at(0), RAM_BASE, ps, HV_MEMORY_READ),
        );
    }

    let mut vcpu: hv_vcpu_t = 0;
    let mut exit: *mut hv_vcpu_exit_t = core::ptr::null_mut();
    unsafe {
        must(
            "hv_vcpu_create",
            ck(
                "hv_vcpu_create",
                hv_vcpu_create(&mut vcpu, &mut exit, core::ptr::null_mut()),
            ),
        );
        println!("    vcpu id = {vcpu}, exit struct at {exit:p}");
        let (mut v2, mut e2) = (0u64, core::ptr::null_mut());
        ck(
            "hv_vcpu_create 2nd on same thread [expect error]",
            hv_vcpu_create(&mut v2, &mut e2, core::ptr::null_mut()),
        );
    }
    println!("  -- default vCPU state --");
    println!(
        "    PC={:#x} CPSR={:#x}",
        get_reg(vcpu, HV_REG_PC),
        get_reg(vcpu, HV_REG_CPSR)
    );
    for (n, r) in [
        ("MIDR_EL1", HV_SYS_REG_MIDR_EL1),
        ("MPIDR_EL1", HV_SYS_REG_MPIDR_EL1),
        ("SCTLR_EL1", HV_SYS_REG_SCTLR_EL1),
        ("ID_AA64PFR0_EL1", HV_SYS_REG_ID_AA64PFR0_EL1),
        ("ID_AA64MMFR0_EL1", HV_SYS_REG_ID_AA64MMFR0_EL1),
        ("ID_AA64DFR0_EL1", HV_SYS_REG_ID_AA64DFR0_EL1),
        ("CNTV_CTL_EL0", HV_SYS_REG_CNTV_CTL_EL0),
        ("CNTP_CTL_EL0 (needs GIC)", HV_SYS_REG_CNTP_CTL_EL0),
        ("HCR_EL2 (needs EL2)", HV_SYS_REG_HCR_EL2),
    ] {
        match get_sys(vcpu, r) {
            Ok(v) => println!("    {n:<26} = {v:#018x}"),
            Err(e) => println!("    {n:<26} -> {}", rs(e)),
        }
    }
    unsafe {
        let mut off = 0u64;
        ck(
            "hv_vcpu_get_vtimer_offset",
            hv_vcpu_get_vtimer_offset(vcpu, &mut off),
        );
        let now = mach_absolute_time();
        println!("    vtimer offset = {off:#x}  (mach_absolute_time now = {now:#x})");
        println!("    vtimer masked by default = {}", vtimer_masked(vcpu));
        let mut p = true;
        ck(
            "hv_vcpu_get_pending_interrupt(IRQ) [no GIC]",
            hv_vcpu_get_pending_interrupt(vcpu, HV_INTERRUPT_TYPE_IRQ, &mut p),
        );
        let mut t = 0u64;
        ck(
            "hv_vcpu_get_wait_for_interrupt_time [no GIC, expect UNSUPPORTED]",
            hv_vcpu_get_wait_for_interrupt_time(vcpu, &mut t),
        );

        // SIMD register by-value ABI check (uint8x16_t in v0).
        let bytes: [u8; 16] = core::array::from_fn(|i| 0x10 + i as u8);
        let v: core::arch::aarch64::uint8x16_t = core::mem::transmute(bytes);
        ck(
            "hv_vcpu_set_simd_fp_reg(Q5, 10..1f)",
            set_simd_fp_reg(vcpu, 5, v),
        );
        let mut ob = [0u8; 16];
        ck(
            "hv_vcpu_get_simd_fp_reg(Q5)",
            hv_vcpu_get_simd_fp_reg(vcpu, 5, &mut ob),
        );
        println!("    Q5 roundtrip ok = {} ({:02x?})", ob == bytes, ob);
    }
    // Cross-thread access to the vCPU.
    let rc = std::thread::spawn(move || {
        let mut v = 0;
        unsafe { hv_vcpu_get_reg(vcpu, HV_REG_PC, &mut v) }
    })
    .join()
    .unwrap();
    println!(
        "  hv_vcpu_get_reg from a non-owning thread                   -> {}",
        rs(rc)
    );

    let wd = Watchdog::new(vcpu);

    // hv_vcpus_exit before run is "sticky": the next run returns immediately.
    unsafe {
        let mut v = vcpu;
        ck(
            "hv_vcpus_exit(self) before hv_vcpu_run",
            hv_vcpus_exit(&mut v, 1),
        );
    }
    let (e, dt) = run(vcpu, exit, &wd, 2000);
    println!(
        "  first run after pre-exit: reason={} in {dt:?}",
        reason_name(e.reason)
    );

    set_reg(vcpu, HV_REG_PC, RAM_BASE);
    set_reg(vcpu, HV_REG_CPSR, CPSR_EL1H_MASKED);
    println!(
        "  -- running guest at {RAM_BASE:#x}, CPSR={CPSR_EL1H_MASKED:#x} (EL1h, DAIF masked) --"
    );

    let mut timer_stage = 0;
    let mut t_hvc3 = Instant::now();
    let mut n = 0;
    loop {
        n += 1;
        if n > 40 {
            println!("  too many exits, stopping");
            break;
        }
        let (e, dt) = run(vcpu, exit, &wd, 300);
        let pc = get_reg(vcpu, HV_REG_PC);
        println!(
            "\n  exit #{n}: reason={} after {dt:?}, PC={pc:#x}",
            reason_name(e.reason)
        );
        match e.reason {
            HV_EXIT_REASON_EXCEPTION => {
                println!("    {}", decode(&e.exception));
                let esr = e.exception.syndrome;
                let ec = (esr >> 26) & 0x3f;
                let iss = esr & 0x1ff_ffff;
                match ec {
                    0x16 => {
                        let imm = iss & 0xffff;
                        println!(
                            "    HVC: PC already points past the HVC? {} (PC-4={:#x})",
                            pc != e.exception.virtual_address,
                            pc - 4
                        );
                        match imm {
                            1 => println!("    x0 = {}", get_reg(vcpu, 0)),
                            2 => println!(
                                "    x3 = {:#x} (we injected 0x90 for the UARTFR read)",
                                get_reg(vcpu, 3)
                            ),
                            4 => {
                                ck("hv_vm_protect(0x4000_8000, 16K, READ)", unsafe {
                                    hv_vm_protect(RAM_BASE + 2 * ps as u64, ps, HV_MEMORY_READ)
                                });
                            }
                            5 => {
                                let v = unsafe {
                                    core::ptr::read_volatile(ram.host.add(2 * ps + 8) as *const u64)
                                };
                                println!(
                                    "    host sees guest RAM[0x4000_8008] = {v} (42 => retried store landed)"
                                );
                            }
                            3 => {
                                let cnt = get_reg(vcpu, 6);
                                let frq = get_reg(vcpu, 7);
                                let mut off = 0;
                                unsafe { hv_vcpu_get_vtimer_offset(vcpu, &mut off) };
                                let host = unsafe { mach_absolute_time() };
                                println!(
                                    "    guest CNTVCT={cnt:#x} CNTFRQ={frq} ; host mach_absolute_time-offset={:#x} (delta {} ticks)",
                                    host - off,
                                    (host - off) as i64 - cnt as i64
                                );
                                t_hvc3 = Instant::now();
                            }
                            _ => {}
                        }
                    }
                    0x17 => {
                        println!("    SMC: PC == SMC instruction address? -> need PC+=4 if so");
                        advance_pc(vcpu);
                    }
                    0x18 => {
                        let rt = ((iss >> 5) & 0x1f) as u32;
                        if iss & 1 == 1 && rt != 31 {
                            set_reg(vcpu, HV_REG_X0 + rt, 0);
                        }
                        advance_pc(vcpu);
                    }
                    0x01 => advance_pc(vcpu),
                    0x24 => {
                        let isv = (iss >> 24) & 1 == 1;
                        let wnr = (iss >> 6) & 1 == 1;
                        let srt = ((iss >> 16) & 0x1f) as u32;
                        let sas = (iss >> 22) & 3;
                        let ipa = e.exception.physical_address;
                        if ipa >= RAM_BASE + 2 * ps as u64 && ipa < RAM_BASE + 3 * ps as u64 {
                            println!(
                                "    write to write-protected RAM page: mark dirty, hv_vm_protect back to RW, retry WITHOUT advancing PC"
                            );
                            ck("hv_vm_protect(0x4000_8000, 16K, RW)", unsafe {
                                hv_vm_protect(
                                    RAM_BASE + 2 * ps as u64,
                                    ps,
                                    HV_MEMORY_READ | HV_MEMORY_WRITE,
                                )
                            });
                            continue;
                        }
                        if isv && wnr {
                            let v = if srt == 31 {
                                0
                            } else {
                                get_reg(vcpu, HV_REG_X0 + srt)
                            };
                            let mask = if sas == 3 {
                                u64::MAX
                            } else {
                                (1u64 << (8 << sas)) - 1
                            };
                            println!(
                                "    MMIO WRITE {:#x} <- {:#x} ({}B)",
                                e.exception.physical_address,
                                v & mask,
                                1 << sas
                            );
                        } else if !isv {
                            println!(
                                "    ISV=0: syndrome has no register info; a VMM must fetch + decode the instruction at PC (or refuse)"
                            );
                        } else if isv {
                            println!(
                                "    MMIO READ  {:#x} -> inject 0x90 into x{srt}",
                                e.exception.physical_address
                            );
                            if srt != 31 {
                                set_reg(vcpu, HV_REG_X0 + srt, 0x90);
                            }
                        }
                        advance_pc(vcpu);
                    }
                    0x20 => {
                        println!("    instruction abort at unmapped IPA - end of basic program");
                        break;
                    }
                    _ => {
                        println!("    unexpected EC, stopping");
                        break;
                    }
                }
            }
            HV_EXIT_REASON_VTIMER_ACTIVATED => {
                let ctl = get_sys(vcpu, HV_SYS_REG_CNTV_CTL_EL0).unwrap();
                println!(
                    "    {:?} after arming; CNTV_CTL={ctl:#x} (ISTATUS={}); vtimer mask now = {} ; PC at spin? {}",
                    t_hvc3.elapsed(),
                    (ctl >> 2) & 1,
                    vtimer_masked(vcpu),
                    pc == prog.spin
                );
                match timer_stage {
                    0 => println!(
                        "    stage 0 -> re-run WITHOUT unmasking; expect no further VTIMER exit (watchdog CANCELED)"
                    ),
                    1 => {
                        println!(
                            "    stage 1 -> timer still pending after unmask => immediate re-exit (level semantics)"
                        );
                        println!("    now: CNTV_CTL=0 (disable), unmask, PC -> after_spin");
                        set_sys(vcpu, HV_SYS_REG_CNTV_CTL_EL0, 0);
                        unsafe { hv_vcpu_set_vtimer_mask(vcpu, false) };
                        set_reg(vcpu, HV_REG_PC, prog.after_spin);
                    }
                    _ => {}
                }
                timer_stage += 1;
            }
            HV_EXIT_REASON_CANCELED => {
                println!(
                    "    (watchdog hv_vcpus_exit from another thread; fired={})",
                    wd.fired.load(Ordering::SeqCst)
                );
                if timer_stage == 1 {
                    println!(
                        "    confirmed: masked vtimer did not re-exit. Unmasking with timer still firing..."
                    );
                    unsafe {
                        ck(
                            "hv_vcpu_set_vtimer_mask(false)",
                            hv_vcpu_set_vtimer_mask(vcpu, false),
                        )
                    };
                } else {
                    println!("    unexpected cancel, stopping");
                    break;
                }
            }
            _ => {
                println!("    unknown exit, stopping");
                break;
            }
        }
    }
    unsafe {
        let mut t = 0u64;
        hv_vcpu_get_exec_time(vcpu, &mut t);
        println!("\n  hv_vcpu_get_exec_time = {t} mach ticks");
        ck("hv_vcpu_destroy", hv_vcpu_destroy(vcpu));
        ck("hv_vm_unmap(all)", hv_vm_unmap(RAM_BASE, 4 * ps));
        ck("hv_vm_destroy", hv_vm_destroy());
        ck(
            "hv_vm_deallocate",
            hv_vm_deallocate(ram.host as *mut c_void, ram.size),
        );
        ck(
            "hv_vm_create after destroy (re-create in same process)",
            hv_vm_create(core::ptr::null_mut()),
        );
        ck("hv_vm_destroy", hv_vm_destroy());
    }
}

// ---------------------------------------------------------------------------------------------
// gic: in-kernel GICv3 + vtimer + SPI
// ---------------------------------------------------------------------------------------------

fn gic_program(redist: u64) -> Asm {
    let mut a = Asm::new(RAM_BASE);
    // --- main ---
    a.movz(1, (GICD_BASE >> 16) as u32, 1);
    a.movz(2, 0x13, 0); // GICD_CTLR: ARE_NS(4) | EnableGrp1A(1) | EnableGrp1(0)
    a.str_w(2, 1, 0x0);
    a.movz(2, 1 << (SPI_UART - 32), 0);
    a.str_w(2, 1, 0x84); // GICD_IGROUPR1: SPI 33 -> group 1
    a.str_w(2, 1, 0x104); // GICD_ISENABLER1: enable SPI 33
    a.str_x(31, 1, 0x6000 + 8 * SPI_UART); // GICD_IROUTER33 = Aff 0.0.0.0
    a.mov32(3, redist as u32); // RD_base for vCPU 0
    a.str_w(31, 3, 0x14); // GICR_WAKER = 0 (clear ProcessorSleep)
    a.mov32(4, (redist + 0x10000) as u32); // SGI_base
    a.mov32(2, 0xffff_ffff);
    a.str_w(2, 4, 0x80); // GICR_IGROUPR0: all SGIs/PPIs group 1
    a.mov32(2, 1 << 27);
    a.str_w(2, 4, 0x100); // GICR_ISENABLER0: enable PPI 27 (EL1 virtual timer)
    a.movz(2, 0xff, 0);
    a.msr(ICC_PMR_EL1, 2);
    a.movz(2, 1, 0);
    a.msr(ICC_IGRPEN1_EL1, 2);
    a.isb();
    a.mrs(5, ICC_SRE_EL1);
    a.hvc(0x20); // host dumps GIC state as seen through the API
    a.mrs(6, CNTVCT_EL0);
    a.mrs(7, CNTFRQ_EL0);
    a.add_lsr(6, 6, 7, 6);
    a.msr(CNTV_CVAL_EL0, 6);
    a.movz(9, 1, 0);
    a.msr(CNTV_CTL_EL0, 9);
    a.isb();
    a.daifclr(2); // unmask IRQ
    let idle = a.here();
    // HVF_GIC_SPIN=1 replaces WFI with a busy loop, to measure WFI wake-up latency.
    if std::env::var_os("HVF_GIC_SPIN").is_some() {
        a.nop();
    } else {
        a.wfi();
    }
    a.b(idle);
    // --- vector table at +0x800 (VBAR_EL1 must be 2KiB aligned) ---
    let vbar = RAM_BASE + 0x800;
    for i in 0..16u32 {
        a.org(vbar + 0x80 * i as u64);
        if i == 5 {
            // 0x280: current EL with SP_ELx, IRQ
            a.mrs(20, ICC_IAR1_EL1);
            a.hvc(0x10); // host: "got INTID x20"
            a.msr(CNTV_CTL_EL0, 31); // silence the timer (harmless for SPI)
            a.msr(ICC_EOIR1_EL1, 20);
            a.hvc(0x11); // host: "EOI done" -> unmask vtimer
            a.eret();
        } else {
            a.hvc(0xE00 + i); // unexpected exception vector i
        }
    }
    a
}

fn gic() {
    println!("== gic: VM with in-kernel GICv3 (QEMU virt addresses) ==");
    let ps = page_size();
    unsafe {
        must(
            "hv_vm_create",
            ck("hv_vm_create(NULL)", hv_vm_create(core::ptr::null_mut())),
        );
        let (mut dsz, mut dal, mut rrsz, mut rsz, mut ral, mut msz, mut mal) =
            (0usize, 0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
        ck(
            "hv_gic_get_distributor_size",
            hv_gic_get_distributor_size(&mut dsz),
        );
        ck(
            "hv_gic_get_distributor_base_alignment",
            hv_gic_get_distributor_base_alignment(&mut dal),
        );
        ck(
            "hv_gic_get_redistributor_region_size",
            hv_gic_get_redistributor_region_size(&mut rrsz),
        );
        ck(
            "hv_gic_get_redistributor_size",
            hv_gic_get_redistributor_size(&mut rsz),
        );
        ck(
            "hv_gic_get_redistributor_base_alignment",
            hv_gic_get_redistributor_base_alignment(&mut ral),
        );
        ck(
            "hv_gic_get_msi_region_size",
            hv_gic_get_msi_region_size(&mut msz),
        );
        ck(
            "hv_gic_get_msi_region_base_alignment",
            hv_gic_get_msi_region_base_alignment(&mut mal),
        );
        let (mut sb, mut sc) = (0u32, 0u32);
        ck(
            "hv_gic_get_spi_interrupt_range",
            hv_gic_get_spi_interrupt_range(&mut sb, &mut sc),
        );
        println!(
            "    distributor:   size={dsz:#x} align={dal:#x}  (QEMU GICD {GICD_BASE:#x} aligned? {})",
            GICD_BASE.is_multiple_of(dal as u64)
        );
        println!(
            "    redistributor: region size={rrsz:#x} per-vCPU size={rsz:#x} -> {} vCPUs; align={ral:#x} (QEMU GICR {GICR_BASE:#x} aligned? {})",
            rrsz / rsz.max(1),
            GICR_BASE.is_multiple_of(ral as u64)
        );
        println!(
            "      QEMU virt redist window is {QEMU_GICR_REGION_SIZE:#x} bytes -> region fits? {} (end {:#x})",
            rrsz as u64 <= QEMU_GICR_REGION_SIZE,
            GICR_BASE + rrsz as u64
        );
        println!(
            "    MSI region:    size={msz:#x} align={mal:#x} (QEMU v2m {GIC_MSI_BASE:#x} aligned? {})",
            GIC_MSI_BASE.is_multiple_of(mal.max(1) as u64)
        );
        println!(
            "    SPI INTIDs:    base={sb} count={sc} -> [{sb}, {})",
            sb + sc
        );
        for (n, id) in [
            ("PERFORMANCE_MONITOR", HV_GIC_INT_PERFORMANCE_MONITOR),
            ("MAINTENANCE", HV_GIC_INT_MAINTENANCE),
            ("EL2_PHYSICAL_TIMER", HV_GIC_INT_EL2_PHYSICAL_TIMER),
            ("EL1_VIRTUAL_TIMER", HV_GIC_INT_EL1_VIRTUAL_TIMER),
            ("EL1_PHYSICAL_TIMER", HV_GIC_INT_EL1_PHYSICAL_TIMER),
        ] {
            let mut v = 0u32;
            let rc = hv_gic_get_intid(id, &mut v);
            println!("    hv_gic_get_intid({n:<20}) = {v:<3} [{}]", ret_name(rc));
        }

        let gc = hv_gic_config_create();
        ck(
            "hv_gic_config_set_distributor_base(0x0800_0000)",
            hv_gic_config_set_distributor_base(gc, GICD_BASE),
        );
        ck(
            "hv_gic_config_set_redistributor_base(0x080A_0000)",
            hv_gic_config_set_redistributor_base(gc, GICR_BASE),
        );
        ck(
            "hv_gic_config_set_msi_region_base(0x0802_0000)",
            hv_gic_config_set_msi_region_base(gc, GIC_MSI_BASE),
        );
        // QEMU virt's GICv2m uses SPIs 48..111 (INTID 80..143); mirror that.
        ck(
            "hv_gic_config_set_msi_interrupt_range(80, 64)",
            hv_gic_config_set_msi_interrupt_range(gc, 80, 64),
        );
        must("hv_gic_create", ck("hv_gic_create", hv_gic_create(gc)));
        os_release(gc);
        ck(
            "hv_gic_create again [expect error]",
            hv_gic_create(hv_gic_config_create()),
        );
    }

    let ram = Ram::alloc(4 * ps);
    let mut vcpu: hv_vcpu_t = 0;
    let mut exit: *mut hv_vcpu_exit_t = core::ptr::null_mut();
    unsafe {
        must(
            "map",
            ck(
                "hv_vm_map(RAM 4 pages RWX)",
                hv_vm_map(
                    ram.at(0),
                    RAM_BASE,
                    4 * ps,
                    HV_MEMORY_READ | HV_MEMORY_WRITE | HV_MEMORY_EXEC,
                ),
            ),
        );
        must(
            "hv_vcpu_create",
            ck(
                "hv_vcpu_create",
                hv_vcpu_create(&mut vcpu, &mut exit, core::ptr::null_mut()),
            ),
        );
    }
    let mpidr0 = get_sys(vcpu, HV_SYS_REG_MPIDR_EL1).unwrap();
    println!("    default MPIDR_EL1 = {mpidr0:#x}");
    let mut rd = 0u64;
    unsafe {
        ck(
            "hv_gic_get_redistributor_base (before setting MPIDR)",
            hv_gic_get_redistributor_base(vcpu, &mut rd),
        );
        println!("      -> {rd:#x}");
    }
    set_sys(vcpu, HV_SYS_REG_MPIDR_EL1, 0x8000_0000); // Aff0=0, bit31 RES1
    unsafe {
        ck(
            "hv_gic_get_redistributor_base (MPIDR=0x80000000)",
            hv_gic_get_redistributor_base(vcpu, &mut rd),
        );
    }
    println!("      -> {rd:#x}");
    let prog = gic_program(rd);
    ram.write(0, &prog.bytes());

    unsafe {
        let mut v = 0u64;
        hv_gic_get_distributor_reg(GICD_TYPER, &mut v);
        println!(
            "    GICD_TYPER = {v:#x} (ITLinesNumber={} -> {} INTIDs, SecurityExtn={}, MBIS={}, LPIS={}, IDbits={})",
            v & 0x1f,
            32 * ((v & 0x1f) + 1),
            (v >> 10) & 1,
            (v >> 16) & 1,
            (v >> 17) & 1,
            ((v >> 19) & 0x1f) + 1
        );
        hv_gic_get_distributor_reg(GICD_PIDR2, &mut v);
        println!("    GICD_PIDR2 = {v:#x} (ArchRev={})", (v >> 4) & 0xf);
        hv_gic_get_distributor_reg(GICD_CTLR, &mut v);
        println!("    GICD_CTLR (reset) = {v:#x} (DS={})", (v >> 6) & 1);
        hv_gic_get_redistributor_reg(vcpu, GICR_TYPER, &mut v);
        println!(
            "    GICR_TYPER = {v:#x} (Affinity={:#x}, Last={}, ProcNum={})",
            v >> 32,
            (v >> 4) & 1,
            (v >> 8) & 0xffff
        );
        let rc = hv_gic_get_icc_reg(vcpu, HV_GIC_ICC_REG_SRE_EL1, &mut v);
        println!("    ICC_SRE_EL1 (host view) = {v:#x} [{}]", ret_name(rc));
        let mut p = false;
        ck(
            "hv_vcpu_get_pending_interrupt with GIC [expect UNSUPPORTED]",
            hv_vcpu_get_pending_interrupt(vcpu, HV_INTERRUPT_TYPE_IRQ, &mut p),
        );
        ck(
            "hv_vcpu_set_pending_interrupt with GIC [expect UNSUPPORTED]",
            hv_vcpu_set_pending_interrupt(vcpu, HV_INTERRUPT_TYPE_IRQ, true),
        );
        {
            let (n, r) = ("CNTP_CTL_EL0 (now with GIC)", HV_SYS_REG_CNTP_CTL_EL0);
            match get_sys(vcpu, r) {
                Ok(v) => println!("    {n} = {v:#x}"),
                Err(e) => println!("    {n} -> {}", rs(e)),
            }
        }
    }

    if std::env::var_os("HVF_QOS").is_some() {
        // QOS_CLASS_USER_INTERACTIVE = 0x21 (sys/qos.h)
        let rc = unsafe { pthread_set_qos_class_self_np(0x21, 0) };
        println!("    pthread_set_qos_class_self_np(USER_INTERACTIVE) -> {rc}");
    }
    set_sys(vcpu, HV_SYS_REG_VBAR_EL1, RAM_BASE + 0x800);
    set_sys(vcpu, HV_SYS_REG_SP_EL1, RAM_BASE + 4 * ps as u64);
    set_reg(vcpu, HV_REG_PC, RAM_BASE);
    set_reg(vcpu, HV_REG_CPSR, CPSR_EL1H_MASKED);
    let wd = Watchdog::new(vcpu);
    let spi_sent = Arc::new(AtomicBool::new(false));
    let mut t_arm = Instant::now();
    let mut vtimer_exits = 0;
    let mut wfi_exits = 0;
    let mut mmio_exits = 0;
    let mut last_intid = 0u64;
    let mut fallback_used = false;
    let mut n = 0;
    loop {
        n += 1;
        if n > 40 {
            println!("  too many exits");
            break;
        }
        let (e, dt) = run(vcpu, exit, &wd, 1000);
        let pc = get_reg(vcpu, HV_REG_PC);
        println!(
            "\n  exit #{n}: reason={} after {dt:?}, PC={pc:#x}",
            reason_name(e.reason)
        );
        match e.reason {
            HV_EXIT_REASON_EXCEPTION => {
                println!("    {}", decode(&e.exception));
                let esr = e.exception.syndrome;
                let ec = (esr >> 26) & 0x3f;
                let iss = esr & 0x1ff_ffff;
                match ec {
                    0x16 => match iss & 0xffff {
                        0x20 => {
                            println!(
                                "    guest finished GIC init with {mmio_exits} MMIO exits; guest ICC_SRE_EL1 = {:#x}",
                                get_reg(vcpu, 5)
                            );
                            unsafe {
                                let mut v = 0u64;
                                hv_gic_get_distributor_reg(GICD_CTLR, &mut v);
                                println!("    GICD_CTLR via API = {v:#x}");
                                hv_gic_get_redistributor_reg(vcpu, GICR_ISENABLER0, &mut v);
                                println!("    GICR_ISENABLER0 via API = {v:#x}");
                                hv_gic_get_redistributor_reg(vcpu, GICR_IGROUPR0, &mut v);
                                println!("    GICR_IGROUPR0 via API = {v:#x}");
                                hv_gic_get_icc_reg(vcpu, HV_GIC_ICC_REG_PMR_EL1, &mut v);
                                println!("    ICC_PMR_EL1 via API = {v:#x}");
                                hv_gic_get_icc_reg(vcpu, HV_GIC_ICC_REG_IGRPEN1_EL1, &mut v);
                                println!("    ICC_IGRPEN1_EL1 via API = {v:#x}");
                            }
                            t_arm = Instant::now();
                        }
                        0x10 => {
                            last_intid = get_reg(vcpu, 20);
                            println!(
                                "    *** guest IRQ handler: ICC_IAR1_EL1 = INTID {last_intid} ({:?} since arm/send) ; VTIMER exits so far = {vtimer_exits}, WFI exits = {wfi_exits}",
                                t_arm.elapsed()
                            );
                            println!("    vtimer mask = {}", vtimer_masked(vcpu));
                            if last_intid == SPI_UART as u64 {
                                unsafe {
                                    ck(
                                        "hv_gic_set_spi(33, false) (deassert level)",
                                        hv_gic_set_spi(SPI_UART, false),
                                    )
                                };
                            }
                        }
                        0x11 => {
                            println!("    guest EOI'd INTID {last_intid}");
                            if vtimer_masked(vcpu) {
                                unsafe {
                                    ck(
                                        "hv_vcpu_set_vtimer_mask(false)",
                                        hv_vcpu_set_vtimer_mask(vcpu, false),
                                    )
                                };
                            }
                            if last_intid == 27 && !spi_sent.swap(true, Ordering::SeqCst) {
                                println!(
                                    "    spawning a non-vCPU thread to raise SPI 33 in 30ms while the guest sits in WFI"
                                );
                                std::thread::spawn(|| {
                                    std::thread::sleep(Duration::from_millis(30));
                                    let rc = unsafe { hv_gic_set_spi(SPI_UART, true) };
                                    println!(
                                        "    [spi thread] hv_gic_set_spi(33, true) -> {}",
                                        rs(rc)
                                    );
                                });
                                t_arm = Instant::now();
                            } else if last_intid == SPI_UART as u64 {
                                println!("    SPI path verified; stopping");
                                break;
                            }
                        }
                        imm if imm >= 0xE00 => {
                            println!("    UNEXPECTED guest exception vector {}", imm - 0xE00);
                            for (nm, r) in [
                                ("ESR_EL1", 0xc290u16),
                                ("ELR_EL1", HV_SYS_REG_ELR_EL1),
                                ("FAR_EL1", 0xc300),
                            ] {
                                println!("      {nm} = {:#x}", get_sys(vcpu, r).unwrap_or(0));
                            }
                            break;
                        }
                        _ => {}
                    },
                    0x01 => {
                        wfi_exits += 1;
                        advance_pc(vcpu);
                    }
                    0x24 => {
                        mmio_exits += 1;
                        println!("    MMIO exit (GIC region not handled in kernel?) - skipping");
                        advance_pc(vcpu);
                    }
                    0x18 => {
                        println!("    sysreg trap - skipping");
                        advance_pc(vcpu);
                    }
                    _ => {
                        println!("    unexpected EC; stop");
                        break;
                    }
                }
            }
            HV_EXIT_REASON_VTIMER_ACTIVATED => {
                vtimer_exits += 1;
                println!(
                    "    VTIMER_ACTIVATED with in-kernel GIC ({:?} after arming); mask={}; re-running without touching the GIC",
                    t_arm.elapsed(),
                    vtimer_masked(vcpu)
                );
            }
            HV_EXIT_REASON_CANCELED => {
                println!("    watchdog CANCELED (no progress in 1s)");
                if !fallback_used && last_intid == 0 {
                    fallback_used = true;
                    println!("    fallback: set GICR_ISPENDR0 bit 27 by hand");
                    unsafe {
                        ck(
                            "hv_gic_set_redistributor_reg(ISPENDR0, 1<<27)",
                            hv_gic_set_redistributor_reg(vcpu, GICR_ISPENDR0, 1 << 27),
                        )
                    };
                } else {
                    break;
                }
            }
            _ => break,
        }
    }
    unsafe {
        let mut t = 0u64;
        ck(
            "hv_vcpu_get_wait_for_interrupt_time",
            hv_vcpu_get_wait_for_interrupt_time(vcpu, &mut t),
        );
        println!(
            "    WFI wait time = {t} ticks (~{:.1} ms)",
            t as f64 / host_cntfrq() as f64 * 1000.0
        );
        println!(
            "    summary: vtimer exits={vtimer_exits}, WFI exits={wfi_exits}, MMIO exits={mmio_exits}, fallback used={fallback_used}"
        );

        println!("  -- GIC state save/restore --");
        let st = hv_gic_state_create();
        println!("    hv_gic_state_create -> {st:p}");
        if !st.is_null() {
            let mut sz = 0usize;
            ck("hv_gic_state_get_size", hv_gic_state_get_size(st, &mut sz));
            println!("    state size = {sz} bytes");
            let mut buf = vec![0u8; sz];
            ck(
                "hv_gic_state_get_data",
                hv_gic_state_get_data(st, buf.as_mut_ptr() as *mut c_void),
            );
            println!("    first 16 bytes: {:02x?}", &buf[..16.min(sz)]);
            ck(
                "hv_gic_set_state (after vCPU has run) [header: must be before run]",
                hv_gic_set_state(buf.as_ptr() as *const c_void, sz),
            );
            os_release(st);
        }
        ck("hv_gic_reset", hv_gic_reset());
        let mut v = 0u64;
        hv_gic_get_distributor_reg(GICD_CTLR, &mut v);
        println!("    GICD_CTLR after reset = {v:#x}");
        ck("hv_vcpu_destroy", hv_vcpu_destroy(vcpu));
        ck("hv_vm_destroy", hv_vm_destroy());
    }
}

// ---------------------------------------------------------------------------------------------
// el2: nested virtualization
// ---------------------------------------------------------------------------------------------

fn el2() {
    println!("== el2: VM with EL2 enabled ==");
    let ps = page_size();
    unsafe {
        let mut sup = false;
        hv_vm_config_get_el2_supported(&mut sup);
        if !sup {
            println!("  EL2 not supported on this host; skipping");
            return;
        }
        let c = hv_vm_config_create();
        ck(
            "hv_vm_config_set_el2_enabled(true)",
            hv_vm_config_set_el2_enabled(c, true),
        );
        let mut e = false;
        hv_vm_config_get_el2_enabled(c, &mut e);
        println!("    el2_enabled = {e}");
        must(
            "hv_vm_create",
            ck("hv_vm_create(el2 config)", hv_vm_create(c)),
        );
        os_release(c);
    }
    let mut a = Asm::new(RAM_BASE);
    a.mrs(1, CURRENTEL);
    a.movz(2, (PL011_BASE >> 16) as u32, 1);
    a.str_x(1, 2, 0); // report CurrentEL via an MMIO write
    a.mrs(3, PMCR_EL0); // PMU access with EL2 enabled
    a.hvc(0x42); // HVC executed *at vEL2*
    let ram = Ram::alloc(ps);
    ram.write(0, &a.bytes());
    let mut vcpu = 0;
    let mut exit: *mut hv_vcpu_exit_t = core::ptr::null_mut();
    unsafe {
        must(
            "map",
            hv_vm_map(
                ram.at(0),
                RAM_BASE,
                ps,
                HV_MEMORY_READ | HV_MEMORY_WRITE | HV_MEMORY_EXEC,
            ),
        );
        must(
            "vcpu",
            ck(
                "hv_vcpu_create",
                hv_vcpu_create(&mut vcpu, &mut exit, core::ptr::null_mut()),
            ),
        );
    }
    println!(
        "    default CPSR = {:#x} (M[3:0]={:#x})",
        get_reg(vcpu, HV_REG_CPSR),
        get_reg(vcpu, HV_REG_CPSR) & 0xf
    );
    for (n, r) in [
        ("HCR_EL2", HV_SYS_REG_HCR_EL2),
        ("ID_AA64PFR0_EL1", HV_SYS_REG_ID_AA64PFR0_EL1),
        ("ID_AA64DFR0_EL1", HV_SYS_REG_ID_AA64DFR0_EL1),
    ] {
        match get_sys(vcpu, r) {
            Ok(v) => println!("    {n:<16} = {v:#018x}"),
            Err(e) => println!("    {n:<16} -> {}", rs(e)),
        }
    }
    set_reg(vcpu, HV_REG_PC, RAM_BASE);
    set_reg(vcpu, HV_REG_CPSR, CPSR_EL2H_MASKED);
    let wd = Watchdog::new(vcpu);
    for n in 1..=5 {
        let (e, dt) = run(vcpu, exit, &wd, 500);
        let pc = get_reg(vcpu, HV_REG_PC);
        println!(
            "\n  exit #{n}: reason={} after {dt:?}, PC={pc:#x} CPSR={:#x}",
            reason_name(e.reason),
            get_reg(vcpu, HV_REG_CPSR)
        );
        if e.reason != HV_EXIT_REASON_EXCEPTION {
            break;
        }
        println!("    {}", decode(&e.exception));
        let iss = e.exception.syndrome & 0x1ff_ffff;
        match (e.exception.syndrome >> 26) & 0x3f {
            0x24 => {
                let srt = ((iss >> 16) & 0x1f) as u32;
                println!(
                    "    MMIO write value (CurrentEL) = {:#x} -> EL{}",
                    get_reg(vcpu, srt),
                    (get_reg(vcpu, srt) >> 2) & 3
                );
                advance_pc(vcpu);
            }
            0x18 => {
                println!("    PMU sysreg trapped even with EL2 enabled");
                advance_pc(vcpu);
            }
            0x16 => {
                println!("    HVC from vEL2 exited to the host VMM");
                break;
            }
            0x20 => {
                // The guest took an exception *inside* the VM (to its own vEL2 vectors at
                // VBAR_EL2=0), and fetching the vector faulted. Show what the guest saw.
                let esr2 = get_sys(vcpu, 0xe290).unwrap_or(0); // HV_SYS_REG_ESR_EL2
                let elr2 = get_sys(vcpu, 0xe201).unwrap_or(0); // HV_SYS_REG_ELR_EL2
                let vbar2 = get_sys(vcpu, 0xe600).unwrap_or(0); // HV_SYS_REG_VBAR_EL2
                println!(
                    "    guest-visible ESR_EL2={esr2:#x} (EC={:#x} {}) ELR_EL2={elr2:#x} VBAR_EL2={vbar2:#x}",
                    esr2 >> 26,
                    ec_name(esr2 >> 26)
                );
                break;
            }
            _ => break,
        }
    }
    unsafe {
        ck("hv_vcpu_destroy", hv_vcpu_destroy(vcpu));
        ck("hv_vm_destroy", hv_vm_destroy());
    }
}

// ---------------------------------------------------------------------------------------------
// align: mapping rules
// ---------------------------------------------------------------------------------------------

fn align() {
    println!("== align: hv_vm_map rules ==");
    let ps = page_size();
    let rw = HV_MEMORY_READ | HV_MEMORY_WRITE;
    unsafe {
        let (mut max, mut def) = (0u32, 0u32);
        hv_vm_config_get_max_ipa_size(&mut max);
        hv_vm_config_get_default_ipa_size(&mut def);
        let ram = Ram::alloc(8 * ps);

        println!("  -- default config (default granule, default IPA {def} bits) --");
        must("vm", hv_vm_create(core::ptr::null_mut()));
        ck(
            "map 16K @ IPA 0x4000_0000, host page-aligned",
            hv_vm_map(ram.at(0), RAM_BASE, 0x4000, rw),
        );
        ck(
            "map 16K @ IPA 0x4000_5000 (4K-aligned only)",
            hv_vm_map(ram.at(ps), RAM_BASE + 0x5000, 0x4000, rw),
        );
        ck(
            "map 4K  @ IPA 0x4001_0000 (size 4K)",
            hv_vm_map(ram.at(2 * ps), RAM_BASE + 0x10000, 0x1000, rw),
        );
        ck(
            "map 16K @ IPA 0x4002_0000, host VA +0x1000",
            hv_vm_map(ram.at(3 * ps + 0x1000), RAM_BASE + 0x20000, 0x4000, rw),
        );
        let top = 1u64 << def;
        ck(
            &format!("map 16K @ IPA (1<<{def})-16K (last page)"),
            hv_vm_map(ram.at(4 * ps), top - 0x4000, 0x4000, rw),
        );
        ck(
            &format!("map 16K @ IPA 1<<{def} (just beyond)"),
            hv_vm_map(ram.at(5 * ps), top, 0x4000, rw),
        );
        ck("unmap 4K of a 16K mapping", hv_vm_unmap(RAM_BASE, 0x1000));
        ck(
            "protect 16K -> READ",
            hv_vm_protect(RAM_BASE, 0x4000, HV_MEMORY_READ),
        );
        ck(
            "unmap never-mapped 16K @ 0x5000_0000",
            hv_vm_unmap(0x5000_0000, 0x4000),
        );
        ck("map 0 bytes", hv_vm_map(ram.at(6 * ps), 0x6000_0000, 0, rw));
        ck(
            "map with flags=0 (no access)",
            hv_vm_map(ram.at(6 * ps), 0x6000_0000, 0x4000, 0),
        );
        hv_vm_destroy();

        println!("  -- config: IPA size = max ({max} bits) --");
        let c = hv_vm_config_create();
        ck("set_ipa_size(max)", hv_vm_config_set_ipa_size(c, max));
        must("vm", hv_vm_create(c));
        os_release(c);
        let top = 1u64 << max;
        ck(
            &format!("map 16K @ IPA (1<<{max})-16K"),
            hv_vm_map(ram.at(0), top - 0x4000, 0x4000, rw),
        );
        ck(
            &format!("map 16K @ IPA 1<<{max}"),
            hv_vm_map(ram.at(ps), top, 0x4000, rw),
        );
        hv_vm_destroy();

        println!("  -- config: IPA granule = 4KB --");
        let c = hv_vm_config_create();
        let rc = ck(
            "hv_vm_config_set_ipa_granule(HV_IPA_GRANULE_4KB)",
            hv_vm_config_set_ipa_granule(c, HV_IPA_GRANULE_4KB),
        );
        if rc == HV_SUCCESS {
            let r = ck("hv_vm_create(4K granule config)", hv_vm_create(c));
            if r == HV_SUCCESS {
                ck(
                    "map 4K  @ IPA 0x4000_1000, host VA page+0x1000",
                    hv_vm_map(ram.at(0x1000), RAM_BASE + 0x1000, 0x1000, rw),
                );
                ck(
                    "map 4K  @ IPA 0x4000_3000, host VA page+0x2000 (VA/IPA offsets differ)",
                    hv_vm_map(ram.at(0x2000), RAM_BASE + 0x3000, 0x1000, rw),
                );
                ck(
                    "map 12K @ IPA 0x4001_0000",
                    hv_vm_map(ram.at(ps), RAM_BASE + 0x10000, 0x3000, rw),
                );
                ck("unmap 4K", hv_vm_unmap(RAM_BASE + 0x1000, 0x1000));
                // Run a vCPU in a 4K-granule VM to prove it actually executes.
                let mut a = Asm::new(0x8000_1000);
                a.movz(0, 0x4b, 0);
                a.hvc(0x4);
                let code = Ram::alloc(ps);
                code.write(0x1000, &a.bytes());
                ck(
                    "map 4K code @ IPA 0x8000_1000 (host VA page+0x1000)",
                    hv_vm_map(
                        code.at(0x1000),
                        0x8000_1000,
                        0x1000,
                        HV_MEMORY_READ | HV_MEMORY_EXEC,
                    ),
                );
                let mut vcpu = 0;
                let mut exit: *mut hv_vcpu_exit_t = core::ptr::null_mut();
                must(
                    "vcpu",
                    hv_vcpu_create(&mut vcpu, &mut exit, core::ptr::null_mut()),
                );
                set_reg(vcpu, HV_REG_PC, 0x8000_1000);
                set_reg(vcpu, HV_REG_CPSR, CPSR_EL1H_MASKED);
                let wd = Watchdog::new(vcpu);
                let (e, _) = run(vcpu, exit, &wd, 500);
                println!(
                    "    4K-granule guest: reason={} {} x0={:#x}",
                    reason_name(e.reason),
                    decode(&e.exception),
                    get_reg(vcpu, 0)
                );
                hv_vcpu_destroy(vcpu);
                hv_vm_destroy();
            }
        }
        os_release(c);
    }
}

// ---------------------------------------------------------------------------------------------
// gicprobe: which guest-physical ranges does the in-kernel GIC swallow?
// ---------------------------------------------------------------------------------------------

fn mov64(a: &mut Asm, rd: u32, v: u64) {
    a.movz(rd, (v & 0xffff) as u32, 0);
    for hw in 1..4 {
        let part = ((v >> (16 * hw)) & 0xffff) as u32;
        if part != 0 {
            a.movk(rd, part, hw);
        }
    }
}

/// Usage: gicprobe <redist_base_hex> [ipa_bits]
fn gicprobe(redist: u64, ipa_bits: Option<u32>) {
    println!(
        "== gicprobe: GICD={GICD_BASE:#x} GICR={redist:#x} MSI={GIC_MSI_BASE:#x} ipa_bits={ipa_bits:?} =="
    );
    let ps = page_size();
    let mut rrsz = 0usize;
    unsafe {
        let c = hv_vm_config_create();
        if let Some(b) = ipa_bits {
            ck("hv_vm_config_set_ipa_size", hv_vm_config_set_ipa_size(c, b));
        }
        must("vm", ck("hv_vm_create", hv_vm_create(c)));
        os_release(c);
        hv_gic_get_redistributor_region_size(&mut rrsz);
        let gc = hv_gic_config_create();
        ck(
            "hv_gic_config_set_distributor_base",
            hv_gic_config_set_distributor_base(gc, GICD_BASE),
        );
        ck(
            "hv_gic_config_set_redistributor_base",
            hv_gic_config_set_redistributor_base(gc, redist),
        );
        ck(
            "hv_gic_config_set_msi_region_base",
            hv_gic_config_set_msi_region_base(gc, GIC_MSI_BASE),
        );
        ck(
            "hv_gic_config_set_msi_interrupt_range(80, 64)",
            hv_gic_config_set_msi_interrupt_range(gc, 80, 64),
        );
        must("gic", ck("hv_gic_create", hv_gic_create(gc)));
        os_release(gc);
    }
    let r = rrsz as u64;
    // (name, address, 64-bit access?)
    let probes: Vec<(&str, u64, bool)> = vec![
        ("PL011 UARTDR (QEMU 0x0900_0000)", PL011_BASE, false),
        ("virtio-mmio slot 0 (0x0a00_0000)", 0x0a00_0000, false),
        ("GICR vCPU0 GICR_TYPER (32-bit)", redist + 0x8, false),
        ("GICR vCPU0 GICR_TYPER (64-bit)", redist + 0x8, true),
        ("GICR vCPU0 GICR_PIDR2", redist + 0xffe8, false),
        (
            "GICR vCPU1 GICR_TYPER (no such vCPU)",
            redist + 0x20000 + 0x8,
            false,
        ),
        (
            "GICR last slot GICR_TYPER",
            redist + r - 0x20000 + 0x8,
            false,
        ),
        ("just past GICR region", redist + r, false),
        ("GICD_TYPER", GICD_BASE + 0x4, false),
        ("GICD_PIDR2", GICD_BASE + 0xffe8, false),
        ("just past GICD (dist+64K)", GICD_BASE + 0x10000, false),
        ("GICM_TYPER (MSI frame +8)", GIC_MSI_BASE + 0x8, false),
        ("just past MSI frame", GIC_MSI_BASE + 0x10000, false),
    ];
    let mut a = Asm::new(RAM_BASE);
    for (i, (_, addr, wide)) in probes.iter().enumerate() {
        mov64(&mut a, 1, *addr);
        a.movz(2, 0xdead, 0);
        if *wide {
            a.ldr_x(2, 1, 0);
        } else {
            a.ldr_w(2, 1, 0);
        }
        a.hvc(0x30 + i as u32);
    }
    a.hvc(0x3f);
    let vbar = RAM_BASE + 0x800;
    for i in 0..16u32 {
        a.org(vbar + 0x80 * i as u64);
        a.hvc(0xE00 + i);
    }
    let ram = Ram::alloc(ps);
    ram.write(0, &a.bytes());
    let mut vcpu = 0;
    let mut exit: *mut hv_vcpu_exit_t = core::ptr::null_mut();
    unsafe {
        must(
            "map",
            hv_vm_map(
                ram.at(0),
                RAM_BASE,
                ps,
                HV_MEMORY_READ | HV_MEMORY_WRITE | HV_MEMORY_EXEC,
            ),
        );
        must(
            "vcpu",
            hv_vcpu_create(&mut vcpu, &mut exit, core::ptr::null_mut()),
        );
    }
    set_sys(vcpu, HV_SYS_REG_MPIDR_EL1, 0x8000_0000);
    set_sys(vcpu, HV_SYS_REG_VBAR_EL1, vbar);
    set_reg(vcpu, HV_REG_PC, RAM_BASE);
    set_reg(vcpu, HV_REG_CPSR, CPSR_EL1H_MASKED);
    let wd = Watchdog::new(vcpu);
    let mut exited = false;
    for _ in 0..60 {
        let (e, _) = run(vcpu, exit, &wd, 500);
        if e.reason != HV_EXIT_REASON_EXCEPTION {
            println!("  reason={}", reason_name(e.reason));
            break;
        }
        let esr = e.exception.syndrome;
        let iss = esr & 0x1ff_ffff;
        match (esr >> 26) & 0x3f {
            0x24 => {
                exited = true;
                let srt = ((iss >> 16) & 0x1f) as u32;
                set_reg(vcpu, HV_REG_X0 + srt, 0);
                advance_pc(vcpu);
            }
            0x16 => {
                let imm = iss & 0xffff;
                if (0x30..0x3f).contains(&imm) {
                    let (name, addr, _) = probes[(imm - 0x30) as usize];
                    let x2 = get_reg(vcpu, 2);
                    println!(
                        "  {name:<40} {addr:#012x}: {}",
                        if exited {
                            "EXITS to VMM (data abort)".to_string()
                        } else {
                            format!("handled in kernel, read {x2:#x}")
                        }
                    );
                    exited = false;
                } else if imm == 0x3f {
                    break;
                } else if imm >= 0xE00 {
                    let esr1 = get_sys(vcpu, 0xc290).unwrap_or(0);
                    let elr = get_sys(vcpu, HV_SYS_REG_ELR_EL1).unwrap_or(0);
                    let spsr = get_sys(vcpu, HV_SYS_REG_SPSR_EL1).unwrap_or(0);
                    println!(
                        "    -> guest took exception vector {} : ESR_EL1={esr1:#x} (EC={:#x}) ELR_EL1={elr:#x}; resuming after it",
                        imm - 0xE00,
                        esr1 >> 26
                    );
                    set_reg(vcpu, HV_REG_PC, elr + 4);
                    set_reg(vcpu, HV_REG_CPSR, spsr);
                    exited = true; // the access did not complete normally
                }
            }
            ec => {
                println!("  unexpected EC {ec:#x}: {}", decode(&e.exception));
                break;
            }
        }
    }
    unsafe {
        hv_vcpu_destroy(vcpu);
        hv_vm_destroy();
    }
}

// ---------------------------------------------------------------------------------------------
// smp: one thread per vCPU, redistributor placement vs MPIDR, hv_vcpus_exit on many vCPUs
// ---------------------------------------------------------------------------------------------

fn smp() {
    const N: usize = 4;
    const MPIDR_EL1: SysReg = SysReg {
        name: "MPIDR_EL1",
        op0: 3,
        op1: 0,
        crn: 0,
        crm: 0,
        op2: 5,
    };
    println!("== smp: {N} vCPUs, each on its own thread, with in-kernel GIC ==");
    let ps = page_size();
    unsafe {
        must("vm", hv_vm_create(core::ptr::null_mut()));
        let gc = hv_gic_config_create();
        hv_gic_config_set_distributor_base(gc, GICD_BASE);
        hv_gic_config_set_redistributor_base(gc, GICR_BASE);
        must("gic", ck("hv_gic_create", hv_gic_create(gc)));
        os_release(gc);
    }
    let mut a = Asm::new(RAM_BASE);
    a.mrs(0, MPIDR_EL1);
    a.hvc(1);
    let spin = a.here();
    a.b(spin);
    let ram = Ram::alloc(ps);
    ram.write(0, &a.bytes());
    unsafe {
        must(
            "map",
            hv_vm_map(ram.at(0), RAM_BASE, ps, HV_MEMORY_READ | HV_MEMORY_EXEC),
        )
    };

    let barrier = Arc::new(std::sync::Barrier::new(N + 1));
    let started = Arc::new(std::sync::Barrier::new(N + 1));
    let done = Arc::new(std::sync::Barrier::new(N + 1));
    let ids = Arc::new(Mutex::new(vec![0u64; N]));
    let out = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut hs = vec![];
    for idx in 0..N {
        let (barrier, started, done, ids, out) = (
            barrier.clone(),
            started.clone(),
            done.clone(),
            ids.clone(),
            out.clone(),
        );
        hs.push(std::thread::spawn(move || {
            let mut vcpu = 0;
            let mut exit: *mut hv_vcpu_exit_t = core::ptr::null_mut();
            must("vcpu", unsafe { hv_vcpu_create(&mut vcpu, &mut exit, core::ptr::null_mut()) });
            let aff0 = (N - 1 - idx) as u64; // deliberately the reverse of creation order
            set_sys(vcpu, HV_SYS_REG_MPIDR_EL1, 0x8000_0000 | aff0);
            ids.lock().unwrap()[idx] = vcpu;
            barrier.wait(); // all vCPUs created + MPIDRs set
            let mut rd = 0;
            let rc = unsafe { hv_gic_get_redistributor_base(vcpu, &mut rd) };
            let mut typer = 0;
            unsafe { hv_gic_get_redistributor_reg(vcpu, GICR_TYPER, &mut typer) };
            set_reg(vcpu, HV_REG_PC, RAM_BASE);
            set_reg(vcpu, HV_REG_CPSR, CPSR_EL1H_MASKED);
            unsafe { must("run", hv_vcpu_run(vcpu)) };
            let e = unsafe { core::ptr::read_volatile(exit) };
            let x0 = get_reg(vcpu, 0);
            started.wait();
            let t0 = Instant::now();
            unsafe { must("run", hv_vcpu_run(vcpu)) };
            let e2 = unsafe { core::ptr::read_volatile(exit) };
            out.lock().unwrap().push(format!(
                "  thread {idx}: vcpu id={vcpu} Aff0={aff0} redist_base={rd:#x} [{}] GICR_TYPER={typer:#x} (Aff={:#x} Last={} ProcNum={}) | 1st exit {} guest MPIDR={x0:#x} | 2nd exit {} after {:?}",
                ret_name(rc), typer >> 32, (typer >> 4) & 1, (typer >> 8) & 0xffff,
                reason_name(e.reason), reason_name(e2.reason), t0.elapsed()
            ));
            done.wait();
            unsafe { hv_vcpu_destroy(vcpu) };
        }));
    }
    barrier.wait();
    started.wait();
    std::thread::sleep(Duration::from_millis(50));
    let mut v = ids.lock().unwrap().clone();
    unsafe {
        ck(
            "hv_vcpus_exit(all 4 ids) from main thread",
            hv_vcpus_exit(v.as_mut_ptr(), N as u32),
        )
    };
    // let the vCPU threads record their result before trying a late vCPU creation
    while out.lock().unwrap().len() < N {
        std::thread::sleep(Duration::from_millis(5));
    }
    let mut late = 0;
    let mut lexit: *mut hv_vcpu_exit_t = core::ptr::null_mut();
    let rc = unsafe { hv_vcpu_create(&mut late, &mut lexit, core::ptr::null_mut()) };
    println!(
        "  hv_vcpu_create AFTER other vCPUs ran (CPU hotplug?)          -> {}",
        rs(rc)
    );
    if rc == HV_SUCCESS {
        set_sys(late, HV_SYS_REG_MPIDR_EL1, 0x8000_0000 | N as u64);
        let mut rd = 0;
        let rc2 = unsafe { hv_gic_get_redistributor_base(late, &mut rd) };
        println!(
            "    late vCPU id={late} redist_base={rd:#x} [{}]",
            ret_name(rc2)
        );
        unsafe { hv_vcpu_destroy(late) };
    }
    let mut lines = out.lock().unwrap().clone();
    lines.sort();
    for l in lines {
        println!("{l}");
    }
    done.wait();
    for h in hs {
        h.join().unwrap();
    }
    unsafe { ck("hv_vm_destroy", hv_vm_destroy()) };
}

fn dump() {
    let b = basic_program();
    let g = gic_program(GICR_BASE);
    for (name, a) in [("basic", &b.asm), ("gic", &g)] {
        println!("# {name}");
        for (w, m) in &a.words {
            println!("{w:08x} {m}");
        }
    }
}

fn main() {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "all".into());
    match mode.as_str() {
        "info" => info(),
        "basic" => basic(),
        "gic" => gic(),
        "el2" => el2(),
        "align" => align(),
        "dump" => dump(),
        "smp" => smp(),
        "gicprobe" => {
            let args: Vec<String> = std::env::args().collect();
            let base = args
                .get(2)
                .map(|s| u64::from_str_radix(s.trim_start_matches("0x"), 16).expect("hex"))
                .unwrap_or(GICR_BASE);
            let bits = args.get(3).map(|s| s.parse().expect("ipa bits"));
            gicprobe(base, bits)
        }
        _ => {
            eprintln!("usage: hvf-hello info|basic|gic|el2|align|dump");
            std::process::exit(2);
        }
    }
}
