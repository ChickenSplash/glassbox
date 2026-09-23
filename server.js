"use strict";

// Glass box: mirrors one btop screen from the homelab to every open page over
// Server-Sent Events, alongside its containers, portfolio traffic and recent commits.

const http = require("node:http");
const crypto = require("node:crypto");
const net = require("node:net");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { Terminal } = require("@xterm/headless");
const { SerializeAddon } = require("@xterm/addon-serialize");

const PORT = Number(process.env.PORT || 8080);
const DOCKER = process.env.DOCKER_PROXY || "http://socket-proxy:2375";
const NGINX_STATUS = process.env.NGINX_STATUS || "http://portfolio:8081/nginx_status";
const BTOP_SOCKET = process.env.BTOP_SOCKET || "/run/btop/btop.sock";
const THEME_DIR = process.env.THEME_DIR || "/theme";
const COLS = Number(process.env.BTOP_COLS || 120);
const ROWS = Number(process.env.BTOP_ROWS || 34);
const REPO_DIR = process.env.REPO_DIR || "/repos";
// "name=owner/repo,..." : /repos/<name> is the mounted .git dir, owner/repo its GitHub slug
const REPOS = (process.env.REPOS || "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [name, slug] = entry.split("=");
    return { name, slug, dir: path.join(REPO_DIR, name) };
  });

const MAX_CLIENTS = 200;
// Generous, since a whole office or household can share one address
const MAX_PER_IP = 10;

// ---------------------------------------------------------------- btop

// A headless copy of the screen, so a new viewer starts from the current picture
// instead of waiting for btop to repaint everything.
const screen = new Terminal({ cols: COLS, rows: ROWS, scrollback: 0, allowProposedApi: true });
const serializer = new SerializeAddon();
screen.loadAddon(serializer);

let btopUp = false;
let btopSocket = null;
let pending = [];

function connectBtop() {
  const socket = (btopSocket = net.connect(BTOP_SOCKET));
  socket.on("connect", () => {
    btopUp = true;
    screen.reset();
  });
  socket.on("data", (chunk) => pending.push(chunk));
  socket.on("error", () => {});
  socket.on("close", () => {
    btopUp = false;
    setTimeout(connectBtop, socket.restarting ? 300 : 3000);
  });
}

// btop's net box shows the interface's address, and has no setting to hide it. Any
// IPv4 address is swapped for dots of the same width so the layout stays put. No \b:
// the address follows straight on from an escape sequence's final "m".
const DOT = Buffer.from("•").toString("latin1");
const maskIps = (buffer) => Buffer.from(
  buffer.toString("latin1").replace(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g, (ip) => ip.replace(/\d/g, DOT)),
  "latin1",
);

// btop writes in many small pieces; batching them keeps it to ~20 frames a second
function flushTerm() {
  if (!pending.length) return;
  const data = maskIps(Buffer.concat(pending));
  pending = [];
  screen.write(data);
  broadcast("term", data.toString("base64"));
}

// ---------------------------------------------------------------- theme

