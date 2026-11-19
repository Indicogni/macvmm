# The exit trace schema

This file mirrors `docs/architecture.md` §16 ("Exit trace"). The implementation and its doc
table are in `crates/vmm/src/trace.rs`, and the golden test `trace::tests::jsonl_golden` pins
the exact bytes. When one of the three changes, change the other two in the same commit.

## Producing a trace

```text
macvmm run ... --trace exits:FILE[:CATS][,max=SIZE]
```

- `FILE` is created with mode 0600. A symbolic link is refused (exit 2,
  `refusing symlinked output`), and so is a file that is also one of the run's inputs
  (exit 2, `it is the same file as`).
- `CATS` is a comma-separated subset of `mmio`, `hvc`, `sysreg`, `psci`, `cancel` and `all`.
  The default is `all`.
  - `mmio`: data aborts (`"ec":"0x24"`).
  - `hvc`: every HVC exit (`"ec":"0x16"`).
  - `sysreg`: trapped system registers (`"ec":"0x18"`).
  - `psci`: PSCI calls over either conduit (`"action":"psci"`).
  - `cancel`: `CANCELED` exits.
  - `all`: everything, including exits that no other category names.
- `SIZE` caps the file. The default is `1G`; `K`, `M` and `G` suffixes work. When the next
  record would cross the cap, the writer appends one final record and writes nothing after it:
  `{"t_ns":…,"action":"trace_truncated","max":…,"written":…}`.

## Records

The file has one JSON object per line, one line per VM exit. Fields appear in the order of the
table below. A field is omitted when it does not apply.

| Field | Type | Meaning |
|---|---|---|
| `t_ns` | integer | Nanoseconds since this boot's machine was built. |
| `vcpu` | integer | The vCPU index. |
| `reason` | string | `exception`, `canceled`, `vtimer` or `unknown` (the `hv_exit_reason_t`). |
| `ec` | hex string | `ESR_EL2.EC`. Exceptions only. |
| `pc` | hex string | The PC as the exit reported it. After an HVC it already points past the `hvc`. |
| `ipa` | hex string | The faulting IPA. Data and instruction aborts only. |
| `wnr` | bool | Data abort: true for a write. |
| `size` | integer | Data abort: the access size in bytes (1, 2, 4 or 8). |
| `reg` | integer | Data abort: SRT, the register. 31 means XZR. |
| `value` | hex string | MMIO: the value written, masked to the size, or the value loaded into the register after sign extension. |
| `imm` | integer | The HVC, SMC or BRK immediate. |
| `sysreg` | string | The name of the trapped system register (from M5), when macvmm knows it. |
| `sysreg_enc` | hex string | The trapped system register's `hv_sys_reg_t` encoding, `op0<<14 \| op1<<11 \| CRn<<7 \| CRm<<3 \| op2` (from M5). Always present on an EC 0x18 record, so a register without a name (for example `S3_0_C15_C0_0` = `0xc780`) is still identified. |
| `fn` | string | The SMCCC function name, for example `DEBUG_PUTC` or `PSCI_SYSTEM_OFF`. |
| `action` | string | One of `mmio`, `psci`, `smccc`, `sysreg`, `inject_undef`, `inject_abort` or `stop`. `stop` marks a fatal exit. |
| `isv` | bool | Present (as `false`) only on a data abort with ISV = 0. M17 widens this. |
| `boot` | integer | The reboot generation. Present only when it is greater than 0. |

### Encoding rules

- 64-bit quantities (`ec`, `pc`, `ipa`, `value`) are lowercase hex strings with a `0x` prefix
  and no leading zeros. JSON numbers lose precision above 2^53, so these values are never
  written as numbers.
- Small counts (`vcpu`, `size`, `reg`, `imm`, `boot`) are integers.
- String fields hold only names from static tables, never guest bytes. They are still
  JSON-escaped, including U+0000–U+001F, U+007F–U+009F, U+2028 and U+2029 (threat model TTY-8).

## Examples

These are taken from the golden test and from real runs on the dev machine.

```text
{"t_ns":1234,"vcpu":0,"reason":"exception","ec":"0x24","pc":"0x40080010","ipa":"0x9000000","wnr":true,"size":4,"reg":2,"value":"0x48","action":"mmio"}
{"t_ns":99,"vcpu":1,"reason":"exception","ec":"0x16","pc":"0x40080104","imm":0,"fn":"DEBUG_PUTC","action":"smccc","boot":2}
{"t_ns":0,"vcpu":0,"reason":"canceled","pc":"0x40080000"}
{"t_ns":239583,"vcpu":0,"reason":"exception","ec":"0x20","pc":"0x200","ipa":"0x200","action":"stop"}
```

## Matching a trace in a checkpoint

Trace marker files (`<test>.trace.txt`) follow the same rules as serial marker files:

- Markers must appear in order, as substrings.
- `*` matches any run of characters except a newline.
- A line starting with `!` must appear nowhere in the trace.

Because a field is omitted when it does not apply, a marker should name the adjacent fields it
needs in order, for example `"ipa":"0xb000000","wnr":true,"size":1`.

The fatal dump on stderr ends with `last exits: N (oldest first)`, followed by the vCPU's last
32 records (at most) in this same format. The last of them is the fatal exit itself.
