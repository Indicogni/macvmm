// lock-order model: a tiny scheduler-by-hand for threads, mutexes and one condition variable.
//
// The reader is the scheduler. Each thread runs a short script; one call to `step` runs one
// line of one thread. Everything a real mutex and condvar would do is modelled with the rules the
// `host-concurrency` primer teaches (Rust std::sync, POSIX pthread_mutex / pthread_cond):
//
//   - lock L    : if L is free, take it and move on. If another thread holds it, the thread goes
//                 to sleep on L ("blocked"). When L is unlocked every thread asleep on it becomes
//                 ready again and retries its lock on its next step.
//   - unlock L  : release L (the guard is dropped).
//   - wait      : must hold L. Releases L and sleeps on the condvar, atomically. A notify (or a
//                 spurious wake-up) makes it ready; its next step re-takes L, then it continues at
//                 `next` (the predicate check, when there is a loop).
//   - notify    : wakes one thread asleep on the condvar. With nobody asleep the notify is lost:
//                 it is not saved anywhere.
//   - check     : `while !flag`: if the flag is set, jump past the loop.
//   - set       : sets the flag (the caller holds the lock).
//   - print     : appends a line to the program's output. `needsFlag` marks the line that must
//                 never run before the flag is set (the bug a missing predicate loop allows).
//
// Pure ES module: no DOM, no globals, no I/O. The view only renders the state this file returns.
// See course/site/LABS.md section 3.

/** Hard caps, so a hostile share link cannot make us loop or allocate without bound. */
export const MAX_SCHEDULE = 200;
export const MAX_STATES = 20000;

// ---- scenarios -----------------------------------------------------------------------------

const lockLine = (l, v) => ({ op: "lock", lock: l, text: `let _${v} = ${l}.lock().unwrap();` });
const unlockLine = (l, v) => ({ op: "unlock", lock: l, text: `drop(_${v}); // unlocks ${l}` });

/**
 * A thread that takes two locks in the given order, prints, then drops the guards in reverse
 * order (Rust drops locals last-declared first). `vars` are the guard names (`d` for `_d`).
 */
function twoLockScript(first, second, vars, line) {
  return [
    lockLine(first, vars[first]),
    lockLine(second, vars[second]),
    { op: "print", out: line, text: `println!("${line}");` },
    unlockLine(second, vars[second]),
    unlockLine(first, vars[first]),
  ];
}

/**
 * The scenarios. Lock scenarios list each thread's lock order; the view's "swap" control reverses
 * one thread's order. Condvar scenarios have fixed scripts.
 */
