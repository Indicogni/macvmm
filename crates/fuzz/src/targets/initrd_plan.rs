//! Target `initrd_plan`: the Linux boot plan (`vmm::loader::plan`, `initrd`): where the kernel,
//! initrd and DTB go in RAM, and the command line (booting.rst §2–§4; threat model LDR-3, LDR-5,
//! FDT-2).
//!
//! **Input:** RAM size code (byte 0), initrd length (bytes 1..4, capped at 4 MiB), command line
//! length (bytes 4..6) and fill byte, then an Image header (see the `image` target).
//!
//! **Invariants** (threat model §9.3 "initrd_plan"): `plan` returns `Err`, or every placement
//! (DTB, kernel, initrd) lies inside RAM and no two overlap; the initrd placement has exactly
//! the input's length; the boot arguments are at most 2047 bytes.

use super::Input;
use crate::Target;
use crate::rng::Rng;
use vmm::arch::layout::{RAM_ALIGN, RAM_BASE, RAM_MIN};
use vmm::loader::RamRange;
use vmm::loader::plan::{self, BootInputs};

pub const TARGET: Target = Target {
    name: "initrd_plan",
    run,
    seed,
    mutate,
    max_len: 16 + 0x200,
};

pub fn run(data: &[u8]) -> crate::Verdict {
    let mut i = Input::new(data);
    let ram = RamRange {
        base: RAM_BASE,
        size: RAM_MIN + RAM_ALIGN * u64::from(i.u8()),
    };
    let initrd_len = usize::try_from(i.le(3) % (4 << 20)).unwrap_or(0);
    let cmd_len = usize::from(i.u16() % 2100);
    let fill = i.u8();
    let _ = i.bytes(10);
    let kernel = i.rest();
    let initrd = vec![0u8; initrd_len];
    let cmdline: String = std::iter::repeat_n(char::from(b' ' + fill % 95), cmd_len).collect();
    let inputs = BootInputs {
        kernel: Some(kernel),
        raw: &[],
        initrd: (initrd_len > 0).then_some(initrd.as_slice()),
        cmdline: (cmd_len > 0).then_some(cmdline.as_str()),
    };
    let Ok(p) = plan::plan(ram, &inputs) else {
        return Ok(());
    };
    let mut spans = vec![(p.dtb.addr, p.dtb.len, p.dtb.what.clone())];
    spans.extend(p.images.iter().map(|x| (x.addr, x.len, x.what.clone())));
    for (k, (a, l, w)) in spans.iter().enumerate() {
        if !ram.contains(*a, *l) {
            return Err(format!("{w} {a:#x}+{l:#x} outside RAM {ram:?}"));
        }
        for (b, m, v) in spans.iter().skip(k + 1) {
            if super::overlap(*a, *l, *b, *m) {
                return Err(format!("{w} and {v} overlap"));
            }
        }
    }
    if let Some((start, end)) = p.initrd
        && end.checked_sub(start) != u64::try_from(initrd_len).ok()
    {
        return Err(format!(
            "initrd placed at [{start:#x}, {end:#x}), input {initrd_len} bytes"
        ));
    }
    if p.bootargs.as_ref().is_some_and(|b| b.len() > 2047) {
        return Err("bootargs longer than 2047 bytes (FDT-2)".into());
    }
    Ok(())
}

fn seed(rng: &mut Rng) -> Vec<u8> {
    let mut b = vec![0u8; 16];
    b[0] = rng.byte();
    crate::mutate::put_le(&mut b, 1, 3, rng.below(4 << 20));
    crate::mutate::put_le(&mut b, 4, 2, rng.below(300));
    b[6] = rng.byte();
    let len = 64 + rng.index(0x100);
    b.extend(super::image::header(rng, len));
    b
}

fn mutate(rng: &mut Rng, buf: &mut Vec<u8>) {
    let at = rng
        .pick(&[0usize, 1, 3, 4, 16 + 8, 16 + 16, 16 + 24])
        .unwrap_or(0);
    let v = rng.pick(&crate::mutate::INTERESTING_U64).unwrap_or(0);
    crate::mutate::put_le(buf, at, if at >= 16 { 8 } else { 2 }, v);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seeds_hold() {
        let mut r = Rng::new(12);
        for _ in 0..1_000 {
            let mut s = seed(&mut r);
            assert_eq!(run(&s), Ok(()));
            mutate(&mut r, &mut s);
            assert_eq!(run(&s), Ok(()));
        }
    }
}
