// trap-or-not: sort ten guest actions into three buckets (chapter 01, "Sorting real guest actions").
//
// Pure logic, no DOM: the view renders `state` and turns events into `step(state, action)` calls.
//
// The ten actions, their order, the three bucket names and the reference answers are the lesson's
// own table (course/chapters/0/01-ffi.md). `model.test.mjs` parses that table and fails if the
// two drift apart, so edit both together.
//
// The lab is exploratory and unscored on purpose: the learner has met no Arm yet, so a score would
// reward guessing. After "Show feedback" each action says whether it sits where the reference puts
// it, so the learner can pick the ones they sorted differently, but the lab never totals them.

/** The three buckets, in the lesson's order. `label` is the lesson's wording. */
export const BUCKETS = Object.freeze([
  Object.freeze({
    id: "vmm",
    code: "v",
    label: "Stops and reaches our VMM",
    lesson: "reaches our VMM",
    hint: "The CPU stops the guest, and the macOS kernel hands the exit to our process.",
  }),
  Object.freeze({
    id: "kernel",
    code: "k",
    label: "Stops, but the macOS kernel handles it",
    lesson: "the kernel handles it",
    hint: "The guest stops, but the kernel's EL2 part deals with it and never tells us.",
  }),
  Object.freeze({
    id: "guest",
    code: "g",
    label: "Never leaves the guest",
    lesson: "never leaves the guest",
    hint: "The CPU completes it without stopping the guest, though the hardware may help.",
  }),
]);

/** The problem ledger rows the feedback cites (chapter 00's table, "The kernel assumes it owns..."). */
export const LEDGER = Object.freeze({
  1: "the processor's privileged state",
  2: "physical memory and its page tables",
  3: "devices at fixed addresses",
  4: "a way to power off, reboot, or start other processors",
  6: "interrupts from devices",
  7: "an alarm clock, to take turns and sleep",
});

/**
 * The ten guest actions. `plain` comes first (plain words), `insn` second (the Arm name, or null).
 * `answer` is a bucket id; `why` is the lesson's "What stops it, who handles it, and why" cell
 * (without its chapter pointers); `rows` are ledger rows; `def` is the one-line definition of the
 * instruction.
 *
 * Chapter 01's main idea is two supervisors with two different jobs, so the feedback answers two
 * separate questions instead of one "decided by": `stops` says what stops the guest and
 * `handles` says who then deals with it. Every `stops` that traps follows one template, "The
 * CPU, because <who> set it up to stop", so no card suggests that some exits are stopped by
 * software and others by hardware: the CPU always takes the exception, and only `hvc` stops by
 * its nature. `note` is the one extra line a card shows, only where the lesson's reasoning adds
 * something the two questions do not (str-uart's journal pointer, wfi's in-kernel interrupt
 * controller); `why` stays the lesson's cell word for word for the reference sort.
 */
