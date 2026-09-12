import express from "express";

const app = express();
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;
const CANVAS_W = 1000;
const CANVAS_H = 700;

let round = null;
let history = [];

function svgEscape(v) {
  return String(v ?? "").replace(/[<>"'&]/g, ch => ({
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
    .map(p => [Number(p[0]), Number(p[1])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
}

function strokesToSvg(strokes, width = CANVAS_W, height = CANVAS_H) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" rx="20" fill="#fffafc"/>`
  ];
  for (const stroke of (strokes || []).slice(0, 80)) {
    const points = normalizePointPairs(stroke.points);
    if (!points.length) continue;
    const d = points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
    const color = svgEscape(stroke.color || "#4f454b");
    const lineWidth = Math.max(1, Math.min(28, Number(stroke.width || 7)));
    parts.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${lineWidth}" stroke-linecap="round" stroke-linejoin="round"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

function makeAsciiGrid(strokes, width = CANVAS_W, height = CANVAS_H, cols = 60, rows = 42) {
  const grid = Array.from({ length: rows }, () => Array(cols).fill("."));
  function mark(x, y) {
    const col = Math.max(0, Math.min(cols - 1, Math.floor((x / width) * cols)));
    const row = Math.max(0, Math.min(rows - 1, Math.floor((y / height) * rows)));
    grid[row][col] = "#";
  }
  for (const stroke of (strokes || [])) {
    const points = normalizePointPairs(stroke.points);
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1];
      const [x2, y2] = points[i];
      const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 8));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        mark(x1 + (x2 - x1) * t, y1 + (y2 - y1) * t);
      }
    }
  }
  return grid.map(r => r.join("")).join("\n");
}

// ---------- MCP 工具 ----------
function publicDrawingForMcp(r) {
  if (!r) return { ok: false, current: null, message: "还没有当前画作。" };
  return {
    ok: true,
    current: {
      canvas: "1000x700",
      artist: r.artist,
      created_at: r.created_at,
      drawing_svg: r.drawing_svg,
      ascii_grid: r.ascii_grid,
      ascii_grid_note: "ascii_grid 为 60 列 x 42 行；# 表示线条经过，. 表示空白。请结合 SVG 路径和整体轮廓判断，不要只看单个散点。"
    }
  };
}

const TOOLS = [
  {
    name: "draw_start",
    description: "开始一局你画我猜。传入真实答案、线条数组（polyline）或 SVG，以及可接受的同义答案和出题者。返回一句短结果，前端看不到答案。",
    inputSchema: {
      type: "object",
      properties: {
        answer: { type: "string", description: "真实答案" },
        aliases: { type: "array", items: { type: "string" }, description: "可接受的同义答案" },
        artist: { type: "string", description: "出题者，AI 或 用户" },
        strokes: { type: "array", description: "线条数组，每项 {points, color, width}" },
        svg: { type: "string", description: "直接传 SVG（可选）" }
      },
      required: ["answer"]
    }
  },
  {
    name: "draw_status",
    description: "查看当前画作。只返回画布尺寸、SVG、ASCII 网格和简短说明，不返回答案。",
    inputSchema: { type: "object", properties: {} }
  },
  {
    name: "draw_guess",
    description: "提交猜测。返回很短：猜对了，或者没猜中。失败时不泄露答案。",
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

function mcpResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

app.post("/mcp", (req, res) => {
  const { id, method, params } = req.body || {};
  if (method === "initialize") {
    return res.json(mcpResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "draw-guess", version: "1.0.0" }
    }));
  }
  if (method === "tools/list") {
    return res.json(mcpResult(id, { tools: TOOLS }));
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments || {};
    if (name === "draw_start") {
      const strokes = args.strokes || [];
      round = {
        answer: String(args.answer || "").trim(),
        aliases: (args.aliases || []).map(a => String(a).trim()),
        artist: args.artist || "AI",
        created_at: new Date().toISOString(),
        drawing_svg: args.svg || strokesToSvg(strokes),
        ascii_grid: makeAsciiGrid(strokes),
        guesses: []
      };
      return res.json(mcpResult(id, {
        content: [{ type: "text", text: "画画提交成功，前端看不到答案，可以开始猜了。" }]
      }));
    }
    if (name === "draw_status") {
      return res.json(mcpResult(id, {
        content: [{ type: "text", text: JSON.stringify(publicDrawingForMcp(round)) }]
      }));
    }
    if (name === "draw_guess") {
      if (!round) {
        return res.json(mcpResult(id, { content: [{ type: "text", text: "还没有当前画作。" }] }));
      }
      const g = String(args.target || "").trim();
      round.guesses.push(g);
      const pool = [round.answer, ...round.aliases].map(s => s.toLowerCase());
      const hit = pool.includes(g.toLowerCase());
      if (hit) {
        history.push({ ...round, winner: args.guesser || "AI" });
        const ans = round.answer;
        round = null;
        return res.json(mcpResult(id, { content: [{ type: "text", text: `猜对了，答案是「${ans}」。` }] }));
      }
      return res.json(mcpResult(id, { content: [{ type: "text", text: `没猜中。已经猜过：${round.guesses.join("、")}` }] }));
    }
    return res.json(mcpResult(id, { content: [{ type: "text", text: "未知工具。" }] }));
  }
  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
});

