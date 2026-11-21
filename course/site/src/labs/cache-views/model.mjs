// cache-views model: two observers of one window of guest RAM, and a toy data cache.
//
// Pure ES module (no DOM, no I/O) so `node --test` can import it. The view only renders the
// state this file produces and turns clicks into `apply(state, action)` calls.
//
// What is modelled (the `caches` primer, and chapter 13's "cleaned to PoC" rule):
// - RAM: four lines starting at the guest RAM base 0x4000_0000, spaced by the *smallest* data
//   line size, CTR_EL0.DminLine (64 bytes here). That is the safe stride for maintenance loops,
//   but real lines may be larger: this Mac reports hw.cachelinesize = 128, so on the hardware
//   lab lines 0/1 and 2/3 can share one physical line (maintenance on one then acts on both, and
//   writes to the two can collide: false sharing). The model keeps the four lines independent to
//   keep the story readable. Each line is shown as one byte value (think "its first byte").
// - The VMM reads and writes guest RAM through an ordinary cacheable mapping: its accesses go
//   through a write-back data cache with one slot per line (Invalid, Clean or Dirty).
// - The guest, with its MMU off, makes Device accesses: they go straight to RAM, around the
//   cache (ARM ARM DDI 0487, chapter D8, "The effects of disabling address translation").
// - Clean writes a dirty line back to RAM (the PoC) and keeps it; invalidate drops the line
//   without writing it back; clean and invalidate does both; an eviction is the cache doing
//   clean and invalidate on its own, whenever it likes.
// - Not drawn: speculative allocation. The core may pull Normal cacheable memory into the VMM's
//   cache at any time, which is why, for the guest-to-VMM direction, the VMM invalidates *after*
//   the guest's write and before it reads, never only beforehand. The fix texts say so.
// - Invalidate on its own (DC IVAC) is EL1-and-above only (ARM ARM, DC IVAC; it is UNDEFINED at
//   EL0, and SCTLR_EL1.UCI only opens DC CVAC, CVAU, CIVAC to EL0). A VMM that runs as a macOS
//   process at EL0 gets the same effect with clean and invalidate, which on a clean line does
//   exactly what invalidate does. The lab keeps invalidate because it is the teaching point.
//
// Two switches change who meets where:
// - guest "on": the guest's MMU is on with Normal cacheable memory, so its accesses use the
//   same coherent cache as the VMM. Data caches behave as PIPT, so the VMM's and the guest's
//   mappings of the same physical line meet in one cache line, provided both use Normal
//   Write-Back cacheable, Inner Shareable attributes (mismatched attributes lose the guarantee).
// - platform "apple": the result chapter 04's memtest measured on Apple Silicon under
//   Hypervisor.framework: MMU-off guest writes are seen by the VMM's cacheable reads and the
//   other way round. The lab models that observed outcome, not a mechanism (HVF does not
//   document its stage-2 settings, so the mechanism is unknown).
//
// Staleness is defined with write versions, not values (two writes may store the same byte):
// every write gets a fresh version number; a read is stale when it returns a version older
// than the newest one that still exists anywhere (RAM or the cache). A write is lost when an
// operation makes the newest version disappear from the system.

/** Number of lines in the window. */
export const LINES = 4;

/** Guest-physical base of the window: the start of RAM in the QEMU-virt-like memory map. */
export const BASE = 0x4000_0000;

/**
 * CTR_EL0 as Hypervisor.framework reports it to a guest on the M5 Pro (the `caches` primer,
 * `hv_vcpu_config_get_feature_reg`). DminLine (bits 19:16) gives the smallest data line.
 */
export const CTR_EL0 = 0x9_9444_c004n;

/** Decode the smallest data-cache line size, in bytes, from a CTR_EL0 value (BigInt). */
export function dminLineBytes(ctr) {
  if (typeof ctr !== "bigint" || ctr < 0n) throw new TypeError("CTR_EL0 must be a non-negative BigInt");
  const n = Number((ctr >> 16n) & 0xfn);
  return 4 * 2 ** n; // 2^n words of 4 bytes
}

