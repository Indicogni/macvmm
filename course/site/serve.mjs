#!/usr/bin/env node
// Local preview server for the built site (course/site/dist/). Node built-ins only.
//
//   node course/site/build.mjs && node course/site/serve.mjs [--port 8787] [--host 127.0.0.1]
//
// It serves files by request path, the way the Cloudflare Worker's static assets do
// (DESIGN.md §10.1): `/x/` serves `/x/index.html`, `/x` redirects to `/x/` when that directory
// exists, and a missing path gets the nearest `404.html` walking up. It applies the headers from
// `dist/_headers`, including the production Content-Security-Policy, so a CSP violation shows up
// in the browser console here before it ever reaches production. Caching headers are replaced by
// `no-store` so edits show on reload. It binds to 127.0.0.1 by default and never serves a path
// outside dist/.

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, sep, extname, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = dirname(fileURLToPath(import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".xml": "application/xml; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".png": "image/png", ".dtb": "application/octet-stream",
  ".jsonl": "application/json; charset=utf-8", ".ico": "image/x-icon",
};

/** Parse a Cloudflare `_headers` file into [{ pattern: RegExp, headers: [[k, v]] }]. */
export function parseHeaders(text) {
  const rules = [];
  let cur = null;
  for (const raw of text.split("\n")) {
    if (raw.trim() === "" || raw.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const re = new RegExp("^" + raw.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
      cur = { pattern: re, headers: [] };
      rules.push(cur);
    } else if (cur) {
      const i = raw.indexOf(":");
      if (i > 0) cur.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export function headersFor(rules, path) {
  const out = {};
  for (const r of rules) if (r.pattern.test(path)) for (const [k, v] of r.headers) out[k] = v;
  return out;
}

/** Map a request path to a file under `dist`, or a redirect, or a 404 page. */
export function resolvePath(dist, urlPath) {
  let p;
  try { p = decodeURIComponent(urlPath.split("?")[0].split("#")[0]); } catch { return { status: 400 }; }
  if (p.includes("\0") || p.includes("\\")) return { status: 400 };
  // Collapse leading slashes: "//host" must never become a protocol-relative redirect.
  p = "/" + p.replace(/^\/+/, "");
  const abs = normalize(join(dist, p));
  if (abs !== dist && !abs.startsWith(dist + sep)) return { status: 403 };
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    if (!p.endsWith("/")) {
      // Build the redirect from where the file really is, never from the raw request path, so
      // "/%2F%2Fevil.example/../x" cannot produce "Location: //evil.example/...".
      const loc = "/" + relative(dist, abs).split(sep).filter(Boolean).join("/") + "/";
      return { status: 308, location: loc.replace(/^\/+/, "/") };
    }
    const idx = join(abs, "index.html");
    if (existsSync(idx)) return { status: 200, file: idx };
  } else if (existsSync(abs) && statSync(abs).isFile() && !abs.endsWith(`${sep}_headers`)) {
    return { status: 200, file: abs };
  } else if (existsSync(abs + ".html")) {
    return { status: 200, file: abs + ".html" };
  }
  // Nearest 404.html walking up, like the Worker's not_found_handling: "404-page".
  let dir = dirname(abs);
  while (dir.startsWith(dist)) {
    const f = join(dir, "404.html");
    if (existsSync(f)) return { status: 404, file: f };
    if (dir === dist) break;
    dir = dirname(dir);
  }
  return { status: 404 };
}

export function makeServer(dist) {
  const headersPath = join(dist, "_headers");
  return createServer((req, res) => {
    const rules = existsSync(headersPath) ? parseHeaders(readFileSync(headersPath, "utf8")) : [];
    const url = req.url || "/";
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end(); return; }
    const pathOnly = url.split("?")[0];
    if (pathOnly === "/") { res.writeHead(302, { Location: "/build-your-own/vmm/" }); res.end(); return; }
    const r = resolvePath(dist, url);
    const h = { ...headersFor(rules, pathOnly), "Cache-Control": "no-store" };
    if (r.location) { res.writeHead(r.status, { ...h, Location: r.location }); res.end(); return; }
    if (!r.file) { res.writeHead(r.status, { ...h, "Content-Type": "text/plain; charset=utf-8" }); res.end(`${r.status}\n`); return; }
    const body = readFileSync(r.file);
    res.writeHead(r.status, { ...h, "Content-Type": TYPES[extname(r.file)] || "application/octet-stream", "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
  const dist = normalize(opt("--dir", join(SITE, "dist")));
  if (!existsSync(join(dist, "_headers"))) {
    console.error(`no built site in ${dist}: run node course/site/build.mjs first`);
    process.exit(1);
  }
  const port = Number(opt("--port", "8787"));
  const host = opt("--host", "127.0.0.1");
  makeServer(dist).listen(port, host, () => console.log(`Serving ${dist} at http://${host}:${port}/build-your-own/vmm/ (Ctrl-C to stop)`));
}