export const ITEMS = Object.freeze(
  [
    {
      id: "ldr-ram",
      plain: "Load a value from RAM",
      insn: "ldr",
      def: "load a register from memory",
      answer: "guest",
      stops:
        "Normally nothing: the hardware translates the address and the guest keeps running. At most, the macOS kernel quietly brings the page into memory first; our VMM never hears of it.",
      handles: "The hardware, which translates the address and reads the memory.",
      note: null,
      why: "The hardware translates the address to memory our VMM gave the guest, without stopping.",
      chapters: ["05"],
      rows: [2],
    },
    {
      id: "str-uart",
      plain: "Store a byte to the serial port's address, 0x0900_0000",
      insn: "str",
      def: "store a register to memory",
      answer: "vmm",
      stops: "The CPU, because of a choice our VMM made when it set up the guest's memory (journal question 1 asks which); the kernel's EL2 part passes the exit on.",
      handles: "Our VMM, which plays the serial port.",
      note: 'Why this store stops when "Load a value from RAM" did not is your journal question 1.',
      // Deliberately shorter than the lesson's table row: why this store stops when the load does
      // not is journal question 1, so the lab leaves that answer to the learner. It names the load
      // card instead of saying "above": once sorted, the two cards may sit in different buckets.
      why: 'The CPU stops, EL2 forwards it, and we play the device. Why this store stops when "Load a value from RAM" did not is your journal question 1.',
      chapters: ["05", "07"],
      rows: [3],
    },
    {
      id: "wfi",
      plain: "Wait until an interrupt",
      insn: "wfi",
      def: "wait until an interrupt",
      answer: "kernel",
      stops: "The CPU, because the kernel's EL2 part set it up to trap wfi; the kernel then handles it itself.",
      handles: "The macOS kernel, which parks the vCPU; our VMM never hears of it.",
      note: "That is with the in-kernel interrupt controller this course uses. Without one (chapter 11's teaching mode), wfi reaches our VMM instead.",
      why: "With the in-kernel interrupt controller this course uses, the kernel parks the vCPU until an interrupt arrives, without asking us.",
      chapters: ["11", "12"],
      rows: [6, 7],
    },
    {
      id: "hvc",
      plain: "The guest kernel calls the level above",
      insn: "hvc",
      def: "call the level above",
      answer: "vmm",
      stops: "The CPU, by design: hvc is a call to EL2, the one action here that stops by its nature. (From an app at EL0 it is not allowed at all and goes to the guest kernel instead.)",
      note: null,
      handles: "Our VMM; the kernel's EL2 part passes it on (chapter 03 finds one small block of calls it answers itself).",
      why: "A deliberate call to EL2, forwarded; chapter 03 finds one small block of calls the kernel answers itself.",
      chapters: ["02", "03"],
      rows: [1, 4],
    },
    {
      id: "mrs-cntvct",
      plain: "Read the clock counter",
      insn: "mrs CNTVCT_EL0",
      def: "read a clock the hardware virtualizes",
      answer: "guest",
      stops: "Nothing: the read completes and the guest keeps running.",
      note: null,
      handles: "The hardware, which shows the guest its offset view of the counter.",
      why: "The hardware shows the guest its own offset view of the counter.",
      chapters: ["11"],
      rows: [7],
    },
    {
      id: "guest-page-fault",
      plain: "Touch a virtual address the guest kernel's own page tables do not map",
      insn: null,
      def: "a page fault in the guest's own tables",
      answer: "guest",
      stops: "Nothing leaves the guest: the CPU takes the guest kernel's own exception at EL1.",
      note: null,
      handles: "The guest kernel.",
      why: "The guest kernel's business, as in the os-basics primer: its own exception at EL1.",
      chapters: [],
      rows: [2],
    },
    {
      id: "svc",
      plain: "An app inside the guest asks its kernel for a service",
      insn: "svc",
      def: "call my own kernel",
      answer: "guest",
      stops: "Nothing leaves the guest: the CPU enters the guest kernel at EL1.",
      note: null,
      handles: "The guest kernel.",
      why: "An app calling its own kernel, inside the guest.",
      chapters: ["02"],
      rows: [1],
    },
    {
      id: "smc",
      plain: "The guest kernel calls the firmware",
      insn: "smc",
      def: "call the firmware",
      answer: "vmm",
      stops: "The CPU, because the kernel's EL2 part set it up to trap every smc. (From an app at EL0 it is not allowed at all and goes to the guest kernel instead.)",
      note: null,
      handles: "Our VMM; the kernel's EL2 part passes it on.",
      why: "The guest's machine has no firmware level of its own; EL2 is set to catch every smc and forwards it.",
      chapters: ["02"],
      rows: [4],
    },
    {
      id: "msr-oslar",
      plain: "Set the debugger's lock register",
      insn: "msr OSLAR_EL1",
      def: "write a system register",
      answer: "vmm",
      stops: "The CPU, because the kernel's EL2 part set it up to trap this debug register.",
      note: null,
      handles: "Our VMM, which chooses what the write does.",
      why: "EL2 traps this debug register and forwards it; we decide what it does.",
      chapters: ["08"],
      rows: [1],
    },
    {
      id: "str-gic",
      plain: "Store to the interrupt controller's registers",
      insn: null,
      def: "an ordinary store, to the interrupt controller's addresses",
      answer: "kernel",
      stops: "The CPU, because the kernel left the controller's addresses unmapped for the guest; the kernel's EL2 part takes it.",
      handles: "With the in-kernel interrupt controller this course uses, the macOS kernel emulates it itself.",
      note: null,
      why: "The kernel emulates the controller itself, so no exit reaches us.",
      chapters: ["12"],
      rows: [6],
    },
  ].map((item) => Object.freeze({ ...item, chapters: Object.freeze(item.chapters), rows: Object.freeze(item.rows) })),
);