/**
 * Line spacing used for addresses in the lab: the smallest data line (64 bytes here), the safe
 * stride for maintenance loops. Real lines may be larger (128 bytes on this Mac).
 */
export const LINE_BYTES = dminLineBytes(CTR_EL0);

/** Address of a line, formatted like the course writes addresses: 0x4000_0040. */
export function lineAddress(line) {
  const a = BASE + line * LINE_BYTES;
  const h = a.toString(16).padStart(8, "0");
  return `0x${h.slice(0, 4)}_${h.slice(4)}`;
}

export function hex8(v) {
  return `0x${v.toString(16).toUpperCase().padStart(2, "0")}`;
}

export const PLATFORMS = ["arch", "apple"];
export const GUEST_MODES = ["off", "on"];

/** Limits for share-state strings and logs (they come from a URL, so they are hostile). */
export const MAX_ACTIONS = 64;
export const MAX_HASH = 1024;
const MAX_LOG = 40;

/** Fresh state: RAM all 0x00 (version 0), cache empty. */
export function initialState(platform = "arch", guest = "off") {
  if (!PLATFORMS.includes(platform)) throw new RangeError(`unknown platform ${platform}`);
  if (!GUEST_MODES.includes(guest)) throw new RangeError(`unknown guest mode ${guest}`);
  return {
    platform,
    guest,
    ram: Array.from({ length: LINES }, () => ({ value: 0, ver: 0 })),
    cache: Array.from({ length: LINES }, () => ({ valid: false, dirty: false, value: 0, ver: 0 })),
    nextVer: 1,
    actions: [], // applied actions, for the share string (at most MAX_ACTIONS)
    overflow: false, // true once more than MAX_ACTIONS were applied: no share string any more
    lastOp: null, // operation of the last valid action
    pending: [], // remaining steps of a loaded scenario
    scenario: null,
    log: [], // events, newest last
  };
}

/** True when the guest's accesses meet the VMM's in the cache (no bypass). */
export function coherent(state) {
  return state.guest === "on" || state.platform === "apple";
}

function clone(state) {
  return {
    ...state,
    ram: state.ram.map((l) => ({ ...l })),
    cache: state.cache.map((l) => ({ ...l })),
    actions: state.actions.slice(),
    pending: state.pending.slice(),
    log: state.log.slice(),
  };
}

/** Newest version of a line that still exists anywhere. */
export function newestVer(state, line) {
  const c = state.cache[line];
  const r = state.ram[line];
  return c.valid && c.ver > r.ver ? c.ver : r.ver;
}

/** Value of the newest surviving version of a line. */
function newestValue(state, line) {
  const c = state.cache[line];
  const r = state.ram[line];
  return c.valid && c.ver > r.ver ? c.value : r.value;
}

/**
 * What an observer would get if it read the line now, without changing anything.
 * Returns {value, ver, from: "cache"|"ram", stale}.
 */
export function peek(state, who, line) {
  const c = state.cache[line];
  const r = state.ram[line];
  let got;
  if (who === "vmm" || coherent(state)) {
    got = c.valid ? { value: c.value, ver: c.ver, from: "cache" } : { value: r.value, ver: r.ver, from: "ram" };
  } else {
    got = { value: r.value, ver: r.ver, from: "ram" };
  }
  return { ...got, stale: got.ver < newestVer(state, line) };
}

function validLine(line) {
  return Number.isInteger(line) && line >= 0 && line < LINES;
}

function validByte(v) {
  return Number.isInteger(v) && v >= 0 && v <= 0xff;
}

/** Validate one action object. Returns an error string or null. */
export function checkAction(a) {
  if (a === null || typeof a !== "object") return "action must be an object";
  switch (a.op) {
    case "write":
      if (!validByte(a.value)) return "value must be a byte (0x00 to 0xFF)";
    // fall through
    case "read":
      if (a.who !== "vmm" && a.who !== "guest") return "who must be vmm or guest";
      break;
    case "clean":
    case "inval":
    case "cleaninval":
    case "evict":
      break;
    default:
      return `unknown operation ${String(a.op)}`;
  }
  if (!validLine(a.line)) return `line must be 0 to ${LINES - 1}`;
  return null;
}