// The homelab's central palette (theme-apply writes palette.json), turned into the
// page's CSS variables. The terminal stays in btop's own mode; the page follows the
// visitor's light or dark preference.
function paletteCss(p) {
  const vars = (c, dark) => [
    `--bg: ${c.background}`,
    `--surface: ${dark ? c.surface_container : `color-mix(in srgb, ${c.background} 40%, #fff)`}`,
    `--text: color-mix(in srgb, ${c.on_background} ${dark ? 55 : 45}%, ${dark ? "#fff" : "#000"})`,
    `--muted: ${dark ? `color-mix(in srgb, ${c.on_background} 80%, ${c.background})` : c.on_background}`,
    `--border: color-mix(in srgb, ${c.outline} 35%, ${c.background})`,
    `--accent: ${c.primary}`,
    `--accent-text: ${c.on_primary}`,
    `--glow: color-mix(in srgb, ${c.primary} ${dark ? 18 : 12}%, transparent)`,
  ].join("; ");
  const t = p.colors[p.mode || "dark"];
  const term = `--term-bg: ${t.background}; --term-fg: ${t.on_background}; --term-a: ${t.primary}; --term-b: ${t.secondary}`;
  const dark = vars(p.colors.dark, true);
  return [
    `:root { ${vars(p.colors.light, false)}; ${term}; color-scheme: light }`,
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${dark}; color-scheme: dark } }`,
    `:root[data-theme="dark"] { ${dark}; color-scheme: dark }`,
  ].join("\n");
}

let themeCss = "";
function loadTheme() {
  try {
    const css = paletteCss(JSON.parse(fs.readFileSync(path.join(THEME_DIR, "palette.json"), "utf8")));
    if (css === themeCss) return false;
    themeCss = css;
    return true;
  } catch (e) {
    return false;
  }
}
loadTheme();

// theme-apply swaps palette.json in with a rename, so watch the directory. By then the
// btop theme is already rewritten, so btop is restarted to pick it up.
let themeTimer;
try {
  fs.watch(THEME_DIR, (event, name) => {
    if (name !== "palette.json") return;
    clearTimeout(themeTimer);
    themeTimer = setTimeout(() => {
      if (!loadTheme()) return;
      broadcast("theme", { css: themeCss });
      if (btopSocket) {
        btopSocket.restarting = true;
        btopSocket.destroy();
      }
    }, 300);
  });
} catch (e) {}

// ---------------------------------------------------------------- slow sources

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!response.ok) throw new Error(`${url}: ${response.status}`);
  return response.json();
}

const prevContainerCpu = new Map();

async function readContainers() {
  const list = await getJson(`${DOCKER}/containers/json?all=1`);
  const containers = await Promise.all(list.map(async (c) => {
    const item = {
      name: c.Names[0].replace(/^\//, ""),
      state: c.State,
      status: c.Status,
      cpu: null,
      mem: null,
    };
    if (c.State !== "running") return item;
    try {
      const s = await getJson(`${DOCKER}/containers/${c.Id}/stats?stream=false&one-shot=true`);
      const usage = s.cpu_stats.cpu_usage.total_usage;
      const system = s.cpu_stats.system_cpu_usage;
      const prev = prevContainerCpu.get(c.Id);
      // Share of the whole machine, from the change since the last poll
      if (prev && system > prev.system) item.cpu = ((usage - prev.usage) / (system - prev.system)) * 100;
      prevContainerCpu.set(c.Id, { usage, system });
      const m = s.memory_stats;
      item.mem = m.usage - (m.stats?.inactive_file ?? 0);
    } catch (e) {}
    return item;
  }));
  return containers.sort((a, b) => a.name.localeCompare(b.name));
}

// stub_status counts its own requests too, so each of our polls is taken off the total
const traffic = { requests: null, active: null, perMinute: 0, lastRaw: null, window: [] };

async function readTraffic() {
  const response = await fetch(NGINX_STATUS, { signal: AbortSignal.timeout(3000) });
  const text = await response.text();
  const active = Number(text.match(/Active connections:\s*(\d+)/)[1]);
  const raw = Number(text.match(/\n\s*\d+\s+\d+\s+(\d+)/)[1]);
  const now = Date.now();

  if (traffic.lastRaw === null || raw < traffic.lastRaw) {
    // First poll, or nginx restarted and its counter reset
    traffic.requests = (traffic.requests ?? 0) + Math.max(0, raw - 1);
    traffic.window = [];
  } else {
    const delta = Math.max(0, raw - traffic.lastRaw - 1);
    traffic.requests += delta;
    traffic.window.push({ t: now, n: delta });
  }
  traffic.lastRaw = raw;
  traffic.active = Math.max(0, active - 1);
  traffic.window = traffic.window.filter((w) => now - w.t <= 60_000);
  traffic.perMinute = traffic.window.reduce((sum, w) => sum + w.n, 0);
}

function gitLog(repo) {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-c", "safe.directory=*", "--git-dir", repo.dir, "log", "--no-merges", "-n", "8", "--format=%H%x1f%ct%x1f%s"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) return resolve([]);
        resolve(stdout.trim().split("\n").filter(Boolean).map((line) => {
          const [hash, time, subject] = line.split("\x1f");
          return {
            repo: repo.name,
            hash: hash.slice(0, 7),
            time: Number(time) * 1000,
            subject,
            url: `https://github.com/${repo.slug}/commit/${hash}`,
          };
        }));
      },
    );
  });
}

async function readCommits() {
  const logs = await Promise.all(REPOS.map(gitLog));
  return logs.flat().sort((a, b) => b.time - a.time).slice(0, 8);
}

// ---------------------------------------------------------------- state

const info = { containers: [], traffic: null, commits: [] };

function tick() {
  return { uptime: parseFloat(fs.readFileSync("/proc/uptime", "utf8")), watching: clients.size, btop: btopUp };
}

async function refreshInfo() {
  const [containers] = await Promise.allSettled([readContainers(), readTraffic()]);
  if (containers.status === "fulfilled") info.containers = containers.value;
  info.traffic = traffic.requests === null
    ? null
    : { requests: traffic.requests, perMinute: traffic.perMinute, active: traffic.active };
  broadcast("info", info);
}

