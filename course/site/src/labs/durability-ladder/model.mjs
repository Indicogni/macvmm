// durability-ladder model: one guest fsync() of an appended 4 KiB block, followed down the five
// rungs of the `block-storage` primer's ladder, then a failure that wipes the top rungs.
//
// Pure ES module: no DOM, no I/O, so `node --test` imports it and the view only renders what
// `replay()` returns. See course/site/LABS.md section 3.
//
// Sources, so the toy cannot drift from the course:
// - The five rungs, and which failure reaches which rung: course/primers/block-storage.md,
//   "The durability ladder" (its ASCII ladder and the "Which failures does each rung survive?"
//   paragraph). `model.test.mjs` re-reads the primer and checks every rung name and loss line.
// - The request sequence: ext4's journal commit as the primer's "Under the hood" note and
//   chapter 18 ("ext4 writes its journal, sends FLUSH, and only then writes the commit record")
//   describe it: OUT data, OUT journal entry, FLUSH, OUT commit record, FLUSH.
// - What the VMM does with FLUSH: crates/vmm/src/virtio/blk.rs (`blk_write_path`: write-through
//   syncs after every OUT when FLUSH was not negotiated) and crates/vmm/src/backend/file.rs
//   (`DiskFile::sync` = `File::sync_all` = `fcntl(F_FULLFSYNC)` on macOS). The two other choices
//   are chapter 18's two edited builds: plain `fsync(2)` and a sync that does nothing.
// - Measured costs and the kill -9 result: captures/18-flush-*.txt and captures/18-kill9-after.txt
//   (checked against the captures by the tests).

/** The five rungs, top (fastest, most fragile) to bottom. `n` is the rung number in the primer. */
export const RUNGS = [
  { n: 1, id: "guest", name: "Guest page cache", where: "guest RAM, memory the VMM process allocated" },
  { n: 2, id: "vmm", name: "Request in flight in the VMM", where: "taken off the virtqueue, not yet passed to pwrite()" },
  { n: 3, id: "host", name: "Host page cache", where: "host RAM, owned by the macOS kernel" },
  { n: 4, id: "drive", name: "SSD's volatile cache", where: "RAM inside the drive" },
  { n: 5, id: "flash", name: "Flash", where: "storage that survives a power cut" },
];

/** The guest blocks this one fsync() touches. Order is display order. */
export const BLOCKS = [
  { id: "d", name: "data block", long: "the 4 KiB the program appended, written to its place on the disk" },
  { id: "j", name: "journal entry", long: "a copy of the file's updated inode (new size, new block), written to the journal" },
  { id: "c", name: "commit record", long: "the journal block that says the entry before it is complete and valid" },
  { id: "m", name: "inode in place", long: "the inode at its home location; ext4 copies it there later (a checkpoint), not during fsync()" },
];
export const MOVABLE = ["d", "j", "c"]; // "m" stays dirty in the guest for the whole run

/** What the VMM calls when the guest sends FLUSH (or, write-through, after every OUT). */
export const SYNCS = [
  { id: "full", label: "F_FULLFSYNC (File::sync_all, what macvmm does)", call: "fcntl(F_FULLFSYNC)", short: "F_FULLFSYNC" },
  { id: "fsync", label: "plain fsync() (faster, stops at the drive's cache)", call: "fsync()", short: "fsync" },
  { id: "none", label: "nothing (pretend it is done)", call: "nothing", short: "nothing" },
];

/**
 * Measured on the reference Mac in chapter 18: one 64 MiB write with a single flush, then 100
 * flushed 4 KiB writes, busybox `time` in the guest (rounded to 10 ms). The test re-reads each
 * capture's two `real` lines. All three were taken with FLUSH negotiated (write-back), so the
 * view shows them only in that mode: write-through syncs after every OUT instead.
 */
export const MEASURED = {
  full: { capture: "18-flush-full.txt", bulk: "0.09", hundred: "0.47" },
  fsync: { capture: "18-flush-fsync.txt", bulk: "0.19", hundred: "0.08" },
  none: { capture: "18-flush-noop.txt", bulk: "0.08", hundred: "0.04" },
};