const WHO = { vmm: "VMM", guest: "Guest" };

/** Plain-language name of an action, as shown in the log. */
export function describeAction(a) {
  const where = `line ${a.line} (${lineAddress(a.line)})`;
  switch (a.op) {
    case "write":
      return `${WHO[a.who]} writes ${hex8(a.value)} to ${where}`;
    case "read":
      return `${WHO[a.who]} reads ${where}`;
    case "clean":
      return `Clean ${where} to the PoC (DC CVAC)`;
    case "inval":
      return `Invalidate ${where} (DC IVAC)`;
    case "cleaninval":
      return `Clean and invalidate ${where} (DC CIVAC)`;
    case "evict":
      return `The cache evicts ${where} on its own`;
    default:
      return "unknown action";
  }
}

// --- the core state machine -------------------------------------------------------------

function doClean(s, line) {
  const c = s.cache[line];
  if (c.valid && c.dirty) {
    s.ram[line] = { value: c.value, ver: c.ver };
    c.dirty = false;
    return true;
  }
  return false;
}

function doInval(s, line) {
  const c = s.cache[line];
  const hadDirty = c.valid && c.dirty;
  const was = { ...c };
  s.cache[line] = { valid: false, dirty: false, value: 0, ver: 0 };
  return { hadDirty, was };
}

/**
 * Apply one action and return the next state, with one event appended to `log`.
 * Event: {text, kind: "ok"|"stale"|"lost"|"info", detail, fix}.
 * An invalid action returns the state unchanged with an "error" event.
 */