async function refreshCommits() {
  info.commits = await readCommits();
}

// ---------------------------------------------------------------- streaming

const clients = new Set();
const perIp = new Map();

function frame(event, data) {
  return `event: ${event}\ndata: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`;
}

function broadcast(event, data) {
  if (!clients.size) return;
  const text = frame(event, data);
  for (const client of clients) client.write(text);
}

function stream(req, res) {
  // cloudflared puts the visitor's address in CF-Connecting-IP. Only held in memory
  // while the connection is open, to cap connections per visitor.
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
  if (clients.size >= MAX_CLIENTS || (perIp.get(ip) || 0) >= MAX_PER_IP) {
    res.writeHead(503, { "Retry-After": "30", "Content-Type": "text/plain" });
    return res.end("Too many viewers right now, try again shortly.\n");
  }

  // btop's output is mostly repeated colour escapes and compresses around tenfold.
  // Each frame is flushed through gzip straight away so the stream stays live.
  const gzip = /\bgzip\b/.test(req.headers["accept-encoding"] || "");
  res.writeHead(200, {
    ...securityHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    ...(gzip && { "Content-Encoding": "gzip" }),
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  let out = res;
  if (gzip) {
    out = zlib.createGzip();
    out.pipe(res);
  }
  const client = {
    write(text) {
      out.write(text);
      if (gzip) out.flush(zlib.constants.Z_SYNC_FLUSH);
    },
    end: () => out.end(),
  };
  client.write("retry: 5000\n\n");

  // Send what is batched to everyone else first: the snapshot already includes it
  flushTerm();
  clients.add(client);
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  client.write(frame("init", {
    cols: COLS,
    rows: ROWS,
    screen: Buffer.from(serializer.serialize()).toString("base64"),
    theme: themeCss,
    tick: tick(),
    info,
  }));

  req.on("close", () => {
    clients.delete(client);
    if (gzip) out.destroy();
    const left = (perIp.get(ip) || 1) - 1;
    if (left) perIp.set(ip, left); else perIp.delete(ip);
  });
}

// ---------------------------------------------------------------- http

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    // xterm.js injects <style> elements for its colours and layout
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

// Every public file is loaded once at start, so there is no path handling on requests
const files = new Map();
function serve(route, file) {
  files.set(route, { body: fs.readFileSync(file), type: types[path.extname(file)] || "application/octet-stream" });
}
for (const name of fs.readdirSync(path.join(__dirname, "public"))) {
  serve(name === "index.html" ? "/" : `/${name}`, path.join(__dirname, "public", name));
}
serve("/vendor/xterm.js", require.resolve("@xterm/xterm/lib/xterm.js"));
serve("/vendor/xterm.css", require.resolve("@xterm/xterm/css/xterm.css"));
serve("/vendor/addon-webgl.js", require.resolve("@xterm/addon-webgl/lib/addon-webgl.js"));

// Cloudflare overrides Cache-Control on static files to cache them for hours, so the
// page links each asset with a hash of its content and a deploy is picked up at once
{
  const index = files.get("/");
  let html = index.body.toString();
  for (const [route, file] of files) {
    if (route === "/") continue;
    const hash = crypto.createHash("sha256").update(file.body).digest("hex").slice(0, 10);
    html = html.replaceAll(`"${route.slice(1)}"`, `"${route.slice(1)}?v=${hash}"`);
  }
  index.body = Buffer.from(html);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  if (url.pathname === "/events") return stream(req, res);
  if (url.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("ok\n");
  }

  const file = files.get(url.pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found\n");
  }
  const body = url.pathname === "/"
    ? Buffer.from(file.body.toString().replace("<!--palette-->", `<style id="palette">${themeCss}</style>`))
    : file.body;
  res.writeHead(200, { ...securityHeaders, "Content-Type": file.type, "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : body);
});

// A comment line now and then keeps idle proxies from dropping the stream
const keepAlive = setInterval(() => { for (const client of clients) client.write(": ping\n\n"); }, 15_000);

connectBtop();
setInterval(flushTerm, 50);
setInterval(() => broadcast("tick", tick()), 1000);
setInterval(refreshInfo, 5000);
setInterval(refreshCommits, 60_000);
refreshCommits().then(refreshInfo);

server.listen(PORT, () => console.log(`glassbox listening on :${PORT}`));

function shutdown() {
  clearInterval(keepAlive);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