/** The failures. `loses` = every rung with n <= loses is wiped. */
export const FAILURES = [
  { id: "g", button: "Guest kernel crashes", loses: 1, what: "The guest kernel panics. Its page cache is gone; the VMM keeps running and finishes the requests it already took." },
  { id: "k", button: "Process killed (kill -9)", loses: 2, what: "The VMM process dies, and the guest with it, because guest RAM is the process's memory. Rung 1 and any request still at rung 2 are gone. The macOS kernel keeps its page cache and writes it back regardless." },
  { id: "m", button: "macOS crashes", loses: 3, what: "The Mac's kernel crashes. The host page cache is gone with it; the drive stays powered and keeps what is in its own cache." },
  { id: "p", button: "Power lost", loses: 4, what: "The power goes. Only what reached flash survives; the drive's volatile cache is lost too." },
];

/** Which call moves a block past each rung (the primer's arrows). Index = rung n - 1. */
export const MOVED_BY = [
  "the guest driver sends a virtio OUT request",
  "pwrite() returns: the host kernel has copied the data",
  "fsync(), or macOS writing back on its own",
  "F_FULLFSYNC, or the drive writing back on its own, in any order",
  "nothing: it survives",
];

export const MAX_ACTIONS = 64;

const syncById = (id) => SYNCS.find((s) => s.id === id) || null;
export const failureById = (id) => FAILURES.find((f) => f.id === id) || null;
export const blockById = (id) => BLOCKS.find((b) => b.id === id) || null;

/**
 * The scripted sequence, one entry per "Next step". `flush` is whether the device offered
 * VIRTIO_BLK_F_FLUSH (and the driver accepted it). Each step is { id, who, title, text(sync), apply }.
 * `apply(world, sync)` mutates a fresh copy of the world.
 */
export function scriptFor(flush) {
  // macvmm always offers VIRTIO_BLK_F_FLUSH; it is write-through only when the driver does not
  // accept it (blk.rs `ack_features`), so the text says "negotiated", not "offered".
  const write = {
    id: "write", who: "guest program", title: "program calls write()",
    text: () => "write() appends 4 KiB to a log file and returns at once. The new bytes and the updated inode sit in the guest's page cache as dirty pages; nothing has left guest RAM.",
    apply: (w) => { w.levels.d = 1; w.levels.m = 1; },
  };
  const send1 = {
    id: "send1", who: "guest kernel", title: "fsync(): OUT data, OUT journal entry",
    text: () => "The program calls fsync(). ext4 copies the updated inode into a journal entry, and the virtio driver sends two OUT requests: the data block and the journal entry. The VMM takes both off the queue.",
    apply: (w) => { w.levels.d = 2; w.levels.j = 2; },
  };
  const send2 = {
    id: "send2", who: "guest kernel", title: "OUT commit record",
    text: () => flush
      ? "Only after that FLUSH completed does ext4 write the commit record. The driver sends an OUT for it, and the VMM takes it off the queue."
      : "ext4 waited for both OUTs to complete; there is no FLUSH to send. It writes the commit record, the driver sends an OUT for it, and the VMM takes it off the queue.",
    apply: (w) => { w.levels.c = 2; },
  };
  const ret = {
    id: "return", who: "guest program", title: "fsync() returns 0",
    text: () => "fsync() returns 0. The program, and whoever it reports to, now believe the 4 KiB survive anything.",
    apply: (w) => { w.acked = true; },
  };
  if (flush) {
    return [
      write,
      send1,
      {
        id: "pwrite1", who: "VMM", title: "pwrite() both, complete both OUTs",
        text: () => "pwrite() copies both blocks into the host page cache and returns. FLUSH was negotiated, so the device is write-back: it completes both OUT requests now.",
        apply: (w) => { lift(w, ["d", "j"], 2, 3); },
      },
      {
        id: "flush1", who: "guest kernel, then VMM", title: "FLUSH",
        text: (s) => `The driver sends FLUSH: every write completed so far must be durable. The VMM calls ${syncById(s).call}, then completes the FLUSH.`,
        apply: (w, s) => { sync(w, s); },
      },
      send2,
      {
        id: "pwrite2", who: "VMM", title: "pwrite() the commit record, complete it",
        text: () => "pwrite() puts the commit record in the host page cache; the VMM completes the OUT.",
        apply: (w) => { lift(w, ["c"], 2, 3); },
      },
      {
        id: "flush2", who: "guest kernel, then VMM", title: "second FLUSH",
        text: (s) => `A second FLUSH, so the commit record itself is durable. The VMM calls ${syncById(s).call} and completes it.`,
        apply: (w, s) => { sync(w, s); },
      },
      ret,
    ];
  }
  return [
    write,
    send1,
    {
      id: "pwrite1", who: "VMM", title: "pwrite() and sync each, then complete",
      text: (s) => `pwrite() copies both blocks into the host page cache. FLUSH was not negotiated (not offered, or not accepted by the driver), so the device is write-through: the VMM calls ${syncById(s).call} after each write, before completing that OUT.`,
      apply: (w, s) => { lift(w, ["d"], 2, 3); sync(w, s); lift(w, ["j"], 2, 3); sync(w, s); },
    },
    send2,
    {
      id: "pwrite2", who: "VMM", title: "pwrite() the commit record, sync, complete",
      text: (s) => `pwrite() puts the commit record in the host page cache, the VMM calls ${syncById(s).call}, then completes the OUT.`,
      apply: (w, s) => { lift(w, ["c"], 2, 3); sync(w, s); },
    },
    ret,
  ];
}