export function apply(state, action) {
  const err = checkAction(action);
  const s = clone(state);
  if (err) {
    pushLog(s, { text: "Ignored an invalid action", kind: "error", detail: err, fix: null });
    return s;
  }
  const { op, line } = action;
  const before = newestVer(s, line);
  const beforeValue = newestValue(s, line);
  const c = s.cache[line];
  let ev;

  switch (op) {
    case "write": {
      const ver = s.nextVer++;
      if (action.who === "vmm" || coherent(s)) {
        if (action.who === "guest" && !c.valid) {
          // Coherent guest write to a line the VMM does not hold: it lands in RAM (or a
          // cache we do not draw); either way every observer sees it next.
          s.ram[line] = { value: action.value, ver };
          ev = { kind: "ok", detail: `${hex8(action.value)} is in RAM; both observers will see it.` };
        } else {
          s.cache[line] = { valid: true, dirty: true, value: action.value, ver };
          ev = {
            kind: "ok",
            detail:
              action.who === "vmm" && !coherent(s)
                ? `${hex8(action.value)} sits dirty in the VMM's cache. RAM still holds ${hex8(s.ram[line].value)} until a clean or an eviction writes it back.`
                : action.who === "guest" && s.guest === "off"
                  ? `${hex8(action.value)} is written; as measured, the VMM will see it too.`
                  : `${hex8(action.value)} sits dirty in the shared cache; both observers will see it.`,
          };
        }
      } else {
        // MMU-off guest store: Device access, straight to RAM, around the cache.
        s.ram[line] = { value: action.value, ver };
        ev = {
          kind: "ok",
          detail: c.valid
            ? `${hex8(action.value)} went straight to RAM, around the cache. The VMM's cached copy (${hex8(c.value)}) is now old, and nothing tells the cache.`
            : `${hex8(action.value)} went straight to RAM, around the cache.`,
        };
      }
      break;
    }
    case "read": {
      const who = action.who;
      const usesCache = who === "vmm" || coherent(s);
      let got;
      if (usesCache && c.valid) {
        // Name the source by what the lab knows. The VMM hits its own cache; an MMU-on guest
        // shares that cache; for the measured Apple Silicon mode only the outcome is known.
        const from =
          who === "vmm"
            ? "its cache (hit)"
            : s.guest === "on"
              ? "the shared cache"
              : "the newest copy (as measured: the guest sees the VMM's writes)";
        got = { value: c.value, ver: c.ver, from };
      } else {
        got = { value: s.ram[line].value, ver: s.ram[line].ver, from: "RAM" };
        if (who === "vmm") {
          // Read miss: the line is allocated, clean.
          s.cache[line] = { valid: true, dirty: false, value: got.value, ver: got.ver };
          got.from = "RAM (miss; the line is now cached)";
        }
      }
      const stale = got.ver < before;
      if (stale) {
        const fix =
          who === "vmm"
            ? "After the guest's write and before reading, invalidate (or clean and invalidate) the VMM's line, so the next read misses and fetches the guest's write from RAM. Not earlier: the core may refetch the line speculatively at any time. A VMM running as a macOS process uses clean and invalidate (DC CIVAC), since plain invalidate needs EL1."
            : "Clean the VMM's dirty line to the PoC, so RAM holds the newest value before the guest reads it.";
        ev = {
          kind: "stale",
          detail: `Got ${hex8(got.value)} from ${got.from}. Stale: the newest value is ${hex8(beforeValue)}.`,
          fix,
          got: got.value,
        };
      } else {
        ev = { kind: "ok", detail: `Got ${hex8(got.value)} from ${got.from}. That is the newest value.`, got: got.value };
      }
      break;
    }
    case "clean": {
      const wrote = doClean(s, line);
      ev = {
        kind: "info",
        detail: wrote
          ? `Wrote ${hex8(c.value)} back to RAM. The line stays cached, now clean.`
          : c.valid
            ? "The line is clean, so there was nothing to write back. A clean never fixes the VMM's own stale copy."
            : "The VMM holds no copy of this line, so there was nothing to clean.",
      };
      break;
    }
    case "inval": {
      const { hadDirty, was } = doInval(s, line);
      ev = {
        kind: "info",
        detail: hadDirty
          ? `Dropped the dirty line holding ${hex8(was.value)} without writing it back.`
          : was.valid
            ? "Dropped the VMM's copy. Its next read will miss and come from RAM."
            : "The VMM holds no copy of this line, so there was nothing to drop.",
      };
      break;
    }
    case "cleaninval":
    case "evict": {
      const val = c.value;
      const wrote = doClean(s, line);
      const { was } = doInval(s, line);
      const who = op === "evict" ? "The cache chose to push this line out. " : "";
      ev = {
        kind: "info",
        detail: wrote
          ? `${who}Wrote ${hex8(val)} back to RAM, then dropped the line.`
          : was.valid
            ? `${who}The line was clean; it was dropped and RAM is unchanged.`
            : "The VMM holds no copy of this line, so nothing happened.",
      };
      break;
    }
  }

  const after = newestVer(s, line);
  if (after < before) {
    ev.kind = "lost";
    ev.detail += ` Write lost: ${hex8(beforeValue)} no longer exists anywhere; the line now reads ${hex8(newestValue(s, line))}.`;
    ev.fix =
      op === "inval"
        ? "Use clean and invalidate when the line might be dirty: invalidate alone throws away writes."
        : "Two observers wrote the same line, and an older dirty copy overwrote a newer write in RAM. Clean and invalidate before handing a buffer to the other side, and do not touch it until it comes back.";
  }

  // The share string replays `actions` from a fresh state, so history is never trimmed:
  // dropping the oldest action would make a link rebuild a different machine. Past the cap
  // the state simply stops being shareable.
  s.lastOp = op;
  if (s.actions.length < MAX_ACTIONS) s.actions.push(action);
  else s.overflow = true;
  pushLog(s, { text: describeAction(action), fix: null, ...ev });
  return s;
}

function pushLog(s, ev) {
  s.log.push(ev);
  if (s.log.length > MAX_LOG) s.log.shift();
}

/** Apply the next pending scenario step, if any. */
export function step(state) {
  if (state.pending.length === 0) return state;
  const [next, ...rest] = state.pending;
  const s = apply(state, next);
  s.pending = rest;
  return s;
}

/** Change platform or guest mode. Starts over (the history would mean something else). */
export function setMode(state, platform, guest) {
  const s = initialState(platform, guest);
  return s;
}

