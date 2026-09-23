const root = document.documentElement;
const media = matchMedia("(prefers-color-scheme: dark)");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const $ = (id) => document.getElementById(id);

// Theme toggle: flips whatever is currently showing and remembers the choice
document.querySelector(".theme-toggle").addEventListener("click", () => {
  const current = root.dataset.theme || (media.matches ? "dark" : "light");
  const next = current === "dark" ? "light" : "dark";
  root.dataset.theme = next;
  try { localStorage.setItem("theme", next); } catch (e) {}
});

$("year").textContent = new Date().getFullYear();

// ---------------------------------------------------------------- formatting

function bytes(n, digits = 1) {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1000 && i < units.length - 1) { n /= 1000; i++; }
  return `${n.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

const rate = (n) => `${bytes(n)}/s`;

function uptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h ${m}m` : h ? `${h}h ${m}m` : `${m}m ${Math.floor(seconds % 60)}s`;
}

const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
function ago(time) {
  const seconds = (time - Date.now()) / 1000;
  const steps = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ---------------------------------------------------------------- charts

let history = [];
let historySize = 120;
let lastTickAt = performance.now();

const charts = {
  cpu: () => ({ lines: [{ values: history.map((p) => p.cpu), color: "--accent" }], min: 0, max: 100 }),
  mem: () => ({ lines: [{ values: history.map((p) => p.mem), color: "--accent" }], min: 0, max: 100 }),
  temp: () => {
    const values = history.map((p) => p.temp);
    return { lines: [{ values, color: "--accent" }], min: 25, max: Math.max(60, ...values.filter(Number.isFinite)) + 5 };
  },
  net: () => {
    const rx = history.map((p) => p.rx);
    const tx = history.map((p) => p.tx);
    return {
      lines: [{ values: rx, color: "--accent" }, { values: tx, color: "--accent-2", fill: false }],
      min: 0,
      max: Math.max(10_000, ...rx, ...tx) * 1.15,
    };
  },
};

function draw(canvas, { lines, min, max }, style) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Faint guide lines at a quarter, half and three quarters
  ctx.strokeStyle = style.getPropertyValue("--border");
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  for (const f of [0.25, 0.5, 0.75]) {
    ctx.beginPath();
    ctx.moveTo(0, Math.round(h * f) + 0.5);
    ctx.lineTo(w, Math.round(h * f) + 0.5);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // Points slide left between samples, so the chart scrolls instead of jumping
  const right = w - 4;
  const slot = right / (historySize - 2);
  const offset = reducedMotion.matches ? 0 : Math.min(1, (performance.now() - lastTickAt) / 1000);
  const x = (i, n) => right - (n - 1 - i + offset) * slot;
  const y = (v) => h - 3 - ((Math.min(max, Math.max(min, v)) - min) / (max - min)) * (h - 8);

  for (const line of lines) {
    const n = line.values.length;
    const points = line.values.map((v, i) => [x(i, n), y(v)]).filter((_, i) => Number.isFinite(line.values[i]));
    if (points.length < 2) continue;
    const color = style.getPropertyValue(line.color).trim();

    ctx.beginPath();
    points.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.75;
    ctx.lineJoin = "round";
    ctx.stroke();

    if (line.fill !== false) {
      ctx.lineTo(points.at(-1)[0], h);
      ctx.lineTo(points[0][0], h);
      ctx.closePath();
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, color + "40");
      gradient.addColorStop(1, color + "00");
      ctx.fillStyle = gradient;
      ctx.fill();
    }

    const [lx, ly] = points.at(-1);
    ctx.beginPath();
    ctx.arc(lx, ly, 2.75, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

const canvases = [...document.querySelectorAll(".spark")];
function frame() {
  if (history.length) {
    const style = getComputedStyle(root);
    for (const canvas of canvases) draw(canvas, charts[canvas.dataset.series](), style);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------- rendering

function renderTick(t) {
  $("uptime").textContent = uptime(t.uptime);
  $("watching").textContent = t.watching === 1 ? "1 (just you)" : t.watching;
  $("load").textContent = t.load.map((n) => n.toFixed(2)).join("  ");

  $("cpu").textContent = `${Math.round(t.cpu)}%`;
  const cores = $("cores");
  if (cores.children.length !== t.cores.length) {
    cores.replaceChildren(...t.cores.map(() => el("span")));
  }
  t.cores.forEach((v, i) => {
    cores.children[i].style.setProperty("--v", `${v}%`);
    cores.children[i].title = `Core ${i}: ${Math.round(v)}%`;
  });

  $("mem").textContent = bytes(t.mem.used);
  $("mem-sub").textContent = `of ${bytes(t.mem.total)}, ${Math.round((t.mem.used / t.mem.total) * 100)}% in use`;

  const temp = $("temp");
  temp.textContent = t.temp === null ? "n/a" : `${Math.round(t.temp)} °C`;
  temp.style.color = t.temp >= 85 ? "var(--bad)" : t.temp >= 70 ? "var(--warn)" : "";

  $("net").textContent = rate(t.net.rx + t.net.tx);
  $("rx").textContent = rate(t.net.rx);
  $("tx").textContent = rate(t.net.tx);
}

function renderInfo(info) {
  if (info.disk) {
    const pct = (info.disk.used / info.disk.total) * 100;
    $("disk").textContent = `${Math.round(pct)}%`;
    $("disk-bar").style.width = `${pct}%`;
    $("disk-sub").textContent = `${bytes(info.disk.used)} of ${bytes(info.disk.total, 0)} used`;
  }

  if (info.traffic) {
    $("rpm").textContent = `${info.traffic.perMinute}/min`;
    $("requests").textContent = info.traffic.requests.toLocaleString("en-GB");
  }

  if (info.containers.length) {
    $("containers").replaceChildren(...info.containers.map((c) => {
      const row = el("li");
      const usage = [c.cpu === null ? null : `CPU ${c.cpu.toFixed(1)}%`, c.mem === null ? null : bytes(c.mem, 0)]
        .filter(Boolean)
        .join(" · ");
      row.append(el("span", `state ${c.state}`), el("span", "name", c.name), el("span", "detail", c.status), el("span", "meta", usage));
      return row;
    }));
  }

  if (info.commits.length) {
    $("commits").replaceChildren(...info.commits.map((c) => {
      const row = el("li", "commit");
      const link = el("a", "name", c.subject);
      link.href = c.url;
      link.target = "_blank";
      link.rel = "noopener";
      row.append(el("span", "repo", c.repo), link, el("span", "meta", ago(c.time)));
      return row;
    }));
  }
}

// ---------------------------------------------------------------- stream

const status = document.querySelector(".status");
function setStatus(state, text) {
  status.dataset.state = state;
  $("conn").textContent = text;
}

const source = new EventSource("/events");

source.addEventListener("init", (event) => {
  const data = JSON.parse(event.data);
  history = data.history;
  historySize = data.historySize;
  lastTickAt = performance.now();
  if (data.latest) renderTick(data.latest);
  renderInfo(data.info);
  setStatus("live", "Live · streaming from the homelab");
});

source.addEventListener("tick", (event) => {
  const t = JSON.parse(event.data);
  history.push({ t: t.t, cpu: t.cpu, mem: (t.mem.used / t.mem.total) * 100, temp: t.temp, rx: t.net.rx, tx: t.net.tx });
  if (history.length > historySize) history.shift();
  lastTickAt = performance.now();
  renderTick(t);
});

source.addEventListener("info", (event) => renderInfo(JSON.parse(event.data)));

// EventSource retries by itself; this only tells the visitor what is going on
source.addEventListener("error", () => setStatus("down", "Connection lost · retrying..."));