function lift(w, ids, from, to) {
  for (const id of ids) if (w.levels[id] === from) w.levels[id] = to;
}

/** The VMM's sync of the image file. Moves blocks of this file only; never upward. */
function sync(w, s) {
  w.syncs += 1;
  if (s === "fsync") lift(w, MOVABLE, 3, 4);
  else if (s === "full") { lift(w, MOVABLE, 3, 5); lift(w, MOVABLE, 4, 5); }
}

export function initialState(flush = true, syncMode = "full") {
  return { flush: !!flush, sync: syncMode, actions: [] };
}

function freshWorld() {
  return { levels: { d: 0, j: 0, c: 0, m: 0 }, step: 0, acked: false, syncs: 0, failed: null };
}

const cloneWorld = (w) => ({ ...w, levels: { ...w.levels } });

/** Every action token: "n" (next step), "h<b>" (macOS writes block b back to the drive),
 *  "d<b>" (the drive writes block b to flash), "x<f>" (failure f). */
export function isToken(t) {
  return t === "n" || /^[hd][djc]$/.test(t) || /^x[gkmp]$/.test(t);
}

/** Why `token` is not allowed in `world`, or null if it is. */
export function refusal(world, token, script) {
  if (!isToken(token)) return "unknown action";
  if (world.failed) return "the run is over: undo or reset";
  if (token === "n") return world.step < script.length ? null : "fsync() has already returned";
  if (token[0] === "x") return null;
  const b = token[1];
  if (token[0] === "h") return world.levels[b] === 3 ? null : `the ${blockById(b).name} is not in the host page cache`;
  return world.levels[b] === 4 ? null : `the ${blockById(b).name} is not in the drive's cache`;
}

/** Apply one token to a world (returns a new world and a history row), or null if refused. */
export function applyToken(world, token, state, script = scriptFor(state.flush)) {
  if (refusal(world, token, script) !== null) return null;
  const w = cloneWorld(world);
  let row;
  if (token === "n") {
    const s = script[w.step];
    s.apply(w, state.sync);
    w.step += 1;
    row = { kind: "step", who: s.who, title: s.title, text: s.text(state.sync) };
  } else if (token[0] === "h") {
    w.levels[token[1]] = 4;
    const b = blockById(token[1]);
    row = { kind: "writeback", who: "macOS", title: `writes the ${b.name} back`, text: `On its own schedule, macOS writes the ${b.name} from its page cache to the drive. The drive keeps it in its volatile cache for now.` };
  } else if (token[0] === "d") {
    w.levels[token[1]] = 5;
    const b = blockById(token[1]);
    row = { kind: "writeback", who: "drive", title: `writes the ${b.name} to flash`, text: `On its own schedule, and in any order it likes, the drive writes the ${b.name} from its cache to flash.` };
  } else {
    const f = failureById(token[1]);
    w.failed = f.id;
    row = { kind: "failure", who: "failure", title: f.button, text: f.what };
  }
  return { world: w, row };
}