// --- scenarios -----------------------------------------------------------------------------

export const SCENARIOS = [
  {
    id: "loader",
    title: "Loader copies a kernel, no clean",
    goal: "The VMM writes the first bytes of an Image, then the MMU-off guest starts and reads them. Predict what the guest reads, then fix it with one operation.",
    platform: "arch",
    guest: "off",
    steps: [
      { op: "write", who: "vmm", line: 0, value: 0x4d },
      { op: "write", who: "vmm", line: 1, value: 0x5a },
      { op: "read", who: "guest", line: 0 },
    ],
  },
  {
    id: "guest-writes",
    title: "Guest writes, VMM reads an old line",
    goal: "The VMM has read a line, so it is cached. The guest then stores 0xAB with its MMU off. Predict what the VMM's next read returns.",
    platform: "arch",
    guest: "off",
    steps: [
      { op: "read", who: "vmm", line: 1 },
      { op: "write", who: "guest", line: 1, value: 0xab },
      { op: "read", who: "vmm", line: 1 },
    ],
  },
  {
    id: "invalidate-loses",
    title: "Invalidate throws a write away",
    goal: "The VMM writes a line, then someone invalidates it instead of cleaning it. Predict what the guest reads.",
    platform: "arch",
    guest: "off",
    steps: [
      { op: "write", who: "vmm", line: 2, value: 0x42 },
      { op: "inval", line: 2 },
      { op: "read", who: "guest", line: 2 },
    ],
  },
  {
    id: "both-write",
    title: "Both sides write one line",
    goal: "The VMM leaves a dirty line, the guest writes the same line in RAM, then the VMM cleans. Predict whose write survives.",
    platform: "arch",
    guest: "off",
    steps: [
      { op: "write", who: "vmm", line: 3, value: 0x11 },
      { op: "write", who: "guest", line: 3, value: 0x22 },
      { op: "clean", line: 3 },
      { op: "read", who: "guest", line: 3 },
    ],
  },
  {
    id: "measured",
    title: "The loader on Apple Silicon (measured)",
    goal: "The same loader steps, with the behaviour chapter 04's memtest observed under Hypervisor.framework. Predict what the guest reads now.",
    platform: "apple",
    guest: "off",
    steps: [
      { op: "write", who: "vmm", line: 0, value: 0x4d },
      { op: "write", who: "vmm", line: 1, value: 0x5a },
      { op: "read", who: "guest", line: 0 },
    ],
  },
];

/** Load a scenario: fresh state in its mode, all steps pending. */
export function loadScenario(id) {
  const sc = SCENARIOS.find((x) => x.id === id);
  if (!sc) throw new RangeError(`unknown scenario ${id}`);
  const s = initialState(sc.platform, sc.guest);
  s.pending = sc.steps.map((a) => ({ ...a }));
  s.scenario = sc.id;
  return s;
}

/** Run a list of actions from a fresh state. */
export function run(platform, guest, actions) {
  return actions.reduce((s, a) => apply(s, a), initialState(platform, guest));
}

// --- share state ---------------------------------------------------------------------------
//
// Format: <platform>.<guest>.<applied>[.<scenario>~<pending>]
//   applied / pending: actions joined by "_", each one of
//     vw<line>-<hh>  vr<line>  gw<line>-<hh>  gr<line>  c<line>  i<line>  ci<line>  e<line>
//   e.g. "arch.off.vw0-4d_gr0" or "arch.off.vr1.guest-writes~gw1-ab_vr1".

const CODE = { clean: "c", inval: "i", cleaninval: "ci", evict: "e" };
const OP_OF = { c: "clean", i: "inval", ci: "cleaninval", e: "evict" };

export function encodeAction(a) {
  if (a.op === "write") return `${a.who === "vmm" ? "v" : "g"}w${a.line}-${a.value.toString(16).padStart(2, "0")}`;
  if (a.op === "read") return `${a.who === "vmm" ? "v" : "g"}r${a.line}`;
  return `${CODE[a.op]}${a.line}`;
}

