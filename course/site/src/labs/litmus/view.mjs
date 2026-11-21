// litmus view: renders the model's state and turns clicks into model calls. All logic (the
// three machines, store buffers, ordering rules, the search over every schedule, the language
// rules) lives in model.mjs; this file only builds DOM with createElement / textContent (never
// innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
import {
  TESTS, TEST_IDS, PRESETS, MACHINES, MACHINE_IDS, ORD_NAME, STORE_ORDS, LOAD_ORDS, FENCE_KINDS,
  FENCE_NAME, DEFAULT, buildProgram, enabledActions, apply, replay, explore, blockers,
  describeAction, rustText, asmText, isFinal, outcomeText, verdict, presetsOf, measurementsOf,
  exerciseTable, encodeShare, decodeShare,
} from "./model.mjs";

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) el.append(kid);
  return el;
}

const fmt = (n) => n.toLocaleString("en-US");

// The primer's counts were all measured on one machine; every place that shows them says so.
const MEASURED_ON = "Measured on arm64 (Apple M5 Pro)";

// Move focus without scrolling the page; the fake DOM in view.test.mjs implements focus() too.
function focusEl(el) {
  if (el && typeof el.focus === "function") el.focus({ preventScroll: true });
}

export function mount(el, ctx) {
  const id = ctx.id;
  const shared = decodeShare(ctx.hash.get());
  let ui = shared ? { ...shared } : { ...DEFAULT, ords: [...DEFAULT.ords], schedule: [] };
  let program = buildProgram(ui.test, ui.ords);
  let state = replay(program, ui.machine, ui.schedule).state;
  let listed = false;
  // The preset the reader picked, kept while the orderings still match it (`mp fence` and
  // `mp acqrel` are the same code, so the select must not jump to the first match).
  let pickedPreset = null;
  // Embedded, the shell titles the lab with an h3; standalone, with an h1 (build.mjs labShell).
  const hTag = ctx.standalone ? "h2" : "h4";

  // The lab's own polite live region is the one readout (LABS.md section 6); it is updated
  // right away and screen readers speak it, so ctx.announce is not also called (no double speech).
  function say(text) {
    readout.textContent = text;
  }

  // ---- controls -------------------------------------------------------------------------
  const testSel = h("select", { id: `${id}-test` });
  for (const t of TEST_IDS) testSel.append(h("option", { value: t, text: TESTS[t].title }));
  const machineSel = h("select", { id: `${id}-machine` });
  for (const m of MACHINE_IDS) machineSel.append(h("option", { value: m, text: MACHINES[m].title }));
  const presetSel = h("select", { id: `${id}-preset` });
  const undoBtn = h("button", { type: "button", class: "lm-btn", text: "Undo step" });
  const resetBtn = h("button", { type: "button", class: "lm-btn", text: "Reset" });

  const ordBox = h("div", { class: "lm-ords" });

  const controls = h("div", { class: "lm-controls" },
    h("div", { class: "lm-field" }, h("label", { for: `${id}-test`, text: "Test" }), testSel),
    h("div", { class: "lm-field" }, h("label", { for: `${id}-machine`, text: "Machine" }), machineSel),
    h("div", { class: "lm-field" }, h("label", { for: `${id}-preset`, text: "Orderings" }), presetSel),
    h("div", { class: "lm-buttons", role: "group", "aria-label": "Run" }, undoBtn, resetBtn),
  );
  const howto = h("p", { class: "lm-note", text: "You are the machine. Each button below runs one instruction of one thread, or moves one waiting store from a store buffer into memory. Buttons appear only for steps the chosen machine allows right now. On a real core a store does not go straight to shared memory: it first waits in its thread's store buffer, so the thread can carry on without waiting for memory. A dashed step moves it into shared memory, where the other thread can see it." });

  const threadsBox = h("div", { class: "lm-threads" });
  const stepsBox = h("div", { class: "lm-steps", role: "group", "aria-label": "Next steps" });
  const memBody = h("tbody");
  const memTable = h("table", { class: "lm-mem" },
    h("caption", { text: "Shared memory and results" }),
    h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Name" }), h("th", { scope: "col", text: "Value" }))),
    memBody);
  const banner = h("p", { class: "lm-banner", hidden: true, tabindex: "-1" });
  const logList = h("ol", { class: "lm-log", "aria-label": "Steps so far", tabindex: "0" });
  const readout = h("p", { class: "lm-readout", "aria-live": "polite", "aria-atomic": "true" });

  const listBtn = h("button", { type: "button", class: "lm-btn lm-btn--primary", text: "List every outcome" });
  const listNote = h("p", { class: "lm-note", text: "Predict first: can this machine end with the bad outcome? Then list what it allows. The search tries every schedule, so the list is exact, not a sample." });
  const outcomesBox = h("div", { class: "lm-outcomes", hidden: true });

  const exercise = h("details", { class: "lm-more" }, h("summary", { text: "Check your table from the primer's exercise" }));
  const exBody = h("tbody");
  exercise.append(
    h("div", { class: "lm-scroll", tabindex: "0", role: "region", "aria-label": "Exercise table, scrolls sideways" }, h("table", { class: "lm-ex" },
      h("caption", { text: "The eight litmus.rs runs: measured on arm64 (the Apple M5 Pro the primer was written on), and what the rules say" }),
      h("thead", {}, h("tr", {},
        h("th", { scope: "col", text: "Command" }), h("th", { scope: "col", text: "Measured" }),
        h("th", { scope: "col", text: "arm64 allows the bad outcome?" }), h("th", { scope: "col", text: "Rust's rules allow it?" }),
        h("th", { scope: "col", text: "A zero that fools you?" }))),
      exBody)),
    h("p", { class: "lm-note", text: "Cheapest fixes: for sb, a fence(SeqCst) between the store and the load in both threads (or SeqCst on all four accesses); for mp, a Release flag store paired with an Acquire flag load." }),
  );
  for (const r of exerciseTable()) {
    exBody.append(h("tr", {},
      h("td", {}, h("code", { text: `./litmus ${r.test} ${r.mode}` })),
      h("td", { text: r.measured ? `${fmt(r.measured.hits)} of ${fmt(r.measured.of)}` : "not quoted in the primer" }),
      h("td", { text: r.armAllows ? "allowed" : "forbidden" }),
      h("td", { text: r.rulesAllow ? "allowed" : "forbidden" }),
      h("td", { text: r.fools ? "yes: 0 measured, but allowed" : "no" }),
    ));
  }

  const honesty = h("details", { class: "lm-more" },
    h("summary", { text: "What this model simplifies" }),
    h("ul", {},
      h("li", { text: "One memory that every core sees at once, with a store buffer per thread in front of it. Arm guarantees that once a store is visible to one other core it is visible to all (\"other-multi-copy atomic\"), which is why this picture is faithful for two threads." }),
      h("li", { text: "On arm64, any instruction whose ordering rules are met may run, so loads and stores run out of program order, and a store buffer may drain in any order. Real cores reorder for many reasons (caches, speculation); the outcomes are what matters, and they are the ones the architecture allows." }),
      h("li", { text: "\"Allowed\" means some schedule reaches it, not that it is likely. On arm64 the real program found sb's fourth outcome in half to two thirds of its rounds, and mp's 0 times in 40 million with this harness (an earlier one caught it 4 times in 26 million): both are allowed." }),
      h("li", { text: "Every count shown was measured on arm64 (an Apple M5 Pro). Nobody ran these programs on x86-64 for this lab, and the paper model is not a machine you can run." }),
      h("li", { text: "The compiler can reorder too. The verdict \"Rust's rules\" covers both reorderers; the machine search covers only the hardware." }),
      h("li", { text: "In the virtqueue tests the driver is C. Plain copies on either side (macvmm's used element and its avail.flags read, the driver's ring accesses) are shown as Relaxed, virtio_mb() as fence(SeqCst) (dmb ish) and virtio_rmb() as fence(Acquire) (dmb ishld), the instructions they become on arm64." }),
      h("li", { text: "Rust's memory model has no rule for a thread written in C, so the virtqueue verdicts are argued in Arm terms: Rust's rules for macvmm's side, Linux's for the driver's, meeting at the instructions both become. That is why macvmm uses a fence there rather than leaning on SeqCst accesses." }),
    ),
  );

  const scNote = h("p", { class: "lm-note", hidden: true, text: "The paper model has no instructions: it only tries every interleaving of the lines as written." });

  el.append(h("div", { class: "lm-wrap" },
    controls, ordBox, howto, banner, threadsBox, scNote,
    h("div", { class: "lm-main" },
      h("div", { class: "lm-col" }, h(hTag, { class: "lm-h", text: "Next step" }), stepsBox),
      h("div", { class: "lm-col" }, memTable, h(hTag, { class: "lm-h", text: "Steps so far" }), logList),
    ),
    readout,
    h("div", { class: "lm-listbox" }, listNote, listBtn, outcomesBox),
    exercise, honesty,
  ));

  // ---- rendering ------------------------------------------------------------------------
  // The ordering selects are built once per test and only have their values updated after
  // that, so the select the reader just changed keeps keyboard focus.
  let ordSels = [];
  let ordTest = null;

  function renderControls() {
    testSel.value = ui.test;
    machineSel.value = ui.machine;
    presetSel.replaceChildren();
    const matches = presetsOf(program);
    if (!matches.length) presetSel.append(h("option", { value: "", text: "Custom (edited below)" }));
    for (const p of PRESETS[ui.test]) presetSel.append(h("option", { value: p.id, text: p.label }));
    const keep = matches.find((p) => p.id === pickedPreset);
    presetSel.value = keep ? keep.id : matches.length ? matches[0].id : "";

    if (ordTest !== ui.test) buildOrdControls();
    ordSels.forEach((row, t) => row.forEach((sel, slotIdx) => { sel.value = ui.ords[t][slotIdx]; }));
  }

  function buildOrdControls() {
    ordTest = ui.test;
    ordSels = [];
    ordBox.replaceChildren();
    program.def.threads.forEach((th, t) => {
      const row = [];
      ordSels.push(row);
      const fs = h("fieldset", { class: "lm-ordset" }, h("legend", { text: `${th.name}: orderings` }));
      const mk = (slotIdx, label, choices, names) => {
        const sid = `${id}-o${t}${slotIdx}`;
        const sel = h("select", { id: sid });
        for (const c of choices) sel.append(h("option", { value: c, text: names[c] }));
        sel.value = ui.ords[t][slotIdx];
        row[slotIdx] = sel;
        sel.addEventListener("change", () => {
          if (!choices.includes(sel.value)) { sel.value = ui.ords[t][slotIdx]; return; }
          const o = ui.ords[t].split("");
          o[slotIdx] = sel.value;
          setOrds(t, o.join(""));
        });
        return h("div", { class: "lm-field" }, h("label", { for: sid, text: label }), sel);
      };
      const opLabel = (op) => (op.op === "st" ? `${op.v} store` : `${op.v} load`);
      fs.append(
        mk(0, opLabel(th.ops[0]), th.ops[0].op === "st" ? STORE_ORDS : LOAD_ORDS, ORD_NAME),
        mk(1, "Between them", FENCE_KINDS, FENCE_NAME),
        mk(2, opLabel(th.ops[1]), th.ops[1].op === "st" ? STORE_ORDS : LOAD_ORDS, ORD_NAME),
      );
      ordBox.append(fs);
    });
  }

  function threadColumn(t) {
    const th = program.threads[t];
    const list = h("ol", { class: "lm-code", "aria-label": `${th.name} program` });
    th.slots.forEach((slot, k) => {
      if (!slot) return;
      const status = state.status[t][k];
      const why = blockers(program, ui.machine, state, t, k);
      // Hidden separators so a screen reader says "ready: X.store(1, Relaxed), compiles to str"
      // rather than running the three parts together.
      const li = h("li", { class: `lm-line lm-line--${status}${why.length ? " lm-line--blocked" : ""}` },
        h("span", { class: "lm-mark", text: status === "done" ? "done" : status === "buffered" ? "queued" : why.length ? "waits" : "ready" }),
        h("span", { class: "lm-sr", text: ": " }),
        h("code", { class: "lm-rust", text: rustText(slot) }),
      );
      if (ui.machine !== "sc") {
        li.append(h("span", { class: "lm-sr", text: ", compiles to " }), h("span", { class: "lm-asm", text: asmText(ui.machine, slot) }));
      }
      if (why.length) li.append(h("span", { class: "lm-why", text: `Waits: ${[...new Set(why.map((w) => w.why))].join("; ")}.` }));
      list.append(li);
    });
    const buf = state.buffers[t];
    const bufList = h("ul", { class: "lm-buffer", "aria-label": `${th.name} store buffer` });
    if (!buf.length) bufList.append(h("li", { class: "lm-muted", text: ui.machine === "sc" ? "(none: stores go straight to memory)" : "(empty)" }));
    for (const e of buf) bufList.append(h("li", {}, h("code", { text: `${e.v} = ${e.val}` })));
    return h("section", { class: "lm-thread", "aria-label": th.name },
      h(hTag, { class: "lm-h", text: th.name }),
      list,
      h("p", { class: "lm-sub", text: ui.machine === "tso" ? "Store buffer (oldest first, drains in order)" : "Store buffer" }),
      bufList,
    );
  }

  function render() {
    // Remember which step button had focus, so a keyboard user stays in the step list.
    const active = document.activeElement;
    const oldSteps = Array.from(stepsBox.children).filter((c) => c.tagName === "BUTTON");
    const focusIdx = active ? oldSteps.indexOf(active) : -1;

    threadsBox.replaceChildren(threadColumn(0), threadColumn(1));
    scNote.hidden = ui.machine !== "sc";

    stepsBox.replaceChildren();
    const acts = enabledActions(program, ui.machine, state);
    for (const a of acts) {
      const b = h("button", { type: "button", class: `lm-btn lm-step${a.kind === "drain" ? " lm-step--drain" : ""}`, text: describeAction(program, ui.machine, state, a.code) });
      b.addEventListener("click", () => step(a.code));
      stepsBox.append(b);
    }
    if (!acts.length) stepsBox.append(h("p", { class: "lm-muted", text: "Nothing left to run." }));

    memBody.replaceChildren();
    for (const v of program.def.vars) {
      memBody.append(h("tr", {}, h("th", { scope: "row" }, h("code", { text: v.id })), h("td", { text: String(state.mem[v.id]) })));
    }
    for (const r of program.def.regs) {
      memBody.append(h("tr", {}, h("th", { scope: "row" }, h("code", { text: r })), h("td", { text: r in state.regs ? String(state.regs[r]) : "?" })));
    }

    logList.replaceChildren();
    let st = replay(program, ui.machine, []).state;
    for (const c of ui.schedule) {
      logList.append(h("li", { text: describeAction(program, ui.machine, st, c) }));
      st = apply(program, ui.machine, st, c).state;
    }
    if (!ui.schedule.length) logList.append(h("li", { class: "lm-muted", text: "None yet." }));
    undoBtn.disabled = ui.schedule.length === 0;

    banner.hidden = true;
    banner.className = "lm-banner";
    if (isFinal(state)) {
      const bad = program.def.bad(state.regs);
      banner.hidden = false;
      banner.className = `lm-banner ${bad ? "lm-banner--bad" : "lm-banner--ok"}`;
      banner.textContent = bad
        ? `Finished with the bad outcome: ${outcomeText(program, state.regs)}. That is ${program.def.badText}.`
        : `Finished: ${outcomeText(program, state.regs)}. Not the bad outcome.`;
    }

    renderOutcomes();
    ctx.hash.set(encodeShare(ui));

    if (focusIdx >= 0) {
      const now = Array.from(stepsBox.children).filter((c) => c.tagName === "BUTTON");
      if (now.length) focusEl(now[Math.min(focusIdx, now.length - 1)]);
      else if (!banner.hidden) focusEl(banner);
      else focusEl(listBtn);
    }
  }

  function renderOutcomes() {
    outcomesBox.hidden = !listed;
    outcomesBox.replaceChildren();
    if (!listed) return;
    const v = verdict(program, ui.machine);
    const m = MACHINES[ui.machine].short;
    const tbody = h("tbody");
    for (const o of v.explored.outcomes) {
      const show = h("button", { type: "button", class: "lm-btn", text: "Show me" });
      show.setAttribute("aria-label", `Show a schedule that ends with ${outcomeText(program, o.regs)}`);
      show.addEventListener("click", () => {
        ui.schedule = [...o.witness];
        state = replay(program, ui.machine, ui.schedule).state;
        render();
        // The pressed button is gone; move to the banner that states the result, just above
        // the threads and store buffers the replay changed.
        focusEl(banner);
        say(`Replayed ${o.witness.length} steps. ${outcomeText(program, o.regs)}.`);
      });
      tbody.append(h("tr", { class: o.bad ? "lm-row--bad" : "" },
        h("td", { text: outcomeText(program, o.regs) }),
        h("td", { text: o.bad ? `Bad: ${program.def.badText}` : "fine" }),
        h("td", {}, show)));
    }
    outcomesBox.append(
      h("div", { class: "lm-scroll" }, h("table", { class: "lm-otable" },
        h("caption", { text: `Every outcome ${MACHINES[ui.machine].title} allows (${v.explored.outcomes.length}, from ${v.explored.states} reachable states)` }),
        h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Outcome" }), h("th", { scope: "col", text: "Meaning" }), h("th", { scope: "col", text: "Schedule" }))),
        tbody)),
      h("p", { class: `lm-verdict lm-verdict--${v.kind}` }, h("strong", { text: headline(v, m) }), verdictText(v, m)),
    );
    const meas = measurementsOf(program);
    for (const { preset, m: x } of meas) {
      const cmd = preset.label.replace(/ \(.*\)$/, "");
      outcomesBox.append(h("p", { class: "lm-note", text: x
        ? `${MEASURED_ON}, ${cmd}: ${fmt(x.hits)} of ${fmt(x.of)} rounds. ${x.note}`.trim()
        : `${cmd}: the primer quotes no count; run it on your Mac.` }));
    }
    if (meas.length && ui.machine !== "arm") {
      outcomesBox.append(h("p", { class: "lm-note", text: `These counts are for arm64, not ${MACHINES[ui.machine].title}. Switch the machine to arm64 to compare them with what it allows.` }));
    }
    if (ui.machine === "arm" && v.machineAllows && meas.some((x) => x.m && x.m.hits === 0)) {
      outcomesBox.append(h("p", { class: "lm-verdict lm-verdict--allowed" }, h("strong", { text: "A zero that fools you. " }), "arm64 allows the outcome, and the real run on arm64 never saw it. A passing test is a sample; the rules decide."));
    }
  }

  function headline(v, m) {
    if (ui.machine === "sc") return v.machineAllows ? `${m}: the bad outcome is allowed. ` : `${m}: the bad outcome is impossible on paper. `;
    return v.machineAllows ? `${m}: the bad outcome is allowed. ` : `${m}: the bad outcome is impossible. `;
  }

  function verdictText(v, m) {
    const why = v.rules.why;
    if (v.crossLanguage) {
      // One thread is the Linux C driver: Rust's model has no rule for it (primer, "The guest
      // is the other thread"), so name both sides' rules and say where they meet.
      const rules = "both sides' rules (Rust's for macvmm, Linux's for the driver, argued in Arm terms because the threads are in different languages)";
      if (v.kind === "forbidden") return `Forbidden by ${rules}, so no correct compiler and no arm64 core may produce it. ${why}`;
      if (v.kind === "allowed") return `Allowed by ${rules}${v.machineAllows ? `, and ${m} produces it` : ""}. ${why}`;
      if (ui.machine === "sc") return `Trying every interleaving on paper never gives it, but ${rules} allow it: ${realText(v)}, so this code is wrong. ${why}`;
      return `${m} cannot produce it with these instructions, but ${rules} allow it, so this code is correct only by accident of this hardware and how the compilers translate it. ${why}`;
    }
    if (v.kind === "forbidden") return `Forbidden by Rust's rules, so no correct compiler and no machine may produce it. ${why}`;
    if (v.kind === "allowed") return `Allowed by Rust's rules${v.machineAllows ? `, and ${m} produces it` : ""}. ${why}`;
    if (ui.machine === "sc") return `Trying every interleaving on paper never gives it, but Rust's rules allow it: real compilers and cores do more than interleave, and ${realText(v)}. So this code is wrong. ${why}`;
    return `${m} cannot produce it with these instructions, but Rust's rules allow it, so this code is correct only by accident of this hardware and how the compiler translates it. ${why}`;
  }

  // On the paper model, say what the two real machines do with the same code.
  function realText(v) {
    const arm = v.real.arm ? "arm64 produces it" : "arm64 does not, with the instructions this code becomes";
    const tso = v.real.tso ? "x86-64 produces it" : "x86-64 does not";
    return `${arm}, and ${tso} (switch the machine to see how)`;
  }

  // ---- actions --------------------------------------------------------------------------
  function restart(msg) {
    program = buildProgram(ui.test, ui.ords);
    ui.schedule = [];
    state = replay(program, ui.machine, []).state;
    listed = false;
    renderControls();
    render();
    if (msg) say(msg);
  }

  function setOrds(t, o) {
    const ords = [...ui.ords];
    ords[t] = o;
    try { buildProgram(ui.test, ords); } catch { return; }
    ui.ords = ords;
    pickedPreset = null;
    restart(`${program.threads[t].name} now: ${o.split("").map((c, i) => (i === 1 ? FENCE_NAME[c] : ORD_NAME[c])).join(", ")}. Run restarted.`);
  }

  function step(code) {
    const before = state;
    const r = apply(program, ui.machine, state, code);
    if (!r.ok) return;
    const text = describeAction(program, ui.machine, before, code);
    state = r.state;
    ui.schedule = [...ui.schedule, code];
    render();
    say(isFinal(state) ? `${text}. ${banner.textContent}` : `${text}.`);
  }

  testSel.addEventListener("change", () => {
    if (!TEST_IDS.includes(testSel.value)) { testSel.value = ui.test; return; }
    ui.test = testSel.value;
    ui.ords = [...PRESETS[ui.test][0].ords];
    pickedPreset = PRESETS[ui.test][0].id;
    restart(`${TESTS[ui.test].title}. Run restarted.`);
  });
  machineSel.addEventListener("change", () => {
    if (!MACHINE_IDS.includes(machineSel.value)) { machineSel.value = ui.machine; return; }
    ui.machine = machineSel.value;
    restart(`Machine: ${MACHINES[ui.machine].title}. Run restarted.`);
  });
  presetSel.addEventListener("change", () => {
    const p = PRESETS[ui.test].find((x) => x.id === presetSel.value);
    if (!p) return;
    ui.ords = [...p.ords];
    pickedPreset = p.id;
    restart(`${p.label}. Run restarted.`);
  });
  undoBtn.addEventListener("click", () => {
    if (!ui.schedule.length) return;
    ui.schedule = ui.schedule.slice(0, -1);
    state = replay(program, ui.machine, ui.schedule).state;
    render();
    say("Undid one step.");
  });
  resetBtn.addEventListener("click", () => restart("Run restarted."));
  listBtn.addEventListener("click", () => {
    listed = true;
    render();
    const v = verdict(program, ui.machine);
    say(`${v.explored.outcomes.length} outcomes allowed. The bad outcome is ${v.machineAllows ? "allowed" : "impossible"} on ${MACHINES[ui.machine].short}.`);
  });

  renderControls();
  render();
  readout.textContent = `${TESTS[ui.test].title}, on ${MACHINES[ui.machine].title}. ${enabledActions(program, ui.machine, state).length} steps available.`;

  return {
    destroy() {
      // Nothing outside el: no timers, no global listeners.
    },
  };
}