/** Replay a state's actions. `refused` is the index of the first refused action, or -1. */
export function replay(state) {
  const script = scriptFor(state.flush);
  let world = freshWorld();
  const rows = [];
  let refused = -1;
  for (let i = 0; i < state.actions.length; i++) {
    const r = applyToken(world, state.actions[i], state, script);
    if (!r) { refused = i; break; }
    world = r.world;
    rows.push(r.row);
  }
  const outcome = world.failed ? recover(world) : null;
  return { world, rows, refused, script, outcome, next: world.failed ? null : script[world.step] || null };
}

/** Where each block ends up after the failure: true if its newest copy survived. */
export function survivors(world) {
  const f = failureById(world.failed);
  const out = {};
  for (const b of BLOCKS) out[b.id] = world.levels[b.id] > f.loses;
  return out;
}

export const VERDICTS = {
  ok: { label: "Consistent, new version", short: "new version" },
  old: { label: "Consistent, old version, nothing promised was lost", short: "old version, nothing promised lost" },
  lost: { label: "Consistent, old version, but a promised write is lost", short: "old version, a promised write lost" },
  corrupt: { label: "Inconsistent: commit record without its journal entry", short: "inconsistent" },
  stale: { label: "Inconsistent: new inode, old data", short: "inconsistent" },
};

/**
 * What ext4's journal recovery finds on the disk that survives (what the guest sees when it
 * boots again). Returns { verdict, text, survived }.
 */
export function recover(world) {
  const s = survivors(world);
  let verdict;
  let text;
  if (!s.c) {
    if (world.acked) {
      verdict = "lost";
      text = "No commit record survived, so recovery ignores the transaction and the file is as it was before write(). The file system is consistent. But fsync() had returned 0: the program was promised these 4 KiB, and they are gone.";
    } else {
      verdict = "old";
      text = world.levels.d === 0
        ? "Nothing had been written yet. The file is as it was."
        : world.levels.j === 0
          ? "Nothing had reached the disk: the new bytes were only in the guest's page cache, and no journal entry had been written. The file is as it was, and fsync() never returned, so nothing that was promised is lost."
          : "No commit record survived, so recovery ignores the half-finished transaction and the file is as it was before write(). The file system is consistent, and fsync() never returned, so nothing that was promised is lost.";
    }
  } else if (!s.j) {
    verdict = "corrupt";
    text = "The commit record survived but the journal entry it vouches for did not. The disk holds a state ext4 never wrote: recovery copies whatever that journal block held before over the inode, or, with journal checksums on (the default today), detects the bad block and stops with an error. Either way the file system needs repair.";
  } else if (!s.d) {
    verdict = "stale";
    text = "The journal transaction is complete, so recovery installs the new inode, but the data block it now points to never reached storage. The file's last 4 KiB are whatever that block held before, possibly another file's old bytes.";
  } else {
    verdict = "ok";
    text = "Recovery finds a complete transaction (entry, then commit record) and copies the journal's inode into place. The file has its new 4 KiB.";
  }
  return { verdict, text, survived: s };
}

/** Can `token` be applied to the current state? */
export function canDo(state, token) {
  const r = replay(state);
  return refusal(r.world, token, r.script) === null;
}

/**
 * Reducer. Actions: {type:"do", token}, {type:"undo"}, {type:"reset"},
 * {type:"config", flush?, sync?} (keeps the longest still-valid prefix of the run).
 * Returns the same object when nothing changes.
 */
