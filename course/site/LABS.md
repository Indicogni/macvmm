# Lab contract (for lab authors)

This is the contract between an in-browser lab and the course site builder. If your lab follows
it, the builder ships it, embeds it in every lesson that says `:::lab <name>`, gives it a
standalone page at `/build-your-own/vmm/labs/<name>/`, and lists it on the labs index. Nothing
else needs to change in the builder.

The lab list, priorities and owning chapters come from `course/CURRICULUM.md` (section 8 and
each chapter's **Lab** line) through `course/chapters.json`. Use the lab name exactly as it is
spelled there (`esr-decoder`, `two-stage-walker`, `virtqueue-visualizer`, ...). A lab that a
primer embeds is listed under that primer's `labs` in `chapters.json` when CURRICULUM says so
("(in the `elf` primer)", "the `uefi` primer also embeds"), and always in the primer's own
`labs:` front matter.

**Status (2026-11-20).** What exists today: `lib/frontmatter.mjs`, `lib/html.mjs`,
`lib/highlight.mjs`, `lib/curriculum.mjs` with `gen-chapters.mjs`, the vectors in `labs/vectors/`,
and the tests in `test/`. The builder itself (`build.mjs`, `lib/md.mjs`, `lib/svg.mjs`,
`serve.mjs`, `package.json`) is not written yet. Everything below that says "the builder does X"
is the contract it will implement; write your lab against it now, and test the model with
`node --test`.

## 1. Files

```
course/site/src/labs/<name>/
  model.mjs        REQUIRED. Pure logic: no DOM, no window, no fetch at import time.
  view.mjs         REQUIRED. Exports mount(el, ctx). The only file the page imports directly.
  style.css        optional. Scoped styles (see section 5).
  lab.json         optional. {"title": "...", "goal": "one sentence"} for the lab shell and index.
  fallback.svg     optional. Static picture shown with JS off or if the lab fails to load.
  *.json, *.mjs    optional. Extra data or modules, loaded by relative URL.
  *.test.mjs       tests (node --test). Never shipped.
course/site/src/labs/_shared/   optional helpers shared by several labs (also shipped).
course/site/labs/vectors/*.json test vectors exported from the Rust reference (cargo xtask export-vectors).
```

The builder copies every `.mjs`, `.js`, `.css`, `.json` and `.svg` file in the lab directory to
`assets/labs/<name>/` in the output, except `*.test.mjs`. Other file types are a build error, so a
stray binary never ships by accident. `fallback.svg` is sanitized and inlined into the page (see
`lib/svg.mjs`): it must have a `<title>` and a `<desc>`, and it must not contain scripts, event
handlers, `<foreignObject>` or external references.

If `view.mjs` does not exist yet, lessons that embed the lab render a clearly marked
"Lab not built yet" placeholder and the build prints a WARNING (an error under `--strict`).

## 2. The mount function

```js
// course/site/src/labs/esr-decoder/view.mjs
import { decode } from "./model.mjs";

export function mount(el, ctx) {
  // el: an empty <div class="lab__root"> that you own. Render everything inside it.
  // ctx: see below.
  // ...build DOM with document.createElement, attach listeners with addEventListener...
  return { destroy() { /* remove timers and listeners added outside el */ } }; // optional
}
```

`mount` may be `async`. It is called once per embed, after the page's DOM is ready. If it throws
(or its promise rejects), the shell shows "This lab failed to load" plus the error text, and the
static fallback stays visible. A page can embed several labs, and the same lab more than once, so
never use fixed element ids: derive them from `ctx.id`.

`ctx` has:

| Field | Meaning |
|-------|---------|
| `ctx.name` | The lab name (`"esr-decoder"`). |
| `ctx.id` | A page-unique prefix for element ids (`"lab-esr-decoder-1"`). |
| `ctx.base` | Absolute URL of `assets/labs/<name>/`, for `fetch(new URL("sample.dtb", ctx.base))`. `import.meta.url` works too. |
| `ctx.standalone` | `true` on `/labs/<name>/`, `false` when embedded in a lesson. |
| `ctx.reducedMotion` | `true` if the reader prefers reduced motion. Start paused; offer Step. |
| `ctx.announce(text)` | Speaks `text` through the page's polite live region. Throttle to about one call per 300 ms. |
| `ctx.hash.get()` | The lab's share-state string from `location.hash` (`#esr-decoder=0x93C08045`), or `null`. |
| `ctx.hash.set(str)` | Writes the share state (`history.replaceState`, no scroll, no history spam). `null` clears it. |

The shell around `el` (title, goal line, "Runs in browser" badge, Reset is yours to draw) is
emitted by the builder:

```html
<section class="lab" data-lab="esr-decoder" aria-labelledby="lab-esr-decoder-1-title">
  <header class="lab__head">
    <span class="tag">Lab</span>
    <h2 id="lab-esr-decoder-1-title">ESR decoder</h2>   <!-- from lab.json title, else the name -->
    <p class="lab__goal">...</p>                         <!-- from lab.json goal -->
    <span class="badge badge--browser">Runs in browser</span>
  </header>
  <div class="lab__fallback">...fallback.svg or a text note...</div>
  <noscript><p>This lab needs JavaScript. ...</p></noscript>
  <div class="lab__root"></div>                          <!-- your el -->
</section>
```

The fallback is hidden by the shell once `mount` returns successfully.

## 3. Model rules (model.mjs)

- Pure ES module. No DOM, no globals, no I/O at import time, so `node --test` can import it.
- All lab logic lives here: decoding, walking, parsing, state transitions. The view only renders
  `state` and turns events into model calls.
- State is one plain object. Prefer `next = step(state, action)` over mutation.
- Parsers are real parsers and are hardened like the Rust ones: bounds checks, overflow checks,
  loop detection, explicit error values. Never `eval`, `new Function` or `setTimeout("string")`.
- Correctness beats looks. Cross-check against `course/site/labs/vectors/*.json` (exported from
  the reference's unit tests) in a `*.test.mjs` next to the model. If the vector file does not
  exist yet, write the test to skip with a message, not to pass silently.

## 4. Security and CSP rules (hard)

The site ships `Content-Security-Policy: default-src 'self'; script-src 'self'; ...` (DESIGN.md
section 7). Concretely, a lab must not:

1. use inline scripts, `on*=` attributes, `javascript:` URLs, `eval`, `new Function`, or string timers;
2. load anything from another origin (no CDN, fonts, analytics, images, or `fetch` to the internet);
3. create `blob:` or `data:` workers (same-origin worker files are fine: `new Worker(new URL("w.mjs", import.meta.url), {type: "module"})`);
4. use WebAssembly (it would need `'wasm-unsafe-eval'`; ask the lead first);
5. assign untrusted strings to `innerHTML`. Build DOM with `createElement` and `textContent`.
   A file the reader drops in (DTB, Image, trace) is hostile input: parse it in the model, cap
   sizes (say 16 MiB), never upload it, never render its strings as HTML;
6. touch anything outside `el`, except `ctx.hash`, `ctx.announce` and its own `localStorage`
   key `vmm-lab-<name>-v1`. Wrap every storage access in `try/catch`; the lab must work without it.

## 5. Styling

- `style.css` is linked in the page head only where the lab appears. Scope every rule under
  `.lab[data-lab="<name>"]` (the builder warns about unscoped selectors).
- Use the site's tokens only, so dark mode works for free: `--paper --ink --muted --rule --card
  --accent --on-accent --accent-tint --code-bg --code-ink --code-muted --tok-kw --tok-str
  --tok-num --tok-fn --tok-com --tok-ty --ok --warn --danger --mono --sans --serif`.
  Do not hard-code colors.
- Never color alone: changed bits, faults and pass/fail also carry text, an outline or a pattern.
- Below 720px, stack: controls, then visualization, then readout. Wide visualizations scroll
  inside their own `overflow-x: auto` box. The page itself must never scroll sideways at 320px.
- Touch targets at least 44px (dense grids: 28px cells minimum).
- Transitions at most 150ms, none under `prefers-reduced-motion: reduce`.

## 6. Accessibility

- Every control is a native element (`button`, `input`, `select`, `label`) with an accessible name.
- Custom widgets (bit grids, trees) use roving tabindex plus arrow keys (ARIA APG), with a visible
  one-line instructions note.
- One readout node is the summary: plain text, updated by `ctx.announce` (or your own
  `aria-live="polite" aria-atomic="true"` node inside `el`).
- Escape closes anything you open. No keyboard traps.

## 7. Testing and checks

- `node --test course/site/` (Node 22 or later) runs every `*.test.mjs` in the site tree,
  including yours and the shared ones in `course/site/test/`.
- The builder fails on: a missing `model.mjs` when `view.mjs` exists, a disallowed file type,
  a `view.mjs` that does not contain `export function mount` or `export async function mount`,
  or any of these strings in shipped lab code: `eval(`, `new Function`, `innerHTML =` with a
  non-literal, `http://`, `https://` (outside comments).
- Once the builder exists: run `node course/site/build.mjs`, then open
  `course/site/public/build-your-own/vmm/labs/<name>/index.html` through `npm run dev` (or
  `node course/site/serve.mjs`) to try it. Until then, exercise the model with `node --test`.

## 8. Embedding from a lesson

```
:::lab esr-decoder
```

One line, no closing fence (a `:::` after it would close nothing and is an error). In a
chapter, the lab must be in the front matter's `labs`, which must equal that chapter's `labs` in
`course/chapters.json` (generated from the chapter's **Lab** line in CURRICULUM.md);
`scripts/check-lessons` fails otherwise, so the curriculum and the lessons cannot drift apart
silently. In a primer, the front matter's `labs:` list and the `:::lab` lines must agree
(`course/site/test/primers.test.mjs` checks it).
