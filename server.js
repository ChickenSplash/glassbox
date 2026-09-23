"use strict";

// Glass box: reads the homelab's vitals once a second and streams them to every
// open page over Server-Sent Events. One sampler, many viewers, no dependencies.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const PORT = Number(process.env.PORT || 8080);
const DOCKER = process.env.DOCKER_PROXY || "http://socket-proxy:2375";
const NGINX_STATUS = process.env.NGINX_STATUS || "http://portfolio:8081/nginx_status";
const NET_DEV = process.env.NET_DEV || "/host/netdev";
const NET_IFACE = process.env.NET_IFACE || "enp1s0";
const REPO_DIR = process.env.REPO_DIR || "/repos";
// "name=owner/repo,..." : /repos/<name> is the mounted .git dir, owner/repo its GitHub slug
const REPOS = (process.env.REPOS || "")
  .split(",")
  .filter(Boolean)
  .map((entry) => {
    const [name, slug] = entry.split("=");
    return { name, slug, dir: path.join(REPO_DIR, name) };
  });

const HISTORY = 120;
const MAX_CLIENTS = 200;
const MAX_PER_IP = 4;

// ---------------------------------------------------------------- host readers

const read = (file) => fs.readFileSync(file, "utf8");

function readCpu() {
  return read("/proc/stat")
    .split("\n")
    .filter((line) => /^cpu\d* /.test(line))
    .map((line) => {
      const [user, nice, system, idle, iowait, irq, softirq, steal] = line.trim().split(/\s+/).slice(1).map(Number);
      return { idle: idle + iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
    });
}

function readMem() {
  const info = Object.fromEntries(
    read("/proc/meminfo").split("\n").filter(Boolean).map((line) => {
      const [key, value] = line.split(":");
      return [key, parseInt(value, 10) * 1024];
    }),
  );
  return { used: info.MemTotal - info.MemAvailable, total: info.MemTotal };
}

// The CPU package sensor from coretemp, falling back to the hottest hwmon reading
const tempFile = (() => {
  const base = "/sys/class/hwmon";
  try {
    for (const hw of fs.readdirSync(base)) {
      if (read(path.join(base, hw, "name")).trim() === "coretemp") return path.join(base, hw, "temp1_input");
    }
    for (const hw of fs.readdirSync(base)) {
      const file = path.join(base, hw, "temp1_input");
      if (fs.existsSync(file)) return file;
    }
  } catch (e) {}
  return null;
})();

function readTemp() {
  if (!tempFile) return null;
  try { return parseInt(read(tempFile), 10) / 1000; } catch (e) { return null; }
}

function readNet() {
  const line = read(NET_DEV).split("\n").find((l) => l.trim().startsWith(NET_IFACE + ":"));
  if (!line) return null;
  const fields = line.split(":")[1].trim().split(/\s+/).map(Number);
  return { rx: fields[0], tx: fields[8] };
}

function readDisk() {
  const s = fs.statfsSync("/");
  return { used: (s.blocks - s.bfree) * s.bsize, total: s.blocks * s.bsize };
}

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
      ["-c", "safe.directory=*", "--git-dir", repo.dir, "log", "-n", "8", "--format=%H%x1f%ct%x1f%s"],
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

// ---------------------------------------------------------------- sampler

const history = [];
const info = { containers: [], traffic: null, disk: null, commits: [] };
let latest = null;
let prevCpu = readCpu();
let prevNet = readNet();
let prevAt = Date.now();

function sample() {
  const now = Date.now();
  const dt = (now - prevAt) / 1000;
  const cpu = readCpu();
  const net = readNet();

  const pct = cpu.map((c, i) => {
    const total = c.total - prevCpu[i].total;
    return total > 0 ? Math.max(0, Math.min(100, (1 - (c.idle - prevCpu[i].idle) / total) * 100)) : 0;
  });
  const mem = readMem();
  const [load1, load5, load15] = read("/proc/loadavg").split(" ").slice(0, 3).map(Number);

  latest = {
    t: now,
    cpu: round(pct[0]),
    cores: pct.slice(1).map(round),
    mem,
    temp: readTemp(),
    net: net && prevNet && dt > 0
      ? { rx: Math.max(0, (net.rx - prevNet.rx) / dt), tx: Math.max(0, (net.tx - prevNet.tx) / dt) }
      : { rx: 0, tx: 0 },
    load: [load1, load5, load15],
    uptime: parseFloat(read("/proc/uptime")),
    watching: clients.size,
  };
  prevCpu = cpu;
  prevNet = net;
  prevAt = now;

  history.push({
    t: now,
    cpu: latest.cpu,
    mem: round((mem.used / mem.total) * 100),
    temp: latest.temp,
    rx: Math.round(latest.net.rx),
    tx: Math.round(latest.net.tx),
  });
  if (history.length > HISTORY) history.shift();

  broadcast("tick", latest);
}

async function refreshInfo() {
  const [containers] = await Promise.allSettled([readContainers(), readTraffic()]);
  if (containers.status === "fulfilled") info.containers = containers.value;
  info.traffic = traffic.requests === null
    ? null
    : { requests: traffic.requests, perMinute: traffic.perMinute, active: traffic.active };
  broadcast("info", info);
}

async function refreshSlow() {
  try { info.disk = readDisk(); } catch (e) {}
  info.commits = await readCommits();
}

const round = (n) => Math.round(n * 10) / 10;

// ---------------------------------------------------------------- streaming

const clients = new Set();
const perIp = new Map();

function send(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  if (!clients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

function stream(req, res) {
  // cloudflared puts the visitor's address in CF-Connecting-IP. Only held in memory
  // while the connection is open, to cap connections per visitor.
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
  if (clients.size >= MAX_CLIENTS || (perIp.get(ip) || 0) >= MAX_PER_IP) {
    res.writeHead(503, { "Retry-After": "30", "Content-Type": "text/plain" });
    return res.end("Too many viewers right now, try again shortly.\n");
  }

  res.writeHead(200, {
    ...securityHeaders,
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 5000\n\n");
  clients.add(res);
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  send(res, "init", { history, latest, info, historySize: HISTORY });

  req.on("close", () => {
    clients.delete(res);
    const left = (perIp.get(ip) || 1) - 1;
    if (left) perIp.set(ip, left); else perIp.delete(ip);
  });
}

// ---------------------------------------------------------------- http

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' data:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "interest-cohort=()",
};

const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

// Every public file is loaded once at start, so there is no path handling on requests
const files = new Map(
  fs.readdirSync(path.join(__dirname, "public")).map((name) => [
    name === "index.html" ? "/" : `/${name}`,
    { body: fs.readFileSync(path.join(__dirname, "public", name)), type: types[path.extname(name)] || "application/octet-stream" },
  ]),
);

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
  if (url.pathname === "/api/snapshot") {
    res.writeHead(200, { ...securityHeaders, "Content-Type": "application/json", "Cache-Control": "no-cache" });
    return res.end(JSON.stringify({ latest, info }));
  }

  const file = files.get(url.pathname);
  if (!file) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("Not found\n");
  }
  res.writeHead(200, { ...securityHeaders, "Content-Type": file.type, "Cache-Control": "no-cache" });
  res.end(req.method === "HEAD" ? undefined : file.body);
});

// A comment line now and then keeps idle proxies from dropping the stream
const keepAlive = setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 15_000);

setInterval(sample, 1000);
setInterval(refreshInfo, 5000);
setInterval(refreshSlow, 60_000);
refreshSlow().then(refreshInfo);

server.listen(PORT, () => console.log(`glassbox listening on :${PORT}`));

function shutdown() {
  clearInterval(keepAlive);
  for (const res of clients) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