export const SCENARIOS = {
  deadlock: {
    kind: "locks",
    title: "Two locks, opposite orders (deadlock.rs)",
    summary:
      "The primer's deadlock.rs. The vCPU thread takes device, then input; the stdin thread takes input, then device. The barrier that forced the bad timing is gone: you choose the timing.",
    locks: ["device", "input"],
    vars: { device: "d", input: "i" },
    threads: [
      { name: "vCPU thread", order: ["device", "input"], out: "vcpu got both" },
      { name: "stdin thread", order: ["input", "device"], out: "stdin got both" },
    ],
    finalLine: "done",
    challenge:
      "Challenge: get each thread to take its first lock before either takes its second (hint: alternate the Step buttons).",
    fix: "Fix it: press Swap on the stdin thread so both threads take device first, then try to deadlock it again, or press Try every schedule.",
  },
  ordered: {
    kind: "locks",
    title: "Two locks, one order (ordered.rs)",
    summary:
      "The primer's ordered.rs. Both threads take device, then input. Try to make them deadlock.",
    locks: ["device", "input"],
    vars: { device: "d", input: "i" },
    threads: [
      { name: "vCPU thread", order: ["device", "input"], out: "vcpu got both" },
      { name: "stdin thread", order: ["device", "input"], out: "stdin got both" },
    ],
    finalLine: "done",
    challenge:
      "Challenge: press the Step buttons in any order you like and look for a deadlock. When you give up, press Try every schedule to check them all.",
  },
  three: {
    kind: "locks",
    title: "Three threads, three locks (self-check)",
    summary:
      "The primer's self-check: thread 1 takes A then B, thread 2 takes B then C, thread 3 takes C then A. Can you close the cycle? Then swap thread 3 so it takes A first.",
    locks: ["A", "B", "C"],
    vars: { A: "a", B: "b", C: "c" },
    threads: [
      { name: "thread 1", order: ["A", "B"], out: "thread 1 got both" },
      { name: "thread 2", order: ["B", "C"], out: "thread 2 got both" },
      { name: "thread 3", order: ["C", "A"], out: "thread 3 got both" },
    ],
    finalLine: "done",
    challenge:
      "Challenge: give every thread its first lock before any thread takes its second, and the cycle closes.",
    fix: "Fix it: press Swap on thread 3 so it takes A before C (every thread then takes locks in the order A, B, C), then try to deadlock it again, or press Try every schedule.",
  },
  park: {
    kind: "condvar",
    title: "Condvar with a predicate loop (park.rs)",
    summary:
      "The primer's park.rs. The secondary vCPU waits in a while loop on powered_on; the boot vCPU sets it, unlocks, then rings the bell with notify_one. Try to make the secondary run too early, or sleep forever.",
    challenge:
      "Challenge: run the boot vCPU to the end before the secondary starts, then reset and send a spurious wake-up while the secondary waits. Does the secondary ever print too early, or sleep forever?",
    locks: ["powered_on"],
    threads: [
      {
        name: "boot vCPU",
        script: [
          { op: "lock", lock: "powered_on", text: "let mut on = powered_on.lock().unwrap();" },
          { op: "set", text: "*on = true; // change the state..." },
          { op: "unlock", lock: "powered_on", text: "drop(on); // unlocks powered_on" },
          { op: "notify", text: "wake.notify_one(); // ...then ring the bell" },
          { op: "print", out: "boot vCPU: start sent", text: 'println!("boot vCPU: start sent");' },
        ],
      },
      {
        name: "secondary vCPU",
        script: [
          { op: "lock", lock: "powered_on", text: "let mut on = powered_on.lock().unwrap();" },
          { op: "check", jump: 3, text: "while !*on {" },
          { op: "wait", lock: "powered_on", next: 1, text: "    on = wake.wait(on).unwrap();" },
          {
            op: "print", out: "secondary vCPU: powered on, running", needsFlag: true,
            text: 'println!("secondary vCPU: powered on, running");',
          },
          { op: "unlock", lock: "powered_on", text: "drop(on); // unlocks powered_on" },
        ],
      },
    ],
    finalLine: null,
  },
  lost: {
    kind: "condvar",
    title: "Condvar without the loop (deliberately broken)",
    summary:
      "The primer's self-check program: the same two threads, but the secondary calls wait once, with no while loop, so it never checks powered_on before or after. Unlike the primer's lost.rs there is no timeout here. Let the boot vCPU ring the bell before anyone listens, or send a spurious wake-up.",
    challenge:
      "Challenge: run the boot vCPU to the end first, then step the secondary. Then reset, and instead step the secondary into its wait and send it a spurious wake-up.",
    locks: ["powered_on"],
    threads: [
      {
        name: "boot vCPU",
        script: [
          { op: "lock", lock: "powered_on", text: "let mut on = powered_on.lock().unwrap();" },
          { op: "set", text: "*on = true; // change the state..." },
          { op: "unlock", lock: "powered_on", text: "drop(on); // unlocks powered_on" },
          { op: "notify", text: "wake.notify_one(); // ...then ring the bell" },
          { op: "print", out: "boot vCPU: start sent", text: 'println!("boot vCPU: start sent");' },
        ],
      },
      {
        name: "secondary vCPU",
        script: [
          { op: "lock", lock: "powered_on", text: "let mut on = powered_on.lock().unwrap();" },
          { op: "wait", lock: "powered_on", next: 2, text: "on = wake.wait(on).unwrap(); // no loop, no check" },
          {
            op: "print", out: "secondary vCPU: powered on, running", needsFlag: true,
            text: 'println!("secondary vCPU: powered on, running");',
          },
          { op: "unlock", lock: "powered_on", text: "drop(on); // unlocks powered_on" },
        ],
      },
    ],
    finalLine: null,
  },
};

export const SCENARIO_IDS = Object.keys(SCENARIOS);

/** Reference share strings, also used by the tests and lab.json. */
export const REFERENCE = {
  deadlock: "deadlock.00.1212",
  lostWakeup: "lost.00.1111122",
  spurious: "lost.00.22w222",
};

/**
 * Builds the concrete thread scripts for a scenario. `swaps` is an array of booleans, one per
 * thread: true reverses that thread's lock order (lock scenarios only).
 */
export function buildProgram(scenarioId, swaps = []) {
  const sc = SCENARIOS[scenarioId];
  if (!sc) throw new Error(`unknown scenario ${scenarioId}`);
  const threads = sc.threads.map((t, i) => {
    if (sc.kind === "locks") {
      const order = swaps[i] ? [...t.order].reverse() : [...t.order];
      return { name: t.name, order, script: twoLockScript(order[0], order[1], sc.vars, t.out) };
    }
    return { name: t.name, order: null, script: t.script };
  });
  return { id: scenarioId, kind: sc.kind, locks: [...sc.locks], threads, finalLine: sc.finalLine };
}

