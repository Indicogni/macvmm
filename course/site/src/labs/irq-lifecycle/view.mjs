// irq-lifecycle view: renders the model's state and turns button presses into model steps.
// All logic lives in model.mjs; this file only builds DOM (createElement + textContent, never
// innerHTML) inside the element the lab shell hands us. See course/site/LABS.md.
//
// Nothing animates and nothing plays by itself, so reduced motion needs no special path: a preset
// is walked one step at a time with "Next step", never auto-played.
//
// Accessibility notes: the action buttons are built once per mode and only their `disabled`
// changes, so a keyboard user keeps focus on the button they pressed; when a focused control
// becomes disabled, focus moves to the readout. The readout is plain text, not a live region:
// every spoken update goes through ctx.announce, once.
import {
  INTID, SPURIOUS, MODES, CPU_KINDS, CPU_ACTIONS, GIC_ACTIONS, PRESETS,
  replay, step, canDo, summary, decode, startState, shareString,
  cpuPending, gicPending, gicStateName, gicSignalling,
} from "./model.mjs";

const ANNOUNCE_GAP_MS = 300;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v === null || v === undefined) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}

const INTRO = {
  cpu: "No interrupt controller: each source is wired straight to the CPU's IRQ input. The same action happens in all three worlds at once. The CPU starts with IRQs masked (PSTATE.I = 1). Watch which source still has its interrupt when the CPU starts listening.",
  gic: `A GICv3 between the device and the CPU. INTID ${INTID} is the PL011's line. Raise and lower the line as the device; as the handler, read the IAR (interrupt acknowledge register) and write the EOI (end of interrupt); and watch the state the GIC keeps for INTID ${INTID}. When the GIC signals an IRQ, a real CPU would enter the handler and read the IAR at once; here you press it, so a storm repeats once per press instead of without end. Try never lowering the line.`,
};

const GIC_STATES = ["inactive", "pending", "active", "active and pending"];

