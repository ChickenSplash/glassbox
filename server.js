"use strict";

// Glass box: mirrors one btop screen from the homelab to every open page over
// Server-Sent Events, alongside its containers, own traffic and recent commits,
// and answers questions with a small model running on the same CPU.

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
const BTOP_SOCKET = process.env.BTOP_SOCKET || "/run/btop/btop.sock";
const THEME_DIR = process.env.THEME_DIR || "/theme";
// The one file the app may write on the host: a preset name, which theme-apply there
// validates and applies
const THEME_CHOICE = process.env.THEME_CHOICE || "/theme-choice/theme";
const LLM = process.env.LLM || "http://llm:8080";
const FACTS = process.env.FACTS || path.join(__dirname, "ask/facts.md");
const PROMPT = process.env.PROMPT || path.join(__dirname, "ask/prompt.md");
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
// page's CSS variables. The page is dark only; the terminal follows btop's own mode.
function paletteCss(p) {
  const c = p.colors.dark;
  const t = p.colors[p.mode || "dark"];
  // The window border fades from the lighter of the two accents at the top, where the
  // page's glow is, to the darker at the bottom
  const luma = (hex) => [1, 3, 5].reduce((sum, i, k) => sum + parseInt(hex.slice(i, i + 2), 16) * [0.2126, 0.7152, 0.0722][k], 0);
  const [lighter, darker] = [t.primary, t.secondary].sort((a, b) => luma(b) - luma(a));
  const vars = [
    `--bg: ${c.background}`,
    `--surface: ${c.surface_container}`,
    `--text: color-mix(in srgb, ${c.on_background} 55%, #fff)`,
    `--muted: color-mix(in srgb, ${c.on_background} 80%, ${c.background})`,
    `--border: color-mix(in srgb, ${c.outline} 35%, ${c.background})`,
    `--accent: ${c.primary}`,
    `--glow: color-mix(in srgb, ${c.primary} 18%, transparent)`,
    `--term-bg: ${t.background}`,
    `--term-a: ${lighter}`,
    `--term-b: ${darker}`,
    `--window-inactive: ${c.outline}`,
  ];
  return `:root { ${vars.join("; ")} }`;
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

// Count requests reaching this app, rather than another site's nginx. Static files
// served from Cloudflare's cache never reach us; /healthz and HEAD probes are excluded.
// One bucket per second keeps memory bounded even if someone makes many requests.
let totalRequests = 0;
const requestSeconds = new Map();

function requestStats() {
  const oldest = Math.floor(Date.now() / 1000) - 59;
  for (const second of requestSeconds.keys()) {
    if (second < oldest) requestSeconds.delete(second);
  }
  return { total: totalRequests, perMinute: [...requestSeconds.values()].reduce((sum, n) => sum + n, 0) };
}

function countRequest() {
  const second = Math.floor(Date.now() / 1000);
  totalRequests++;
  requestSeconds.set(second, (requestSeconds.get(second) || 0) + 1);
  requestStats();
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

// Whatever llama.cpp has loaded, so swapping the model file needs no page edit.
// "/models/Qwen3.5-4B-Q4_K_M.gguf" becomes "Qwen3.5-4B · Q4_K_M"
async function readModel() {
  const props = await getJson(`${LLM}/props`);
  const name = path.basename(props.model_path, ".gguf");
  return name.replace(/-((?:I?Q\d|B?F\d)\w*)$/i, " · $1");
}

async function readCommits() {
  const logs = await Promise.all(REPOS.map(gitLog));
  return logs.flat().sort((a, b) => b.time - a.time).slice(0, 8);
}

// ---------------------------------------------------------------- state

const info = { containers: [], requests: requestStats(), commits: [], model: null };

function tick() {
  return { uptime: parseFloat(fs.readFileSync("/proc/uptime", "utf8")), watching: clients.size, btop: btopUp };
}

async function refreshInfo() {
  try { info.containers = await readContainers(); } catch (e) {}
  try { info.model = await readModel(); } catch (e) {}
  info.requests = requestStats();
  broadcast("info", info);
}

async function refreshCommits() {
  info.commits = await readCommits();
}

// ---------------------------------------------------------------- ask

// The model has 6 slow cores to itself for one answer at a time, so everyone else
// waits in line. Caps keep one visitor from holding the CPU.
const ASK_QUEUE_MAX = 6;
const ASK_PER_IP = 10;
const ASK_WINDOW = 10 * 60_000;
const ASK_TURNS = 3;
const ASK_MAX_TOKENS = 200;

// Visitors can recolour the homelab from the chat, but only to a preset generated
// from a seed colour (themes/, see make-presets)
const THEMES = fs.readdirSync(path.join(__dirname, "themes"))
  .filter((name) => name.endsWith(".json") && name !== "seeds.json")
  .map((name) => name.slice(0, -5))
  .sort();

const TOOLS = [{
  type: "function",
  function: {
    name: "set_theme",
    description: "Change the colour theme of the whole homelab: this page, its btop and its terminal. Only when a visitor asks to change the theme or colours; pick the closest colour.",
    parameters: {
      type: "object",
      properties: { colour: { type: "string", enum: THEMES } },
      required: ["colour"],
    },
  },
}];

// A 4B model sometimes answers "done, it's blue now" without calling the tool,
// especially after a few changes in a row, and forcing the call makes it ramble.
// So a message that names a preset and reads as a request, not a question about it
// ("make it blue", "pink please", "can you go teal?"), makes the call for it; the
// model is left the vaguer requests ("make it look like the sea").
function requestedTheme(question) {
  const q = question.toLowerCase();
  const named = THEMES.filter((name) => new RegExp(`\\b${name}\\b`).test(q));
  if (named.length !== 1) return null;
  if (/^(what|which|why|how|is|are|does|do|was|were|who|when|where)\b/.test(q)) return null;
  const request = (q.split(/\s+/).length <= 4 && !/\b(like|love|hate|nice|cool|ugly)\b/.test(q))
    || /\b(make|set|change|switch|turn|go|use|paint|try|apply|want|give|can|could|would|let's|lets)\b/.test(q);
  return request ? named[0] : null;
}

function currentTheme() {
  try {
    return fs.readFileSync(THEME_CHOICE, "utf8").trim();
  } catch (e) {
    return "";
  }
}

// Returns what happened: `result` for the model to pass on, `note` for the page
function setTheme(colour) {
  const fail = (note, result) => ({ ok: false, note: `Couldn't change the theme to ${colour}: ${note}`, result });
  if (!THEMES.includes(colour)) return fail("no such theme", `There is no ${colour} theme. The choices are: ${THEMES.join(", ")}.`);
  const current = currentTheme();
  if (colour === current) return fail("it already is", `Nothing to do: the theme is already ${colour}.`);

  const tmp = path.join(path.dirname(THEME_CHOICE), ".theme.tmp");
  fs.writeFileSync(tmp, `${colour}\n`);
  fs.renameSync(tmp, THEME_CHOICE);
  return { ok: true, note: `Changed the theme to ${colour}`, result: `Changed: the theme is now ${colour}.` };
}

// Prompt and facts are both mounted read-only and reloaded on each request, so the
// personality can be adjusted without rebuilding the app.
function systemPrompt() {
  return `${fs.readFileSync(PROMPT, "utf8").trim()}\n\nFacts:${facts()}`;
}

// Read on every question so edits to facts.md apply without a rebuild. The note at
// the top of the file is for whoever edits it, not the model.
function facts() {
  try {
    const text = fs.readFileSync(FACTS, "utf8");
    return text.slice(Math.max(0, text.indexOf("\n## ")));
  } catch (e) {
    return "";
  }
}

// Supply changing information only for questions about it. It cannot go in the
// system prompt: changing that would make llama.cpp re-read it on every question.
function liveContext(messages) {
  const question = messages.at(-1).content;
  const recentQuestions = messages.filter((m) => m.role === "user").map((m) => m.content).join(" ");
  const parts = [];
  if (/\b(date|year|today|time|month|day of the week)\b|\b\d{4}\b/i.test(recentQuestions)) {
    parts.push(`Current date and time in Norfolk: ${new Intl.DateTimeFormat("en-GB", {
      dateStyle: "full", timeStyle: "short", timeZone: "Europe/London",
    }).format(new Date())}`);
  }
  if (/\b(uptime|how long (have you|has (it|the server))|running for)\b/i.test(question)) {
    parts.push(`Uptime: ${uptime(tick().uptime)}`);
  }
  if (/\b(watching|viewers|visitors|online now)\b/i.test(question)) {
    parts.push(`Viewing this page: ${clients.size}`);
  }
  if (/\b(containers?|docker|running on (you|the server))\b/i.test(question)) {
    parts.push(`Running containers: ${info.containers.filter((c) => c.state === "running").map((c) => c.name).join(", ")}`);
  }
  if (/\b(commits?|latest change|recent change)\b/i.test(question) && info.commits[0]) {
    parts.push(`Latest commit: "${info.commits[0].subject}" in ${info.commits[0].repo}`);
  }
  if (/\b(themes?|colou?rs?|look like|make it|turn it|go)\b/i.test(question)) {
    if (currentTheme()) parts.push(`Current theme: ${currentTheme()}`);
    parts.push("Only a set_theme call changes the theme; saying it changed does nothing");
  }
  return parts.length ? `\n\n(Current server data, use only if relevant: ${parts.join("; ")})` : "";
}

function uptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d} days ${h} hours` : h ? `${h} hours ${m} minutes` : `${m} minutes`;
}

// Only the last few turns, each trimmed, whatever the page sends
function cleanHistory(messages) {
  if (!Array.isArray(messages)) return null;
  const turns = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({
      role: m.role,
      content: m.content.trim().slice(0, m.role === "user" ? 400 : 1200),
      // A theme change this answer made, sent back so the model sees it really called
      // the tool. Without it, a few "Done, it's blue now" replies in a row teach it
      // to just say so and skip the call.
      ...(m.role === "assistant" && THEMES.includes(m.theme?.colour) && typeof m.theme.result === "string"
        && { theme: { colour: m.theme.colour, result: m.theme.result.slice(0, 300) } }),
    }))
    .filter((m) => m.content)
    .slice(-(ASK_TURNS * 2 - 1));
  if (!turns.length || turns.at(-1).role !== "user") return null;
  while (turns[0].role !== "user") turns.shift();
  return turns;
}

// Past answers that changed the theme become the tool call, its result and the reply
function expandHistory(messages) {
  return messages.flatMap((m, i) => m.theme
    ? [
      { role: "assistant", content: "", tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "set_theme", arguments: JSON.stringify({ colour: m.theme.colour }) } }] },
      { role: "tool", tool_call_id: `call_${i}`, content: m.theme.result },
      { role: "assistant", content: m.content },
    ]
    : [{ role: m.role, content: m.content }]);
}

const askLog = new Map();
const askBusy = new Set();
const askQueue = [];
let askRunning = false;

function askAllowed(ip) {
  const now = Date.now();
  const recent = (askLog.get(ip) || []).filter((t) => now - t < ASK_WINDOW);
  if (recent.length) askLog.set(ip, recent); else askLog.delete(ip);
  return recent.length < ASK_PER_IP;
}

// Everyone waiting hears how many answers are ahead of them
function nextAsk() {
  if (!askRunning && askQueue.length) {
    askRunning = true;
    askQueue.shift().run().finally(() => {
      askRunning = false;
      nextAsk();
    });
  }
  askQueue.forEach((job, i) => job.send({ queue: i + 1 }));
}
setInterval(() => { for (const ip of askLog.keys()) askAllowed(ip); }, ASK_WINDOW);

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

async function ask(req, res) {
  const ip = req.headers["cf-connecting-ip"] || req.socket.remoteAddress;
  const reply = (status, error) => {
    res.writeHead(status, { ...securityHeaders, "Content-Type": "application/json" });
    res.end(JSON.stringify({ error }));
  };

  // Only from this page, not other sites borrowing the CPU
  const origin = req.headers.origin;
  if (origin && origin.replace(/^https?:\/\//, "") !== req.headers.host) return reply(403, "Not allowed.");

  let messages;
  try {
    messages = cleanHistory(JSON.parse(await readBody(req, 16_384)).messages);
  } catch (e) {}
  if (!messages) return reply(400, "Ask a question first.");
  if (askBusy.has(ip)) return reply(429, "One question at a time, please.");
  if (!askAllowed(ip)) return reply(429, "That's plenty of questions for now. Try again in a few minutes.");
  if (askQueue.length >= ASK_QUEUE_MAX) return reply(503, "Lots of people are asking right now. Try again in a minute.");

  askLog.set(ip, [...(askLog.get(ip) || []), Date.now()]);
  askBusy.add(ip);

  // One JSON object per line: queue position, then pieces of the answer
  res.writeHead(200, {
    ...securityHeaders,
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  });
  const send = (data) => { if (!res.destroyed) res.write(JSON.stringify(data) + "\n"); };
  const abort = new AbortController();
  let finished = false;
  const job = {
    send,
    async run() {
      if (finished) return;
      send({ queue: 0 });
      try {
        await streamAnswer(messages, send, abort.signal);
        send({ done: true });
      } catch (e) {
        if (!abort.signal.aborted) send({ error: "The model isn't answering right now. Try again shortly." });
      }
      finished = true;
      res.end();
    },
  };
  res.on("close", () => {
    askBusy.delete(ip);
    if (finished) return;
    finished = true;
    abort.abort();
    const i = askQueue.indexOf(job);
    if (i >= 0) askQueue.splice(i, 1);
  });
  askQueue.push(job);
  nextAsk();
}

function complete(messages, options) {
  return fetch(`${LLM}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: options.signal,
    body: JSON.stringify({
      max_tokens: ASK_MAX_TOKENS,
      temperature: 0.6,
      top_p: 0.9,
      cache_prompt: true,
      chat_template_kwargs: { enable_thinking: false },
      // Always sent, even when a tool call is not wanted: the template puts the tools
      // in the system prompt, which has to stay identical to stay cached
      tools: TOOLS,
      ...options.body,
      messages: [
        { role: "system", content: systemPrompt() },
        ...expandHistory(messages.slice(0, -1)),
        { role: "user", content: `${messages.at(-1).content}${liveContext(messages)}` },
        ...(options.after || []),
      ],
    }),
  });
}