const BUCKET_BY_ID = new Map(BUCKETS.map((b) => [b.id, b]));
const BUCKET_BY_CODE = new Map(BUCKETS.map((b) => [b.code, b]));
const ITEM_INDEX = new Map(ITEMS.map((it, i) => [it.id, i]));

/** Looks up a bucket by id; `null` for anything else. */
export function bucket(id) {
  return BUCKET_BY_ID.get(id) ?? null;
}

/** Looks up an item by id; `null` for anything else. */
export function item(id) {
  const i = ITEM_INDEX.get(id);
  return i === undefined ? null : ITEMS[i];
}

/**
 * The starting state: nothing sorted, feedback hidden.
 * `placed[i]` is the bucket id of ITEMS[i], or null while it is still unsorted.
 */
export function initialState() {
  return Object.freeze({ placed: Object.freeze(ITEMS.map(() => null)), revealed: false });
}

function withPlaced(state, index, value) {
  const placed = state.placed.slice();
  placed[index] = value;
  return Object.freeze({ ...state, placed: Object.freeze(placed) });
}

/**
 * Applies one action and returns the next state. Unknown actions, items or buckets return the
 * same state object, so a stale or hostile event can never corrupt it.
 *
 * Actions: {type:"place", item, bucket} · {type:"unplace", item} · {type:"reveal"} ·
 * {type:"hide"} · {type:"reset"}.
 */
export function step(state, action) {
  if (!action || typeof action !== "object") return state;
  switch (action.type) {
    case "place": {
      const i = ITEM_INDEX.get(action.item);
      if (i === undefined || !BUCKET_BY_ID.has(action.bucket)) return state;
      if (state.placed[i] === action.bucket) return state;
      return withPlaced(state, i, action.bucket);
    }
    case "unplace": {
      const i = ITEM_INDEX.get(action.item);
      if (i === undefined || state.placed[i] === null) return state;
      return withPlaced(state, i, null);
    }
    case "reveal":
      return state.revealed ? state : Object.freeze({ ...state, revealed: true });
    case "hide":
      return state.revealed ? Object.freeze({ ...state, revealed: false }) : state;
    case "reset":
      return initialState();
    default:
      return state;
  }
}

/** Items still unsorted, in lesson order. */
export function unsorted(state) {
  return ITEMS.filter((_, i) => state.placed[i] === null);
}

/** Items the learner put in `bucketId`, in lesson order. */
export function inBucket(state, bucketId) {
  return ITEMS.filter((_, i) => state.placed[i] === bucketId);
}

/** How many of the ten are sorted (progress, not a score). */
export function sortedCount(state) {
  return state.placed.filter((p) => p !== null).length;
}

/**
 * Per-item feedback status: "unsorted", "same" (where the reference puts it) or "different".
 * Deliberately per item only; the lab shows no total.
 */