export function mount(el, ctx) {
  const id = ctx.id;
  const start = startState({ standalone: ctx.standalone, path: globalThis.location?.pathname ?? "", options: ctx.options });
  let state = decode(ctx.hash.get()) ?? start;
  let script = null; // { preset, actions }: a preset being walked with "Next step"

  // ---- throttled announcements (about one per 300 ms; the latest text wins) ----
  let timer = null;
  let lastSpoke = 0;
  function say(text) {
    if (timer) clearTimeout(timer);
    const wait = Math.max(0, lastSpoke + ANNOUNCE_GAP_MS - Date.now());
    timer = setTimeout(() => {
      timer = null;
      lastSpoke = Date.now();
      ctx.announce(text);
    }, wait);
  }

  // ---- static frame ----
  const modeBox = h("fieldset", { class: "il-field il-radios" }, h("legend", { text: "Machine" }));
  const modeInputs = {};
  for (const m of MODES) {
    const inputId = `${id}-mode-${m.id}`;
    const input = h("input", { type: "radio", name: `${id}-mode`, id: inputId, value: m.id });
    input.addEventListener("change", () => { if (input.checked) apply({ type: "mode", mode: m.id }, { clearScript: true }); });
    modeInputs[m.id] = input;
    modeBox.append(h("span", { class: "il-radio" }, input, h("label", { for: inputId, text: m.label })));
  }

  const trigBox = h("fieldset", { class: "il-field il-radios" }, h("legend", { text: `INTID ${INTID} is configured` }));
  const trigInputs = {};
  for (const [tid, label] of [["level", "level-triggered (as the PL011 is)"], ["edge", "edge-triggered (what if)"]]) {
    const inputId = `${id}-trig-${tid}`;
    const input = h("input", { type: "radio", name: `${id}-trig`, id: inputId, value: tid });
    input.addEventListener("change", () => { if (input.checked) apply({ type: "trigger", trigger: tid }, { clearScript: true }); });
    trigInputs[tid] = input;
    trigBox.append(h("span", { class: "il-radio" }, input, h("label", { for: inputId, text: label })));
  }

  // A scenario loads only on the button: some browsers fire "change" for every arrow key in a
  // closed <select>, and loading resets the state.
  const presetSel = h("select", { id: `${id}-preset` });
  const loadBtn = h("button", { type: "button", class: "il-btn", text: "Load scenario" });
  const presetField = h("div", { class: "il-field" },
    h("label", { for: `${id}-preset`, text: "Scenario" }),
    h("span", { class: "il-load" }, presetSel, loadBtn));
  loadBtn.addEventListener("click", () => {
    const p = PRESETS.find((x) => x.id === presetSel.value);
    if (!p) {
      if (script) { script = null; render(); say("Free play."); }
      return;
    }
    state = { mode: p.mode, trigger: p.trigger || "level", actions: "" };
    script = { preset: p, actions: p.actions };
    commit(`Scenario: ${p.title}. ${p.goal} Press Next step.`);
  });

  const intro = h("p", { class: "il-intro" });
  const actionBox = h("div", { class: "il-buttons", role: "group", "aria-label": "Actions" });
  const nextBtn = h("button", { type: "button", class: "il-btn il-btn--primary", text: "Next step" });
  const undoBtn = h("button", { type: "button", class: "il-btn", text: "Undo" });
  const resetBtn = h("button", { type: "button", class: "il-btn", text: "Reset" });
  const copyBtn = h("button", { type: "button", class: "il-btn", text: "Copy link to this state" });
  const utilBox = h("div", { class: "il-buttons", role: "group", "aria-label": "History" }, nextBtn, undoBtn, resetBtn, copyBtn);
  const scriptNote = h("p", { class: "il-script" });

  const viz = h("div", { class: "il-viz" });
  const readout = h("p", { class: "il-readout", tabindex: "-1" });
  const realBox = h("div", { class: "il-real" });
  const historyWrap = h("div", { class: "il-scroll" });

  const simplifies = h("details", { class: "il-more" },
    h("summary", { text: "What this toy simplifies" }),
    h("ul", {},
      h("li", { text: "Without a controller, the toy CPU takes an interrupt the moment one is pending and unmasked. A real CPU takes it between two instructions, which is the same thing at this zoom level (after an unmask, Arm only guarantees it by the next isb, which is why the masked-IRQ guest runs one)." }),
      h("li", { text: "The toy handler unmasks by returning (eret restores the saved PSTATE). Real handlers can unmask earlier to allow nesting; ours never do. For the same reason a mask or unmask inside the handler is not applied: eret would undo it." }),
      h("li", { text: "Each world has its own CPU, so after the same buttons the three CPUs can disagree: one may be in its handler while another is masked." }),
      h("li", { text: `The GIC view shows one INTID and one CPU. Priorities, groups and routing are fixed: INTID ${INTID} is always more urgent than the CPU's priority mask and the CPU never masks IRQs here.` }),
      h("li", { text: "The GIC view uses the mode our guests use, and Linux when it boots at EL1 as it does on macvmm, where one EOI write both drops the running priority and deactivates the interrupt." }),
      h("li", { text: "In chapter 11's real VMM the level line is our line plus the vCPU's pending IRQ, rebuilt before every entry; here it is one wire." }),
    ),
  );

  el.append(h("div", { class: "il-wrap" },
    h("div", { class: "il-controls" }, modeBox, trigBox, presetField),
    intro,
    actionBox,
    utilBox,
    scriptNote,
    h("h3", { class: "il-h", text: "State right now" }),
    h("div", { class: "il-main" }, viz, h("div", { class: "il-side" }, readout, realBox)),
    h("h3", { class: "il-h", text: "What happened, step by step" }),
    historyWrap,
    simplifies,
  ));

  // ---- state changes ----
  function commit(message) {
    ctx.hash.set(shareString(state, start));
    render();
    say(message ?? summary(state));
  }

  function apply(action, { clearScript = false } = {}) {
    const next = step(state, action);
    if (clearScript) dropScript();
    if (next === state) { render(); return false; }
    state = next;
    if (script && (state.mode !== script.preset.mode || !script.actions.startsWith(state.actions))) dropScript();
    commit();
    return true;
  }

  nextBtn.addEventListener("click", () => {
    if (!script) return;
    const k = script.actions[state.actions.length];
    if (k) apply({ type: "do", key: k });
  });
  undoBtn.addEventListener("click", () => apply({ type: "undo" }));
  resetBtn.addEventListener("click", () => apply({ type: "reset" }));
  copyBtn.addEventListener("click", async () => {
    commit("Link updated.");
    try {
      await navigator.clipboard.writeText(window.location.href);
      say("Link copied.");
    } catch {
      say("Copy is not available here; the link to this state is in the address bar.");
    }
  });

  function dropScript() {
    if (!script) return;
    script = null;
    presetSel.value = "";
  }

  // ---- rendering ----
  // The scenario list and the action buttons are rebuilt only when the mode changes, so a
  // half-chosen scenario survives a render and a pressed button keeps its focus.
  let builtMode = null;
  let actionButtons = [];

  function buildForMode() {
    if (builtMode === state.mode) return;
    builtMode = state.mode;
    presetSel.replaceChildren(h("option", { value: "", text: "Free play" }));
    for (const p of PRESETS.filter((x) => x.mode === state.mode)) presetSel.append(h("option", { value: p.id, text: p.title }));
    presetSel.value = script ? script.preset.id : "";
    actionBox.replaceChildren();
    actionButtons = [];
    for (const a of state.mode === "gic" ? GIC_ACTIONS : CPU_ACTIONS) {
      const helpId = `${id}-help-${state.mode}-${a.key}`;
      const b = h("button", { type: "button", class: "il-btn", "aria-describedby": helpId, text: a.button });
      b.addEventListener("click", () => apply({ type: "do", key: a.key }));
      actionButtons.push({ key: a.key, button: b });
      actionBox.append(h("span", { class: "il-action" }, b, h("span", { class: "il-help", id: helpId, text: a.help })));
    }
  }

  function flag(text, on, extra = "") {
    return h("span", { class: `il-flag${on ? " il-flag--on" : ""}${extra}` }, h("span", { class: "il-mark", "aria-hidden": "true", text: on ? "●" : "○" }), ` ${text}`);
  }

  function renderCpuViz(r) {
    const cards = r.worlds.map((w, i) => {
      const k = CPU_KINDS[i];
      const pend = cpuPending(w);
      const last = r.rows.length ? r.rows[r.rows.length - 1].cells[i] : "-";
      const source = k.id === "level"
        ? flag(`line ${w.line ? "high" : "low"}`, w.line)
        : k.id === "latched"
          ? flag(`latch ${w.latch ? "set" : "clear"}`, w.latch)
          : flag("pulse only, nothing kept", false);
      const cpu = w.inHandler ? "in the handler" : w.masked ? "IRQs masked" : "IRQs unmasked, running";
      const dl = h("dl", { class: "il-dl" });
      const row = (a, b) => dl.append(h("dt", { text: a }), h("dd", { text: b }));
      row("CPU", cpu);
      row("Pending at the CPU", pend ? "yes" : "no");
      row("Handler ran", String(w.runs));
      if (k.id !== "level") row(k.id === "edge" ? "Events lost" : "Events merged", String(k.id === "edge" ? w.lost : w.merged));
      return h("section", { class: `il-card${pend ? " il-card--pending" : ""}${w.inHandler ? " il-card--handler" : ""}`, "aria-label": k.label },
        h("h4", { text: k.label }),
        source,
        dl,
        h("p", { class: "il-last" }, h("span", { class: "il-label", text: "Last step: " }), last),
      );
    });
    viz.replaceChildren(h("div", { class: "il-cards" }, ...cards));
  }

  function renderGicViz(r) {
    const g = r.gic;
    const cur = gicStateName(g);
    const states = h("ol", { class: "il-states", "aria-label": `States of INTID ${INTID}` });
    for (const s of GIC_STATES) {
      const on = s === cur;
      const li = h("li", { class: `il-state${on ? " il-state--current" : ""}` }, on ? h("span", { class: "il-mark", "aria-hidden": "true", text: "▶ " }) : null, s);
      if (on) li.append(h("span", { class: "il-vh", text: " (current)" }));
      states.append(li);
    }
    const lastIar = [...r.rows].reverse().find((x) => x.result !== null);
    const dl = h("dl", { class: "il-dl" });
    const row = (a, b) => dl.append(h("dt", { text: a }), h("dd", { text: b }));
    row("Trigger", g.trigger === "level" ? "level: pending follows the line" : "edge: a rising edge sets pending, the IAR clears it");
    row("Pending", gicPending(g) ? "yes" : "no");
    row("Active", g.active ? "yes" : "no");
    row("IRQ signalled to the CPU", gicSignalling(g) ? "yes (pending and not active)" : "no");
    row("Last IAR read", lastIar ? `${lastIar.result}${lastIar.result === SPURIOUS ? " (nothing to acknowledge)" : ""}` : "none yet");
    row(`IAR returned ${INTID}`, String(g.acks));
    row("EOIs", String(g.eois));
    viz.replaceChildren(h("div", { class: "il-gic" },
      flag(`device line ${g.line ? "high" : "low"}`, g.line, " il-flag--big"),
      states,
      dl,
    ));
  }

  function renderHistory(r) {
    const table = h("table", { class: "il-table" });
    const head = state.mode === "gic" ? ["#", "step", "line", `state of INTID ${INTID}`, "note"] : ["#", "step", ...CPU_KINDS.map((k) => k.label)];
    table.append(
      h("caption", { text: state.mode === "gic" ? `Every action so far and what the GIC did with INTID ${INTID}.` : "Every action so far and what it did in each world." }),
      h("thead", {}, h("tr", {}, ...head.map((x) => h("th", { scope: "col", text: x })))),
    );
    const body = h("tbody");
    if (!r.rows.length) body.append(h("tr", {}, h("td", { colspan: String(head.length), text: "Nothing yet. Press an action button, or pick a scenario." })));
    r.rows.forEach((row, i) => {
      const cells = state.mode === "gic" ? [row.step, row.line, row.state, row.note || ""] : [row.step, ...row.cells];
      const tr = h("tr", { class: i === r.rows.length - 1 ? "il-row--last" : null }, h("td", { text: String(i + 1) }));
      cells.forEach((c, j) => tr.append(j === 0 ? h("th", { scope: "row", text: c }) : h("td", { text: c })));
      body.append(tr);
    });
    table.append(body);
    historyWrap.replaceChildren(table);
  }

  function renderReal() {
    realBox.replaceChildren();
    const p = script?.preset || PRESETS.find((x) => x.mode === state.mode && (x.trigger || "level") === state.trigger && x.actions === state.actions);
    if (!p || !p.real || state.actions !== p.actions) return;
    realBox.append(
      h("p", { class: "il-label", text: "On the real machine" }),
      h("p", {}, p.real.says),
      h("p", { class: "il-quote" }, h("code", { text: p.real.quote })),
      h("p", { class: "il-src", text: `From the capture ${p.real.capture}.` }),
    );
  }

  function render() {
    const focused = globalThis.document?.activeElement ?? null;
    const r = replay(state);
    for (const m of MODES) modeInputs[m.id].checked = state.mode === m.id;
    trigBox.hidden = state.mode !== "gic";
    for (const t of ["level", "edge"]) trigInputs[t].checked = state.trigger === t;
    buildForMode();
    if (script) presetSel.value = script.preset.id;
    intro.textContent = INTRO[state.mode];
    for (const { key, button } of actionButtons) button.disabled = !canDo(state, key);
    const scripted = script && state.actions.length < script.actions.length;
    nextBtn.disabled = !scripted;
    undoBtn.disabled = !state.actions;
    resetBtn.disabled = !state.actions;
    if (script) {
      const k = script.actions[state.actions.length];
      const a = k ? (state.mode === "gic" ? GIC_ACTIONS : CPU_ACTIONS).find((x) => x.key === k) : null;
      scriptNote.textContent = a
        ? `${script.preset.goal} Step ${state.actions.length + 1} of ${script.actions.length}: ${a.button}.`
        : `${script.preset.goal} Done: all ${script.actions.length} steps.`;
    } else {
      scriptNote.textContent = "";
    }
    scriptNote.hidden = !script;
    if (state.mode === "gic") renderGicViz(r); else renderCpuViz(r);
    readout.textContent = summary(state);
    renderReal();
    renderHistory(r);
    // A focused control that just became disabled (Next step at the end of a scenario, Reset
    // with nothing left, an action that no longer applies) would drop focus to the page body.
    if (focused && focused.disabled && typeof readout.focus === "function") readout.focus();
  }

  render();
  ctx.hash.set(shareString(state, start));

  return {
    destroy() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