// Reading the prompt from cold takes the CPU ~30s. Doing it once up front, and again
// when the facts change, leaves it cached so a visitor's first word comes in ~2s.
// Qwen3.5 is a hybrid model: llama.cpp can only rewind its cache to a saved
// checkpoint, hence --checkpoint-min-step 0 in docker-compose.yml.
async function warmUp(tries = 20) {
  try {
    const response = await complete([{ role: "user", content: "Hi" }], {
      signal: AbortSignal.timeout(120_000),
      body: { max_tokens: 1 },
    });
    if (!response.ok) throw new Error(`llm: ${response.status}`);
    await response.text();
  } catch (e) {
    // Still loading the model
    if (tries > 1) setTimeout(() => warmUp(tries - 1), 5000);
  }
}
let factsTimer;
try {
  fs.watch(path.dirname(FACTS), () => {
    clearTimeout(factsTimer);
    factsTimer = setTimeout(warmUp, 2000);
  });
} catch (e) {}

// Text is passed on as it arrives. If the model asks to change the theme instead,
// that is done here and the model is asked again, with the outcome, for its reply.
async function streamAnswer(messages, send, signal) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
  const requested = requestedTheme(messages.at(-1).content);
  const call = requested
    ? { name: "set_theme", arguments: JSON.stringify({ colour: requested }) }
    : await streamReply(messages, send, signal);
  if (!call) return;

  let colour;
  try {
    colour = String(JSON.parse(call.arguments).colour).toLowerCase();
  } catch (e) {}
  const { ok, note, result } = call.name === "set_theme" && colour
    ? setTheme(colour)
    : { ok: false, note: "Couldn't change the theme", result: "That tool does not exist." };
  send({ tool: { ok, note, colour, result } });

  await streamReply(messages, send, signal, [
    { role: "assistant", content: "", tool_calls: [{ id: "call_0", type: "function", function: call }] },
    { role: "tool", tool_call_id: "call_0", content: result },
  ]);
}