// ---- state ---------------------------------------------------------------------------------

/**
 * Thread status:
 *   "ready"  can take its next step
 *   "lock"   asleep on mutex `waitLock` (blocked)
 *   "cv"     asleep on the condvar (inside wait)
 *   "done"   finished its script
 * `woken` is true between a wake-up and the step that re-takes the lock inside wait.
 */
export function initialState(program) {
  return {
    threads: program.threads.map(() => ({ pc: 0, status: "ready", waitLock: null, woken: false })),
    holder: Object.fromEntries(program.locks.map((l) => [l, null])),
    flag: false,
    output: [],
    lostNotifies: 0,
    violation: null,
    log: [],
  };
}

function clone(s) {
  return {
    threads: s.threads.map((t) => ({ ...t })),
    holder: { ...s.holder },
    flag: s.flag,
    output: [...s.output],
    lostNotifies: s.lostNotifies,
    violation: s.violation,
    log: [...s.log],
  };
}

/** True if thread `i` can take a step now. */
export function canStep(program, s, i) {
  const t = s.threads[i];
  return Boolean(t) && t.status === "ready";
}

/** True if a spurious wake-up can be delivered to thread `i` (it is asleep on the condvar). */
export function canSpurious(program, s, i) {
  const t = s.threads[i];
  return Boolean(t) && t.status === "cv";
}

function release(program, s, lock) {
  s.holder[lock] = null;
  for (const t of s.threads) {
    if (t.status === "lock" && t.waitLock === lock) {
      t.status = "ready";
      t.waitLock = null;
    }
  }
}

function finishIfEnd(program, s, i) {
  const t = s.threads[i];
  if (t.pc >= program.threads[i].script.length) {
    t.status = "done";
    if (program.finalLine && s.threads.every((x) => x.status === "done")) s.output.push(program.finalLine);
  }
}

function tryTake(program, s, i, lock) {
  const t = s.threads[i];
  const owner = s.holder[lock];
  if (owner === null) {
    s.holder[lock] = i;
    return true;
  }
  if (owner === i) throw new Error(`${program.threads[i].name} already holds ${lock}`);
  t.status = "lock";
  t.waitLock = lock;
  return false;
}

/**
 * Runs one step of thread `i`. Returns a new state; never mutates `s`. Throws on an action that is
 * not allowed (the view disables those; decodeShare stops at the first one).
 */
export function step(program, s, i) {
  if (!Number.isInteger(i) || i < 0 || i >= s.threads.length) throw new Error(`no thread ${i}`);
  if (!canStep(program, s, i)) throw new Error(`${program.threads[i].name} cannot step now`);
  const n = clone(s);
  const t = n.threads[i];
  const name = program.threads[i].name;
  const ins = program.threads[i].script[t.pc];

  if (ins.op === "wait" && t.woken) {
    // Back from the condvar: wait re-takes the mutex before it returns.
    if (tryTake(program, n, i, ins.lock)) {
      t.woken = false;
      t.pc = ins.next;
      n.log.push({ thread: i, text: `${name}: wait returns, ${ins.lock} taken again` });
    } else {
      n.log.push({ thread: i, text: `${name}: woke, but ${ins.lock} is held by ${program.threads[n.holder[ins.lock]].name}; asleep on it` });
    }
    finishIfEnd(program, n, i);
    return n;
  }

  switch (ins.op) {
    case "lock":
      if (tryTake(program, n, i, ins.lock)) {
        t.pc += 1;
        n.log.push({ thread: i, text: `${name}: locks ${ins.lock}` });
      } else {
        n.log.push({ thread: i, text: `${name}: wants ${ins.lock}, held by ${program.threads[n.holder[ins.lock]].name}; goes to sleep` });
      }
      break;
    case "unlock":
      if (n.holder[ins.lock] !== i) throw new Error(`${name} does not hold ${ins.lock}`);
      release(program, n, ins.lock);
      t.pc += 1;
      n.log.push({ thread: i, text: `${name}: unlocks ${ins.lock}` });
      break;
    case "print":
      n.output.push(ins.out);
      if (ins.needsFlag && !n.flag && n.violation === null) {
        n.violation = { thread: i, text: `${name} ran before powered_on was true` };
      }
      t.pc += 1;
      n.log.push({ thread: i, text: `${name}: prints "${ins.out}"` });
      break;
    case "set":
      n.flag = true;
      t.pc += 1;
      n.log.push({ thread: i, text: `${name}: sets powered_on = true` });
      break;
    case "check":
      if (n.flag) {
        t.pc = ins.jump;
        n.log.push({ thread: i, text: `${name}: powered_on is true, leaves the loop` });
      } else {
        t.pc += 1;
        n.log.push({ thread: i, text: `${name}: powered_on is false, will wait` });
      }
      break;
    case "wait":
      if (n.holder[ins.lock] !== i) throw new Error(`${name} must hold ${ins.lock} to wait`);
      release(program, n, ins.lock);
      t.status = "cv";
      n.log.push({ thread: i, text: `${name}: wait releases ${ins.lock} and sleeps until the bell` });
      break;
    case "notify": {
      const sleeper = n.threads.findIndex((x) => x.status === "cv");
      if (sleeper >= 0) {
        n.threads[sleeper].status = "ready";
        n.threads[sleeper].woken = true;
        n.log.push({ thread: i, text: `${name}: notify_one wakes ${program.threads[sleeper].name}` });
      } else {
        n.lostNotifies += 1;
        n.log.push({ thread: i, text: `${name}: notify_one, but nobody is waiting; the bell is lost` });
      }
      t.pc += 1;
      break;
    }
    default:
      throw new Error(`bad op ${ins.op}`);
  }
  finishIfEnd(program, n, i);
  return n;
}