// ---------- 画板网页 ----------
app.get("/", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>你画我猜</title>
<style>
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body { margin:0; background:#1a1618; color:#f5eef2; font-family:-apple-system,sans-serif; display:flex; flex-direction:column; align-items:center; min-height:100vh; padding:12px; }
  h1 { font-size:18px; font-weight:600; margin:8px 0; letter-spacing:2px; }
  #board { background:#fffafc; border-radius:20px; touch-action:none; width:100%; max-width:520px; box-shadow:0 8px 30px rgba(0,0,0,.4); }
  .bar { display:flex; gap:10px; margin-top:12px; width:100%; max-width:520px; }
  button { flex:1; padding:14px; border:none; border-radius:14px; font-size:15px; font-weight:600; background:#4f454b; color:#fff; }
  button.primary { background:#a8577a; }
  #msg { margin-top:12px; font-size:14px; color:#c9a9bb; min-height:20px; text-align:center; }
</style>
</head>
<body>
<h1>你 画 我 猜</h1>
<canvas id="board" width="1000" height="700"></canvas>
<div class="bar">
  <button onclick="undo()">撤销</button>
  <button onclick="clearAll()">清空</button>
  <button class="primary" onclick="submit()">提交</button>
</div>
<div id="msg">用手指画，画完点提交</div>
<script>
const c = document.getElementById('board');
const ctx = c.getContext('2d');
let strokes = [], cur = null;

function pos(e){
  const r = c.getBoundingClientRect();
  const t = e.touches ? e.touches[0] : e;
  return [ (t.clientX - r.left) * (1000 / r.width), (t.clientY - r.top) * (700 / r.height) ];
}
function start(e){ e.preventDefault(); cur = { points:[pos(e)], color:'#4f454b', width:8 }; strokes.push(cur); draw(); }
function move(e){ if(!cur) return; e.preventDefault(); cur.points.push(pos(e)); draw(); }
function end(e){ cur = null; }
function draw(){
  ctx.clearRect(0,0,1000,700);
  ctx.fillStyle = '#fffafc'; ctx.fillRect(0,0,1000,700);
  ctx.lineCap='round'; ctx.lineJoin='round';
  for(const s of strokes){
    if(s.points.length < 2) continue;
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width;
    ctx.beginPath();
    ctx.moveTo(s.points[0][0], s.points[0][1]);
    for(let i=1;i<s.points.length;i++) ctx.lineTo(s.points[i][0], s.points[i][1]);
    ctx.stroke();
  }
}
function undo(){ strokes.pop(); draw(); }
function clearAll(){ strokes = []; draw(); document.getElementById('msg').textContent='已清空'; }
async function submit(){
  if(!strokes.length){ document.getElementById('msg').textContent='还没画呢'; return; }
  document.getElementById('msg').textContent='提交中…';
  const r = await fetch('/submit', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ strokes }) });
  const d = await r.json();
  document.getElementById('msg').textContent = d.ok ? '提交成功，让江玖猜吧' : '提交失败';
}
c.addEventListener('touchstart', start, {passive:false});
c.addEventListener('touchmove', move, {passive:false});
c.addEventListener('touchend', end);
c.addEventListener('mousedown', start);
c.addEventListener('mousemove', move);
c.addEventListener('mouseup', end);
draw();
</script>
</body>
</html>`);
});

// 用户提交画作
app.post("/submit", (req, res) => {
  const strokes = req.body?.strokes || [];
  round = {
    answer: "",
    aliases: [],
    artist: "用户",
    created_at: new Date().toISOString(),
    drawing_svg: strokesToSvg(strokes),
    ascii_grid: makeAsciiGrid(strokes),
    guesses: []
  };
  res.json({ ok: true });
});

app.get("/health", (req, res) => res.json({ ok: true, hasRound: !!round }));

app.listen(PORT, () => console.log("draw-guess listening on " + PORT));
