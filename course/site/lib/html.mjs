// Tiny HTML helpers shared by the renderer and the page builder.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escape text for HTML element content and double-quoted attributes. */
export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);
}

/** Heading text -> URL fragment id ("Two stages, one map" -> "two-stages-one-map"). */
export function slugify(s) {
  return (
    String(s)
      .toLowerCase()
      .replace(/<[^>]*>/g, "")
      .replace(/&[a-z#0-9]+;/g, "")
      .replace(/[`*_]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section"
  );
}

/**
 * Fill `{{name}}` slots in a template. Every slot in the template must be provided and every
 * provided value must be used, so a typo in either place is a build error, not a blank page.
 * Values are inserted verbatim (callers escape).
 */
export function fill(template, values, name = "template") {
  const used = new Set();
  const out = template.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (_, k) => {
    if (!Object.hasOwn(values, k)) throw new Error(`${name}: no value for slot {{${k}}}`);
    used.add(k);
    return String(values[k]);
  });
  for (const k of Object.keys(values)) {
    if (!used.has(k)) throw new Error(`${name}: value "${k}" given but the template has no {{${k}}} slot`);
  }
  return out;
}

/** Inline SVG icons (decorative: always aria-hidden). Kept tiny and stroke-based so they theme via currentColor. */
export const ICONS = {
  chip: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><rect x="4" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3" stroke="currentColor" stroke-width="1.5"/></svg>',
  window: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M1.5 5.5h13" stroke="currentColor" stroke-width="1.5"/></svg>',
  clock: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  shield: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M8 1.5 2.5 3.5v4c0 3.2 2.3 5.8 5.5 7 3.2-1.2 5.5-3.8 5.5-7v-4z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  flask: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M6 1.5h4M6.5 1.5v4.5L2.5 13a1 1 0 0 0 .9 1.5h9.2a1 1 0 0 0 .9-1.5L9.5 6V1.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  aside: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4.5M8 4.5v.5" stroke="currentColor" stroke-width="1.5"/></svg>',
  gear: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="2.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M8 1v2.5M8 12.5V15M1 8h2.5M12.5 8H15M3 3l1.8 1.8M11.2 11.2 13 13M3 13l1.8-1.8M11.2 4.8 13 3" stroke="currentColor" stroke-width="1.5"/></svg>',
  box: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M2 4.5 8 1.5l6 3v7l-6 3-6-3z M2 4.5l6 3 6-3M8 7.5v7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  question: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6 6.2a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.3v.4M8 11.5v.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  check: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="m3 8.5 3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.75"/></svg>',
  pen: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16"><path d="M10.5 2.5l3 3-8 8H2.5v-3z" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  terminal: '<svg class="icon" aria-hidden="true" viewBox="0 0 16 16" width="14" height="14"><path d="m3 4.5 3 3-3 3M8 11.5h5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
};

/** "mac" | "browser" | "mac+browser" -> badge chips (text + shape, never color alone). */
export function badges(runs) {
  const out = [];
  if (runs === "mac" || runs === "mac+browser") out.push(`<span class="badge badge--mac">${ICONS.chip}Needs a Mac</span>`);
  if (runs === "browser" || runs === "mac+browser") out.push(`<span class="badge badge--browser">${ICONS.window}Runs in browser</span>`);
  return out.join(" ");
}

export function minutesLabel(m) {
  if (m == null) return "~15-30 min";
  if (m < 90) return `~${m} min`;
  const h = m / 60;
  return `~${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}