const ACTION_RE = /^(?:([vg])w([0-9])-([0-9a-f]{2})|([vg])r([0-9])|(ci|c|i|e)([0-9]))$/;

/** Parse one action code. Returns an action or null. */
export function decodeAction(code) {
  const m = ACTION_RE.exec(code);
  if (!m) return null;
  let a;
  if (m[1]) a = { op: "write", who: m[1] === "v" ? "vmm" : "guest", line: Number(m[2]), value: parseInt(m[3], 16) };
  else if (m[4]) a = { op: "read", who: m[4] === "v" ? "vmm" : "guest", line: Number(m[5]) };
  else a = { op: OP_OF[m[6]], line: Number(m[7]) };
  return checkAction(a) ? null : a;
}

function decodeList(str) {
  if (str === "") return [];
  const parts = str.split("_");
  if (parts.length > MAX_ACTIONS) return null;
  const out = [];
  for (const p of parts) {
    const a = decodeAction(p);
    if (!a) return null;
    out.push(a);
  }
  return out;
}

/** Share string for a state, or null when the history is too long to replay (see apply). */
export function encodeState(state) {
  if (state.overflow || state.actions.length > MAX_ACTIONS) return null;
  let s = `${state.platform}.${state.guest}.${state.actions.map(encodeAction).join("_")}`;
  if (state.scenario && state.pending.length > 0) {
    s += `.${state.scenario}~${state.pending.map(encodeAction).join("_")}`;
  }
  return s;
}

/**
 * Parse a share string into a state, replaying the applied actions. Returns null for anything
 * malformed (wrong shape, unknown names, too long, a bad action): the caller then starts fresh.
 */
export function decodeState(str) {
  if (typeof str !== "string" || str.length === 0 || str.length > MAX_HASH) return null;
  const parts = str.split(".");
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [platform, guest, applied, rest] = parts;
  if (!PLATFORMS.includes(platform) || !GUEST_MODES.includes(guest)) return null;
  const actions = decodeList(applied);
  if (!actions) return null;
  let scenario = null;
  let pending = [];
  if (rest !== undefined) {
    const tilde = rest.indexOf("~");
    if (tilde < 0) return null;
    scenario = rest.slice(0, tilde);
    if (!SCENARIOS.some((x) => x.id === scenario)) return null;
    pending = decodeList(rest.slice(tilde + 1));
    if (!pending) return null;
  }
  const s = run(platform, guest, actions);
  s.scenario = scenario;
  s.pending = pending;
  return s;
}

/** A byte to suggest for the next write, so repeated writes are easy to tell apart. */
export function suggestValue(state) {
  return (0xa0 + state.nextVer) & 0xff || 0x01;
}

/** Parse a hex byte typed by the reader ("ab", "0xAB", "0x_ab"). Returns a number or null. */
export function parseByte(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().toLowerCase().replace(/_/g, "").replace(/^0x/, "");
  if (!/^[0-9a-f]{1,2}$/.test(t)) return null;
  return parseInt(t, 16);
}

/** The reference table: which operation fixes which direction, and which can lose a write. */
export const OPERATIONS = [
  {
    op: "clean",
    name: "Clean",
    insn: "DC CVAC",
    fixes: "VMM wrote, guest reads: pushes the VMM's dirty line to RAM.",
    risk: "Can overwrite a newer write in RAM if the other side wrote the same line.",
  },
  {
    op: "inval",
    name: "Invalidate",
    insn: "DC IVAC",
    fixes:
      "Guest wrote, VMM reads: drops the VMM's old copy. Do it after the guest's write and before the VMM reads: the core may refetch the line speculatively at any time.",
    risk: "Loses the VMM's own write if the line was dirty. Needs EL1: a VMM running as a macOS process cannot use it, and uses DC CIVAC instead, which on a clean line does the same.",
  },
  {
    op: "cleaninval",
    name: "Clean and invalidate",
    insn: "DC CIVAC",
    fixes: "Both directions, in that order. The safe choice when unsure.",
    risk: "Same as clean if the other side wrote the line meanwhile.",
  },
];