export function step(state, action) {
  switch (action?.type) {
    case "do": {
      if (state.actions.length >= MAX_ACTIONS || !canDo(state, action.token)) return state;
      return { ...state, actions: [...state.actions, action.token] };
    }
    case "undo":
      return state.actions.length ? { ...state, actions: state.actions.slice(0, -1) } : state;
    case "reset":
      return state.actions.length ? { ...state, actions: [] } : state;
    case "config": {
      const flush = action.flush === undefined ? state.flush : !!action.flush;
      const syncMode = action.sync === undefined ? state.sync : action.sync;
      if (!syncById(syncMode)) return state;
      if (flush === state.flush && syncMode === state.sync) return state;
      const next = { flush, sync: syncMode, actions: state.actions };
      const r = replay(next);
      return r.refused === -1 ? next : { ...next, actions: state.actions.slice(0, r.refused) };
    }
    default:
      return state;
  }
}

/** Where each block is right now, for the view: { rung n -> [block ids] }. */
export function ladder(world) {
  const out = { 1: [], 2: [], 3: [], 4: [], 5: [] };
  for (const b of BLOCKS) {
    const n = world.levels[b.id];
    if (n > 0) out[n].push(b.id);
  }
  return out;
}

/**
 * What each touched block's fate means, for the outcome box. The inode in place never leaves
 * the guest in this toy, so it is always lost; whether that matters depends on the journal.
 */
export function survivalLines(world, outcome) {
  const out = [];
  for (const b of BLOCKS) {
    if (world.levels[b.id] === 0) continue;
    let text = outcome.survived[b.id] ? "survived" : "lost";
    if (b.id === "m" && !outcome.survived.m) {
      const v = outcome.verdict;
      if (v === "ok" || v === "stale") text = "lost, rebuilt from the journal entry";
      else if (v === "corrupt") text = "lost, and recovery may overwrite the old one with whatever the journal block held";
      else text = "lost (the old one on disk is still valid)";
    }
    out.push({ id: b.id, text: `${b.name}: ${text}` });
  }
  return out;
}

/** A short sentence for screen readers: after a failure only the failure and the verdict
 *  (the full recovery text is in the outcome box), otherwise the summary. */
export function spoken(state) {
  const r = replay(state);
  if (r.outcome) return `${failureById(r.world.failed).button}. ${VERDICTS[r.outcome.verdict].label}. Details in "What the guest finds".`;
  return summary(state);
}

/** One plain paragraph: the visible readout. */
export function summary(state) {
  const r = replay(state);
  const w = r.world;
  if (r.outcome) {
    const f = failureById(w.failed);
    return `${f.button}. ${VERDICTS[r.outcome.verdict].label}. ${r.outcome.text}`;
  }
  if (!state.actions.length) {
    return `Nothing written yet. The VMM answers FLUSH with ${syncById(state.sync).short}${state.flush ? "" : ", and the device is write-through (FLUSH not negotiated)"}. Press Next step.`;
  }
  const where = MOVABLE.filter((b) => w.levels[b] > 0)
    .map((b) => `${blockById(b).name}: rung ${w.levels[b]}, ${RUNGS[w.levels[b] - 1].name.toLowerCase()}`);
  const last = r.rows[r.rows.length - 1];
  const head = `Step ${w.step} of ${r.script.length}. ${last.who === "failure" ? "" : `${last.who[0].toUpperCase()}${last.who.slice(1)} ${last.title}. `}`;
  return `${head}${where.length ? `${where.join("; ")}.` : "Only the guest's page cache holds the new bytes."}${w.acked ? " fsync() has returned." : ""}`;
}

// ---- share state ---------------------------------------------------------------------------

/** `<f|w>.<full|fsync|none>[.<tokens joined by _>]`, runs of "n" written as n<count>.
 *  The default (FLUSH negotiated, F_FULLFSYNC, nothing done) is null: it clears the hash. */
export function encode(state) {
  const head = `${state.flush ? "f" : "w"}.${state.sync}`;
  if (!state.actions.length) return state.flush && state.sync === "full" ? null : head;
  const out = [];
  for (const t of state.actions) {
    const prev = out[out.length - 1];
    if (t === "n" && prev && /^n\d+$/.test(prev)) out[out.length - 1] = `n${Number(prev.slice(1)) + 1}`;
    else out.push(t === "n" ? "n1" : t);
  }
  return `${head}.${out.join("_")}`;
}