// OpenAI-style SSE from llama.cpp. Returns the tool call, if the model made one
// (only the first, and never after a tool result has been given).
async function streamReply(messages, send, signal, after) {
  const response = await complete(messages, { signal, after, body: { stream: true } });
  if (!response.ok) throw new Error(`llm: ${response.status}`);

  const decoder = new TextDecoder();
  let buffer = "";
  let call = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
      const delta = JSON.parse(line.slice(6)).choices?.[0]?.delta;
      if (delta?.content) send({ t: delta.content });
      for (const piece of delta?.tool_calls || []) {
        if (piece.index) continue;
        call ??= { name: "", arguments: "" };
        call.name += piece.function?.name || "";
        call.arguments += piece.function?.arguments || "";
      }
    }
  }
  return after ? null : call;
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
    info: { ...info, requests: requestStats() },
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
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
};

// Every public file is loaded once at start, so there is no path handling on requests
const files = new Map();
function serve(route, file) {
  files.set(route, { body: fs.readFileSync(file), type: types[path.extname(file)] || "application/octet-stream" });
}
for (const name of fs.readdirSync(path.join(__dirname, "public"))) {
  if (name === "fonts") continue;
  serve(name === "index.html" ? "/" : `/${name}`, path.join(__dirname, "public", name));
}
// Adwaita Mono (OFL, licence alongside), cut down to the characters the chat uses
for (const name of fs.readdirSync(path.join(__dirname, "public/fonts"))) {
  if (name.endsWith(".woff2")) serve(`/fonts/${name}`, path.join(__dirname, "public/fonts", name));
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
  if (url.pathname !== "/healthz" && req.method !== "HEAD") countRequest();

  if (url.pathname === "/ask") {
    if (req.method === "POST") return ask(req, res);
    res.writeHead(405, { Allow: "POST" });
    return res.end();
  }
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
refreshCommits().then(refreshInfo).then(() => warmUp());

server.listen(PORT, () => console.log(`glassbox listening on :${PORT}`));

function shutdown() {
  clearInterval(keepAlive);
  for (const client of clients) client.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