export function status(state, itemId) {
  const i = ITEM_INDEX.get(itemId);
  if (i === undefined) return null;
  const p = state.placed[i];
  if (p === null) return "unsorted";
  return p === ITEMS[i].answer ? "same" : "different";
}

/** One plain-text feedback paragraph for an item, as the view and the live region speak it. */
export function feedbackText(state, itemId) {
  const it = item(itemId);
  if (!it) return "";
  const st = status(state, itemId);
  const ref = bucket(it.answer).label;
  const head =
    st === "unsorted"
      ? `Not sorted yet. The reference: ${ref}.`
      : st === "same"
        ? `Same as the reference: ${ref}.`
        : `Different. You chose: ${bucket(state.placed[ITEM_INDEX.get(itemId)]).label}. The reference: ${ref}.`;
  return `${head} ${it.why}`;
}

/** "Ledger row 2: physical memory and its page tables" (one or more rows). */
export function ledgerText(it) {
  const rows = it.rows.map((r) => `${r} (${LEDGER[r]})`);
  return `${rows.length > 1 ? "Ledger rows" : "Ledger row"} ${rows.join(" and ")}`;
}

/**
 * Where each "Next" pointer leads, relative to the course base (`/build-your-own/vmm/`). Fixed
 * strings only: nothing from the share hash ever becomes a link. The test checks them against
 * course/chapters.json.
 */
export const LINKS = Object.freeze({
  "02": "bare-machine/first-exit/",
  "03": "bare-machine/test-guests/",
  "05": "memory/address-space/",
  "07": "cpu/exit-loop/",
  "08": "cpu/traps-psci/",
  "11": "interrupts/timer-irq/",
  "12": "interrupts/gicv3/",
  "os-basics": "primers/os-basics/",
});

/**
 * The "Next" pointers for an item, as link parts: [{text, path}] (path relative to the course
 * base). An item no chapter goes further on points at the os-basics primer.
 */
export function nextLinks(it) {
  if (it.chapters.length === 0) return [{ text: "the os-basics primer", path: LINKS["os-basics"] }];
  return it.chapters.map((c) => ({ text: `chapter ${c}`, path: LINKS[c] }));
}

/** "Chapter 05", "Chapters 05 and 07", or "" when no chapter goes further. */
export function chaptersText(it) {
  const c = it.chapters;
  if (c.length === 0) return "";
  if (c.length === 1) return `More in chapter ${c[0]}`;
  return `More in chapters ${c.slice(0, -1).join(", ")} and ${c[c.length - 1]}`;
}

// ---- share state ------------------------------------------------------------------------------
//
// Format: ten characters, one per item in lesson order: "v" (our VMM), "k" (macOS kernel),
// "g" (never leaves the guest) or "-" (unsorted), then an optional "!" when feedback is shown.
// Example: "#trap-or-not=gvkvgggvvk!". Anything else decodes to null and the lab starts fresh.

const HASH_RE = /^[vkg-]{10}!?$/;

/** Encodes the state as the share string; null for the initial state (clears the hash). */
export function encode(state) {
  const body = state.placed.map((p) => (p === null ? "-" : bucket(p).code)).join("");
  const s = body + (state.revealed ? "!" : "");
  return s === "-".repeat(ITEMS.length) ? null : s;
}

/** Decodes a share string. Returns a state, or null if the string is not exactly the format. */
export function decode(str) {
  if (typeof str !== "string" || str.length > 11 || !HASH_RE.test(str)) return null;
  const placed = [];
  for (let i = 0; i < ITEMS.length; i++) {
    const ch = str[i];
    placed.push(ch === "-" ? null : BUCKET_BY_CODE.get(ch).id);
  }
  return Object.freeze({ placed: Object.freeze(placed), revealed: str.endsWith("!") });
}

/** The reference sort, as a state (used by tests and handy for a "show the reference" link). */
export function referenceState() {
  return Object.freeze({ placed: Object.freeze(ITEMS.map((it) => it.answer)), revealed: true });
}