/** Strict parser: a state, or null for anything it does not fully accept. */
export function decode(str) {
  if (typeof str !== "string" || str.length > 200) return null;
  const m = /^([fw])\.(full|fsync|none)(?:\.([a-z0-9_]{1,190}))?$/.exec(str);
  if (!m) return null;
  const actions = [];
  if (m[3] !== undefined) {
    for (const tok of m[3].split("_")) {
      const n = /^n([1-9][0-9]?)$/.exec(tok);
      if (n) {
        const k = Number(n[1]);
        if (actions.length + k > MAX_ACTIONS) return null;
        for (let i = 0; i < k; i++) actions.push("n");
      } else if (isToken(tok) && tok !== "n") {
        actions.push(tok);
      } else {
        return null;
      }
      if (actions.length > MAX_ACTIONS) return null;
    }
  }
  const state = { flush: m[1] === "f", sync: m[2], actions };
  if (replay(state).refused !== -1) return null;
  return state;
}

// ---- scenarios -----------------------------------------------------------------------------

/** Presets, walked with "Next step". `hash` is the finished run's share string. */
export const PRESETS = [
  {
    id: "honest-power", hash: "f.full.n8_xp", title: "macvmm's choice, then the power goes",
    goal: "F_FULLFSYNC on every FLUSH. Watch each FLUSH carry the blocks all the way to flash, then cut the power.",
  },
  {
    id: "fsync-power", hash: "f.fsync.n8_xp", title: "Plain fsync, then the power goes",
    goal: "fsync() stops at the drive. fsync() returns 0 to the program, then the power goes.",
  },
  {
    id: "fsync-reorder", hash: "f.fsync.n8_dc_xp", title: "Plain fsync, and the drive reorders",
    goal: "As before, but the drive writes the commit record to flash first, which it is allowed to do. Then the power goes.",
  },
  {
    id: "fsync-stale", hash: "f.fsync.n8_dj_dc_xp", title: "Plain fsync, the data block left behind",
    goal: "The drive writes the journal entry and the commit record to flash, but not the data block. Then the power goes.",
  },
  {
    id: "noop-kill", hash: "f.none.n8_xk", title: "FLUSH does nothing, then kill -9",
    goal: "Chapter 18's experiment: the do-nothing FLUSH, and the VMM killed right after fsync() returns.",
    real: {
      says: "Chapter 18 ran this on the do-nothing build: the guest's dd wrote \"macvmm\" lines at the 8 MiB mark with conv=fsync, the VMM was killed with kill -9, and the bytes were in the image file:",
      capture: "18-kill9-after.txt",
      quote: "00800000: 6d61 6376 6d6d 0a6d 6163 766d 6d0a 6d61  macvmm.macvmm.ma",
    },
  },
  {
    id: "noop-host", hash: "f.none.n8_hc_xm", title: "FLUSH does nothing, then macOS crashes",
    goal: "Everything sits in the host page cache. macOS happens to write the commit record back first, then crashes.",
  },
  {
    id: "kill-midway", hash: "f.full.n5_xk", title: "Killed while the commit record is in flight",
    goal: "F_FULLFSYNC, but the VMM is killed while the commit record is still a request in its hands.",
  },
  {
    id: "write-through", hash: "w.full.n6_xp", title: "FLUSH not negotiated: write-through",
    goal: "The driver did not accept FLUSH, so the device is write-through: the VMM syncs after every write before completing it. Then the power goes.",
  },
];

/** The reference share string (LABS.md lab list). */
export const REFERENCE = "f.fsync.n8_dc_xp";

/** The "which failure reaches which rung" table: rows = failures, cells = lost / survives. */
export function failureTable() {
  return FAILURES.map((f) => ({
    failure: f.button,
    cells: RUNGS.map((r) => (r.n <= f.loses ? "lost" : "survives")),
  }));
}
