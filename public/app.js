const root = document.documentElement;
const media = matchMedia("(prefers-color-scheme: dark)");
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

const decode = (base64) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

// ---------------------------------------------------------------- terminal

const FONT = '"JetBrains Mono", ui-monospace, monospace';
const box = $("term");
let term = null;

// Pick the font size that makes btop's fixed number of columns fill the frame. Cells
// snap to whole device pixels, so width is not proportional to font size: scale from
// what actually rendered, then step down until it fits.
function fit() {
  if (!term) return;
  // The window always spans the page column, so its edges line up with the content
  const pad = parseFloat(getComputedStyle(root).getPropertyValue("--term-pad"));
  const width = box.clientWidth - pad * 2;
  const screen = box.querySelector(".xterm-screen");
  // offsetWidth ignores the scale applied below, so this is the size xterm drew at
  const rendered = () => screen.offsetWidth;
  const round = (n) => Math.floor(n * 10) / 10;

  for (let i = 0; i < 3; i++) {
    const size = round(term.options.fontSize * (width / rendered()));
    if (!Number.isFinite(size) || size === term.options.fontSize) break;
    term.options.fontSize = size;
  }
  while (rendered() > width && term.options.fontSize > 4) {
    term.options.fontSize = round(term.options.fontSize - 0.1);
  }

  // With 120 columns, whole-pixel cells leave up to 120px spare. Scale the last bit
  // so btop fills the window exactly. btop's outer border runs through the middle of
  // the edge cells, and cells are taller than wide, so the top and bottom padding give
  // back the difference and the gap looks even all round.
  const scale = width / rendered();
  const w = rendered() * scale;
  const h = screen.offsetHeight * scale;
  const padY = Math.max(0, pad - (h / term.rows - w / term.cols) / 2);
  screen.style.transformOrigin = "0 0";
  screen.style.transform = `scale(${scale})`;
  box.style.padding = `${padY}px ${pad}px`;
  box.style.height = `${h + padY * 2}px`;
}

async function createTerm(cols, rows) {
  // xterm measures the font once when it opens, so it has to be loaded first
  await Promise.all(["400", "700"].map((w) => document.fonts.load(`${w} 16px "JetBrains Mono"`)));
  term = new Terminal({
    cols,
    rows,
    fontFamily: FONT,
    fontSize: 12,
    lineHeight: 1,
    scrollback: 0,
    disableStdin: true,
    cursorInactiveStyle: "none",
    theme: { background: getComputedStyle(root).getPropertyValue("--term-bg").trim() },
  });
  term.open(box);

  // WebGL keeps every glyph in its own cell, which matters for btop's braille graphs:
  // few fonts have braille, and a fallback font's wider dots would push the grid out
  try {
    const webgl = new WebglAddon.WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch (e) {}
  fit();
}

// Only width matters: fit() sets the height itself
let resizeTimer;
let lastWidth = 0;
new ResizeObserver(([entry]) => {
  const width = entry.contentRect.width;
  if (width === lastWidth) return;
  lastWidth = width;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(fit, 100);
}).observe(document.querySelector(".stage"));

// The server sends the homelab's palette as CSS; swapping it in recolours the page
function applyTheme(css) {
  if (!css) return;
  let style = $("palette");
  if (!style) {
    style = el("style");
    style.id = "palette";
    document.head.append(style);
  }
  if (style.textContent === css) return;
  style.textContent = css;
  if (term) term.options.theme = { background: getComputedStyle(root).getPropertyValue("--term-bg").trim() };
}

// ---------------------------------------------------------------- rendering

function renderTick(t) {
  $("uptime").textContent = uptime(t.uptime);
  $("watching").textContent = t.watching === 1 ? "1 (just you)" : t.watching;
}

function renderInfo(info) {
  if (info.traffic) {
    $("requests").textContent = info.traffic.requests.toLocaleString("en-GB");
    $("rpm").textContent = `${info.traffic.perMinute} req`;
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

let ready = null;

function connect() {
  const source = new EventSource("/events");

  source.addEventListener("init", (event) => {
    const data = JSON.parse(event.data);
    applyTheme(data.theme);
    renderTick(data.tick);
    renderInfo(data.info);
    setStatus("live", "Live · streaming from the homelab");

    // On a reconnect the old screen is replaced by the fresh snapshot
    ready = (async () => {
      if (!term) await createTerm(data.cols, data.rows);
      else term.resize(data.cols, data.rows);
      term.reset();
      term.write(decode(data.screen));
    })();
  });

  source.addEventListener("term", async (event) => {
    if (!ready) return;
    await ready;
    term.write(decode(event.data));
  });

  source.addEventListener("theme", (event) => applyTheme(JSON.parse(event.data).css));
  source.addEventListener("tick", (event) => renderTick(JSON.parse(event.data)));
  source.addEventListener("info", (event) => renderInfo(JSON.parse(event.data)));

  source.addEventListener("error", () => {
    ready = null;
    if (source.readyState === EventSource.CLOSED) {
      // Turned away (too many viewers, or the box is down): EventSource gives up
      // on a non-200 answer, so start again later
      setStatus("down", "Can't reach the homelab · trying again shortly...");
      setTimeout(connect, 30_000);
    } else {
      setStatus("down", "Connection lost · retrying...");
    }
  });
}

connect();