/** Wakes thread `i` from the condvar with no notify: a spurious wake-up. */
export function spurious(program, s, i) {
  if (!canSpurious(program, s, i)) throw new Error(`${program.threads[i] ? program.threads[i].name : i} is not waiting on the condvar`);
  const n = clone(s);
  n.threads[i].status = "ready";
  n.threads[i].woken = true;
  n.log.push({ thread: i, text: `${program.threads[i].name}: spurious wake-up (nobody rang)` });
  return n;
}

// ---- analysis ------------------------------------------------------------------------------

/**
 * The wait-for graph: one edge per blocked thread, from it to the thread holding the lock it
 * wants. Returns [{from, to, lock}].
 */
export function waitFor(program, s) {
  const edges = [];
  s.threads.forEach((t, i) => {
    if (t.status === "lock") {
      const to = s.holder[t.waitLock];
      if (to !== null) edges.push({ from: i, to, lock: t.waitLock });
    }
  });
  return edges;
}

/**
 * A cycle in the wait-for graph, as a list of edges in order, or null. Each thread has at most one
 * outgoing edge, so following edges from every start finds any cycle in O(threads^2).
 */
export function findCycle(program, s) {
  const out = new Map(waitFor(program, s).map((e) => [e.from, e]));
  for (const start of out.keys()) {
    const seen = new Map();
    const path = [];
    let cur = start;
    while (out.has(cur) && !seen.has(cur)) {
      seen.set(cur, path.length);
      path.push(out.get(cur));
      cur = out.get(cur).to;
    }
    if (seen.has(cur)) return path.slice(seen.get(cur));
  }
  return null;
}

/**
 * The overall outcome:
 *   "running"   some thread can still step
 *   "done"      every thread finished
 *   "deadlock"  a wait-for cycle: those threads can never move again
 *   "forever"   nobody can step and a thread sleeps on the condvar with no one left to notify it
 *               (only a spurious wake-up, which nobody may count on, could move it)
 * plus `violation` if the guarded line ran before the flag was set.
 */
export function outcome(program, s) {
  const cycle = findCycle(program, s);
  if (cycle) return { kind: "deadlock", cycle, violation: s.violation };
  if (s.threads.every((t) => t.status === "done")) return { kind: "done", violation: s.violation };
  if (s.threads.some((t) => t.status === "ready")) return { kind: "running", violation: s.violation };
  const sleeper = s.threads.findIndex((t) => t.status === "cv");
  if (sleeper >= 0) return { kind: "forever", thread: sleeper, violation: s.violation };
  return { kind: "stuck", violation: s.violation };
}

/** Plain-text explanation of a deadlock cycle. */
export function describeCycle(program, cycle) {
  const parts = cycle.map((e) => `${program.threads[e.from].name} waits for ${e.lock}, held by ${program.threads[e.to].name}`);
  return `${parts.join("; ")}. That is a cycle: none of them can ever move again.`;
}

/**
 * The search's notion of "a state": who holds which lock, where each thread is, the flag, and
 * whether the bug has happened. Two runs that differ only in the order lines were printed (or in
 * how many notifies were lost) are merged. That merge is sound: the output text and the lost-notify
 * count never influence any later step, so every outcome and every shortest path is unchanged.
 * The counts the lab shows are therefore distinct situations, ignoring print order.
 */
