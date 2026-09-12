import express from "express";

const app = express();
app.use(express.json({ limit: "4mb" }));

const PORT = process.env.PORT || 3000;
const CANVAS_W = 1000;
const CANVAS_H = 700;

let round = null;
let history = [];
let scores = { "澳澳": 0, "江玖": 0 };

function svgEscape(v) {
  return String(v ?? "").replace(/[<>&"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

function normalizePointPairs(points) {
  if (!Array.isArray(points)) return [];
  if (points.every(n => typeof n === "number")) {
    const out = [];
    for (let i = 0; i < points.length - 1; i += 2) out.push([points[i], points[i + 1]]);
    return out;
  }
  return points
    .filter(p => Array.isArray(p) && p.length >= 2)
    .map(p => [Number(p[0]), Number(p[1])]);
}

function strokesToSvg(strokes) {
  let paths = "";
  for (const s of strokes || []) {
    const pts = normalizePointPairs(s.points);
    if (pts.length < 2) continue;
    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0]} ${p[1]}`).join(" ");
    paths += `<path d="${d}" fill="none" stroke="${svgEscape(s.color || "#333")}" stroke-width="${Number(s.width) || 4}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}"><rect width="${CANVAS_W}" height="${CANVAS_H}" rx="20" fill="#fffafc"/>${paths}</svg>`;
}

const TOOLS = [
  {
    name: "draw_start",
    description: "开始一局你画我猜。传入真实答案、线条数组或 SVG，以及可接受的同义答案和出题者。",
    inputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "真实答案" },
        aliases: { type: "array", items: { type: "string" }, description: "可接受的同义答案" },
        artist: { type: "string", description: "出题者" },
        strokes: { type: "array", description: "线条数组，每项 {points, color, width}" },
        svg: { type: "string", description: "直接传 SVG（可选）" }
      },
      required: ["answer"]
    }
  },
  {
    name: "draw_status",
    description: "查看当前画作。返回画布尺寸、SVG、ASCII 网格和简短说明，不返回答案。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "draw_guess",
    description: "提交猜测。返回很短：猜对了，或者没猜中。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "猜测内容" },
        guesser: { type: "string", description: "猜的人" }
      },
      required: ["target"]
    }
  }
];

function jsonrpc(id, result) { return { jsonrpc: "2.0", id, result }; }

app.post("/mcp", (req, res) => {
  const { id, method, params } = req.body || {};
  if (method === "initialize") {
    return res.json(jsonrpc(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "draw-guess", version: "1.3.0" }
    }));
  }
  if (method === "tools/list") return res.json(jsonrpc(id, { tools: TOOLS }));
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === "draw_start") {
      const svg = args.svg || strokesToSvg(args.strokes);
      round = {
        answer: String(args.answer || "").trim(),
        aliases: (args.aliases || []).map(a => String(a).trim()),
        artist: args.artist || "AI",
        svg,
        created_at: new Date().toISOString(),
        guesses: [],
        solved: false
      };
      history.unshift({ answer: round.answer, artist: round.artist, at: round.created_at });
      history = history.slice(0, 50);
      return res.json(jsonrpc(id, { content: [{ type: "text", text: "画画提交成功，可以开始猜了。" }] }));
    }
    if (name === "draw_status") {
      if (!round) return res.json(jsonrpc(id, { content: [{ type: "text", text: "现在没有进行中的画。" }] }));
      return res.json(jsonrpc(id, { content: [{ type: "text", text: JSON.stringify({
        ok: true,
        current: { canvas: `${CANVAS_W}x${CANVAS_H}`, artist: round.artist, created_at: round.created_at, drawing_svg: round.svg }
      }) }] }));
    }
    if (name === "draw_guess") {
      if (!round) return res.json(jsonrpc(id, { content: [{ type: "text", text: "现在没有进行中的画。" }] }));
      const g = String(args.target || "").trim();
      const who = args.guesser || "?";
      const ok = g === round.answer || round.aliases.includes(g);
      round.guesses.push({ who, target: g, ok });
      if (ok) {
        round.solved = true;
        if (scores[who] === undefined) scores[who] = 0;
        scores[who] += 1;
      }
      return res.json(jsonrpc(id, { content: [{ type: "text", text: ok ? "猜对了！" : "没猜中。" }] }));
    }
    return res.json(jsonrpc(id, { content: [{ type: "text", text: "未知工具。" }] }));
  }
  return res.json(jsonrpc(id, { content: [{ type: "text", text: "ok" }] }));
});