function key(s) {
  return JSON.stringify([
    s.threads.map((t) => [t.pc, t.status, t.waitLock, t.woken]),
    s.holder, s.flag, s.violation !== null, s.output.length,
  ]);
}

/**
 * Tries every schedule (breadth first, every reachable state once). `spuriousWakeups` also lets
 * the scheduler deliver a spurious wake-up to any thread asleep on the condvar. Returns
 * {states, complete, done, deadlock, forever, violation}, where each bad outcome is null or the
 * shortest schedule (list of actions, as in the share string) that reaches it.
 */
export function explore(program, { spuriousWakeups = false } = {}) {
  const start = initialState(program);
  const seen = new Set([key(start)]);
  const queue = [{ s: start, path: [] }];
  const found = { done: null, deadlock: null, forever: null, violation: null };
  let complete = true;
  for (let head = 0; head < queue.length; head++) {
    const { s, path } = queue[head];
    const o = outcome(program, s);
    if (o.violation && !found.violation) found.violation = path;
    if (o.kind !== "running") {
      if (o.kind in found && !found[o.kind]) found[o.kind] = path;
    }
    const moves = [];
    s.threads.forEach((_, i) => {
      if (canStep(program, s, i)) moves.push({ a: String(i + 1), n: () => step(program, s, i) });
      if (spuriousWakeups && canSpurious(program, s, i)) moves.push({ a: `w${i + 1}`, n: () => spurious(program, s, i) });
    });
    for (const m of moves) {
      const n = m.n();
      const k = key(n);
      if (seen.has(k)) continue;
      if (seen.size >= MAX_STATES) { complete = false; continue; }
      seen.add(k);
      queue.push({ s: n, path: [...path, m.a] });
    }
  }
  return { states: seen.size, complete, ...found };
}

// ---- share state ---------------------------------------------------------------------------

/** Parses a schedule string ("1212", "22w2") into actions, or null if malformed. */
export function parseSchedule(str, threadCount) {
  if (typeof str !== "string" || str.length > MAX_SCHEDULE * 2) return null;
  const actions = [];
  let i = 0;
  while (i < str.length) {
    let spur = false;
    if (str[i] === "w") { spur = true; i += 1; }
    const c = str[i];
    if (c === undefined || c < "1" || c > "9") return null;
    const t = c.charCodeAt(0) - 49;
    if (t >= threadCount) return null;
    actions.push({ thread: t, spurious: spur });
    i += 1;
    if (actions.length > MAX_SCHEDULE) return null;
  }
  return actions;
}

export function formatAction(a) {
  return `${a.spurious ? "w" : ""}${a.thread + 1}`;
}

/** Applies one action; returns the new state or null if it is not allowed now. */
export function apply(program, s, a) {
  if (a.spurious) return canSpurious(program, s, a.thread) ? spurious(program, s, a.thread) : null;
  return canStep(program, s, a.thread) ? step(program, s, a.thread) : null;
}

/** Replays actions from the start; stops at the first one that is not allowed. */
export function replay(program, actions) {
  let s = initialState(program);
  const done = [];
  for (const a of actions) {
    const n = apply(program, s, a);
    if (!n) break;
    s = n;
    done.push(a);
  }
  return { state: s, actions: done };
}

/** `<scenario>.<swaps>.<schedule>`, swaps one 0/1 per thread (`deadlock.00.1212`). */
export function encodeShare({ scenario, swaps, actions }) {
  const sc = SCENARIOS[scenario];
  const mask = sc.threads.map((_, i) => (sc.kind === "locks" && swaps[i] ? "1" : "0")).join("");
  return `${scenario}.${mask}.${actions.map(formatAction).join("")}`;
}

/**
 * Parses a share string. Returns {scenario, swaps, actions} with the schedule cut at the first
 * action that is not allowed, or null if the string is malformed.
 */
export function decodeShare(str) {
  if (typeof str !== "string" || str.length > 16 + MAX_SCHEDULE * 2) return null;
  const m = /^([a-z]+)\.([01]{1,9})\.((?:w?[1-9])*)$/.exec(str);
  if (!m || !Object.hasOwn(SCENARIOS, m[1])) return null;
  const sc = SCENARIOS[m[1]];
  if (m[2].length !== sc.threads.length) return null;
  const swaps = [...m[2]].map((c) => sc.kind === "locks" && c === "1");
  const actions = parseSchedule(m[3], sc.threads.length);
  if (!actions) return null;
  const program = buildProgram(m[1], swaps);
  return { scenario: m[1], swaps, actions: replay(program, actions).actions };
}