app.get("/state", (req, res) => {
  res.json({
    current: round ? { artist: round.artist, svg: round.svg, solved: round.solved, guesses: round.guesses } : null,
    history,
    scores
  });
});

app.post("/guess", (req, res) => {
  if (!round) return res.json({ ok: false, msg: "现在没有进行中的画。" });
  const g = String(req.body?.target || "").trim();
  const who = req.body?.who || "澳澳";
  const ok = g === round.answer || round.aliases.includes(g);
  round.guesses.push({ who, target: g, ok });
  if (ok) {
    round.solved = true;
    if (scores[who] === undefined) scores[who] = 0;
    scores[who] += 1;
  }
  res.json({ ok, msg: ok ? "猜对了！" : "没猜中。" });
});

app.post("/draw", (req, res) => {
  const strokes = req.body?.strokes || [];
  const who = req.body?.who || "澳澳";
  round = {
    answer: "", aliases: [], artist: who, svg: strokesToSvg(strokes),
    created_at: new Date().toISOString(), guesses: [], solved: false
  };
  res.json({ ok: true });
});

app.post("/reset-score", (req, res) => {
  scores = { "澳澳": 0, "江玖": 0 };
  res.json({ ok: true, scores });
});

app.get("/health", (req, res) => res.json({ ok: true, hasRound: !!round }));

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>你画我猜</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; font-family:-apple-system,"PingFang SC",sans-serif; background:linear-gradient(160deg,#fdf2f6,#f7eefb); color:#4a3a44; padding:14px; }
  .wrap { max-width:620px; margin:0 auto; }
  .card { background:#fff; border-radius:20px; padding:14px; margin-bottom:12px; box-shadow:0 4px 18px rgba(200,150,180,.13); }
  h1 { font-size:17px; text-align:center; margin:6px 0 14px; letter-spacing:2px; font-weight:600; }
  h1 small { display:block; font-size:10px; letter-spacing:3px; color:#c9a8bb; font-weight:400; margin-top:3px; }
  .score { display:flex; justify-content:center; gap:18px; font-size:13px; color:#a97e97; margin-bottom:14px; }
  .score b { color:#8a5f7a; font-size:16px; }
  .canvasWrap { position:relative; width:100%; aspect-ratio:10/7; border-radius:16px; background:#fffafc; border:1px solid #f4e3ec; overflow:hidden; }
  .canvasWrap svg { position:absolute; inset:0; width:100%; height:100%; display:block; }
  .drawLayer { position:absolute; inset:0; z-index:5; touch-action:none; }
  .empty { position:absolute; inset:0; display:flex; align-items:center; justify-content:center; color:#d2bccb; font-size:13px; }
  .row { display:flex; gap:8px; margin-bottom:10px; }
  .btn { flex:1; border:none; border-radius:14px; padding:12px; font-size:13px; background:#fff; color:#a97e97; box-shadow:0 3px 12px rgba(200,150,180,.14); }
  .btn:active { transform:scale(.98); }
  .btn.primary { background:#f3d9e6; color:#8a5f7a; font-weight:600; }
  .btn.on { background:#e6bcd3; color:#fff; }
  input { width:100%; border:1px solid #f0dde8; border-radius:14px; padding:13px; font-size:15px; background:#fffafc; color:#4a3a44; }
  input:focus { outline:none; border-color:#e6bcd3; }
  .label { font-size:11px; color:#c9a8bb; letter-spacing:1px; margin:10px 0 6px; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; }
  .chip { font-size:12px; padding:5px 11px; border-radius:20px; background:#f7ecf3; color:#a97e97; }
  .chip.ok { background:#e3f5e8; color:#4e9a68; }
  .chip.no { background:#fdeaea; color:#c98a8a; }
  .hint { font-size:12px; color:#c9a8bb; text-align:center; padding:4px; }
  .colors { display:flex; gap:8px; align-items:center; justify-content:center; margin-bottom:10px; }
  .swatch { width:28px; height:28px; border-radius:50%; border:2px solid #fff; box-shadow:0 2px 6px rgba(0,0,0,.12); }
  .swatch.sel { border-color:#8a5f7a; transform:scale(1.15); }
</style>
</head>
<body>
<div class="wrap">
  <h1>你画我猜<small>DRAW GUESS</small></h1>
  <div class="score">
    <span>澳澳 <b id="scoreAo">0</b></span>
    <span>·</span>
    <span>江玖 <b id="scoreJiu">0</b></span>
  </div>

  <div class="card">
    <div class="label" id="canvasLabel">画板</div>
    <div class="canvasWrap" id="canvasWrap">
      <div id="svgBox"></div>
      <div class="empty" id="emptyTip">还没有画</div>
      <div class="drawLayer" id="drawLayer"></div>
    </div>
  </div>

  <div class="colors" id="colors" style="display:none"></div>

  <div class="row">
    <button class="btn" id="penBtn" onclick="togglePen()">✏️ 我来画</button>
    <button class="btn" id="eraseBtn" onclick="toggleErase()">🧽 橡皮</button>
    <button class="btn" onclick="undo()">↩︎ 撤销</button>
    <button class="btn" onclick="clearCanvas()">清空</button>
  </div>

  <div class="row" id="drawRow" style="display:none">
    <button class="btn primary" onclick="submitDraw()">我画好了 ✓</button>
  </div>

  <div class="row">
    <button class="btn primary" onclick="refresh()">刷新</button>
    <button class="btn" onclick="resetScore()">分数清零</button>
  </div>

  <div class="card">
    <div class="label">猜猜看</div>
    <input id="guessInput" placeholder="输入你猜的答案…" onkeydown="if(event.key==='Enter')doGuess()">
    <div class="row" style="margin-top:10px;margin-bottom:0">
      <button class="btn primary" onclick="doGuess()">提交</button>
    </div>
    <div class="hint" id="msg"></div>
  </div>

  <div class="card">
    <div class="label">记录</div>
    <div id="guesses" class="chips"></div>
  </div>
</div>

<script>
let penMode = false;
let eraseMode = false;
let drawing = false;
let strokes = [];
let cur = null;
let curColor = '#333333';
const PALETTE = ['#333333','#e57373','#f0a35e','#f3d34a','#7cc47f','#5aa9e6','#9b7fd4','#e58fc0'];
const svgBox = document.getElementById('svgBox');
const drawLayer = document.getElementById('drawLayer');
const emptyTip = document.getElementById('emptyTip');

function buildColors() {
  const box = document.getElementById('colors');
  box.innerHTML = PALETTE.map(c =>
    '<div class="swatch'+(c===curColor?' sel':'')+'" style="background:'+c+'" onclick="pickColor(\\''+c+'\\')"></div>'
  ).join('');
}
function pickColor(c) {
  curColor = c;
  eraseMode = false;
  document.getElementById('eraseBtn').classList.remove('on');
  buildColors();
}
function toggleErase() {
  eraseMode = !eraseMode;
  document.getElementById('eraseBtn').classList.toggle('on', eraseMode);
}

function svgFromStrokes(list) {
  let paths = '';
  for (const s of list) {
    if (!s.points || s.points.length < 2) continue;
    const d = s.points.map((p,i) => (i===0?'M':'L') + p[0] + ' ' + p[1]).join(' ');
    paths += '<path d="'+d+'" fill="none" stroke="'+s.color+'" stroke-width="'+s.width+'" stroke-linecap="round" stroke-linejoin="round"/>';
  }
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 700" preserveAspectRatio="none"><rect width="1000" height="700" fill="#fffafc"/>'+paths+'</svg>';
}

function renderLocal() {
  svgBox.innerHTML = svgFromStrokes(strokes);
  emptyTip.style.display = strokes.length ? 'none' : 'flex';
}

function pos(e) {
  const r = drawLayer.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return [ (t.clientX - r.left) / r.width * 1000, (t.clientY - r.top) / r.height * 700 ];
}

function start(e) {
  if (!penMode) return;
  e.preventDefault();
  drawing = true;
  cur = { points: [pos(e)], color: eraseMode ? '#fffafc' : curColor, width: eraseMode ? 30 : 5 };
  strokes.push(cur);
  renderLocal();
}
function move(e) {
  if (!drawing || !penMode) return;
  e.preventDefault();
  cur.points.push(pos(e));
  renderLocal();
}
function end() { if (!drawing) return; drawing = false; cur = null; }

drawLayer.addEventListener('touchstart', start, {passive:false});
drawLayer.addEventListener('touchmove', move, {passive:false});
drawLayer.addEventListener('touchend', end);
drawLayer.addEventListener('touchcancel', end);
drawLayer.addEventListener('mousedown', start);
drawLayer.addEventListener('mousemove', move);
drawLayer.addEventListener('mouseup', end);
drawLayer.addEventListener('mouseleave', end);

function togglePen() {
  penMode = !penMode;
  const b = document.getElementById('penBtn');
  b.classList.toggle('on', penMode);
  b.textContent = penMode ? '✏️ 画板已开' : '✏️ 我来画';
  document.getElementById('drawRow').style.display = penMode ? 'flex' : 'none';
  document.getElementById('colors').style.display = penMode ? 'flex' : 'none';
  document.getElementById('canvasLabel').textContent = penMode ? '画板（用手指画）' : '画板';
  if (penMode) { strokes = []; eraseMode = false; renderLocal(); buildColors(); }
}
function undo() { strokes.pop(); renderLocal(); }
function clearCanvas() { strokes = []; renderLocal(); }

async function submitDraw() {
  if (!strokes.length) { alert('还没画呢'); return; }
  await fetch('/draw', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ strokes, who:'澳澳' })
  });
  penMode = false;
  document.getElementById('penBtn').classList.remove('on');
  document.getElementById('penBtn').textContent = '✏️ 我来画';
  document.getElementById('drawRow').style.display = 'none';
  document.getElementById('colors').style.display = 'none';
  document.getElementById('canvasLabel').textContent = '画板';
  document.getElementById('msg').textContent = '画好了，等江玖来猜～';
  refresh();
}

async function refresh() {
  if (penMode) return;
  const r = await fetch('/state').then(x => x.json());
  if (r.current && r.current.svg) {
    svgBox.innerHTML = r.current.svg;
    emptyTip.style.display = 'none';
  } else {
    svgBox.innerHTML = '';
    emptyTip.style.display = 'flex';
  }
  document.getElementById('scoreAo').textContent = (r.scores && r.scores['澳澳']) || 0;
  document.getElementById('scoreJiu').textContent = (r.scores && r.scores['江玖']) || 0;
  const g = document.getElementById('guesses');
  const list = (r.current && r.current.guesses) || [];
  g.innerHTML = list.length ? list.map(x =>
    '<span class="chip ' + (x.ok ? 'ok' : 'no') + '">' + x.who + '：' + x.target + '</span>'
  ).join('') : '<span class="hint">还没有人猜</span>';
}

async function doGuess() {
  const el = document.getElementById('guessInput');
  const v = el.value.trim();
  if (!v) return;
  const r = await fetch('/guess', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ target:v, who:'澳澳' })
  }).then(x => x.json());
  document.getElementById('msg').textContent = r.msg || '';
  el.value = '';
  refresh();
}

async function resetScore() {
  await fetch('/reset-score', { method:'POST' });
  refresh();
}

refresh();
setInterval(() => { if (!penMode) refresh(); }, 4000);
</script>
</body>
</html>`);
});

app.listen(PORT, () => console.log("draw-guess on " + PORT));
