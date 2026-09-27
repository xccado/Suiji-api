// Suiji-api — 随机图片 API
// Cloudflare Workers + R2 原生绑定：无需 AccessKey，桶可保持私有，图片经边缘缓存代理输出
// 路由:
//   GET /                首页（内嵌 HTML/CSS，单文件部署）
//   GET /api/random      随机图片：默认 302 跳转到 /img/<key>；?format=json 返回 JSON；?dir=pc|mobile 强制指定目录
//   GET /api/stats       两目录收录图片数量
//   GET /img/<key>       从 R2 代理图片（边缘缓存，仅允许已配置目录下的图片扩展名）
// 防频繁下载：/api/random 与 /img/* 按 IP 限速（固定窗口，超限返回 429，可用变量关闭/调整）

const IMAGE_RE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
const MIME = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
};
const CACHE_TTL_DEFAULT = 300; // 目录列表缓存秒数

// ---------- 目录列表缓存（per-isolate 内存，TTL 失效，空目录也缓存避免反复扫桶） ----------
const listCache = new Map(); // dir -> { keys: string[], expires: number }

async function listImageKeys(bucket, dir, ttl) {
  const hit = listCache.get(dir);
  if (hit && hit.expires > Date.now()) return hit.keys;

  const keys = [];
  let cursor;
  do {
    const page = await bucket.list({ prefix: dir + "/", limit: 1000, cursor });
    for (const obj of page.objects) {
      if (IMAGE_RE.test(obj.key)) keys.push(obj.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);

  listCache.set(dir, { keys, expires: Date.now() + ttl * 1000 });
  return keys;
}

function isMobileUA(ua) {
  return /iPhone|iPad|iPod|Android.*Mobile|Mobile/i.test(ua || "");
}

function encodeKeyPath(key) {
  return key.split("/").map(encodeURIComponent).join("/");
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store",
    },
  });
}

// ---------- 防频繁下载（按 IP 固定窗口限速） ----------
// Workers 多 isolate 没有单点内存可用，用两层计数尽量逼近精确值：
//   1) per-isolate 内存 Map（同一 isolate 内精确）
//   2) Cache API 计数器（同一边缘节点/colo 内跨 isolate 共享，键 /__rl/<scope>/<ip>/<窗口号>）
// 取两者最大值再 +1，抵消并发竞争造成的漏计。限速按边缘节点粒度尽力而为，
// 拦暴力爬图足够；如需全局精确限速可再加 Durable Object。
const rlMem = new Map(); // "scope:ip:windowIdx" -> count

function clientIP(request) {
  return request.headers.get("cf-connecting-ip")
    || (request.headers.get("x-forwarded-for") || "").split(",")[0].trim()
    || "unknown";
}

function intVar(env, name, def) {
  const n = parseInt((env && env[name]) || "", 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

async function checkRateLimit(env, request, url, scope) {
  const limit = intVar(env, scope === "random" ? "RATE_LIMIT_RANDOM" : "RATE_LIMIT_IMG", scope === "random" ? 30 : 60);
  const windowSec = intVar(env, "RATE_LIMIT_WINDOW", 60);
  if (!limit) return null; // 0 = 关闭该端点限速

  const nowMs = Date.now();
  const wIdx = Math.floor(nowMs / (windowSec * 1000));
  const resetSec = Math.max(1, Math.ceil(((wIdx + 1) * windowSec * 1000 - nowMs) / 1000));
  const ip = clientIP(request);

  // 内存层
  const memKey = scope + ":" + ip + ":" + wIdx;
  const memPrev = rlMem.get(memKey) || 0;

  // Cache 层
  let cachePrev = 0;
  const cacheKey = new URL(url.origin + "/__rl/" + scope + "/" + ip + "/" + wIdx);
  try {
    const hit = await caches.default.match(cacheKey);
    if (hit) cachePrev = (await hit.json()).n || 0;
  } catch { /* 本地 dev 可能无 caches */ }

  const n = Math.max(memPrev, cachePrev) + 1;
  rlMem.set(memKey, n);
  if (rlMem.size > 10000) { // 防内存泄漏：清理已过期的窗口计数
    for (const k of rlMem.keys()) {
      if (Number(k.split(":").pop()) < wIdx) rlMem.delete(k);
    }
  }
  try {
    await caches.default.put(cacheKey, new Response(JSON.stringify({ n }), {
      headers: { "Cache-Control": "public, max-age=" + resetSec },
    }));
  } catch { /* ignore */ }

  if (n > limit) {
    return new Response(
      JSON.stringify({ error: "rate_limited", message: "请求过于频繁，请稍后再试", limit, window: windowSec }),
      {
        status: 429,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Retry-After": String(resetSec),
          "Access-Control-Allow-Origin": "*",
          "Cache-Control": "no-store",
        },
      }
    );
  }
  return null;
}

// ---------- 内嵌首页（科技感 v2：深空暗色 + 粒子网络 + HUD + 终端风） ----------
const CSS = `
:root {
  --bg: #04060c;
  --panel: rgba(10, 17, 32, .78);
  --text: #dce7f5;
  --muted: #7c8ca5;
  --dim: #4d5b72;
  --accent: #27e0ff;
  --accent-dim: rgba(39, 224, 255, .12);
  --violet: #8b7cff;
  --border: rgba(39, 224, 255, .16);
  --border-hi: rgba(39, 224, 255, .45);
  --code-bg: rgba(5, 10, 19, .92);
  --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Consolas, monospace;
  --sans: 'Space Grotesk', 'PingFang SC', 'Microsoft YaHei', -apple-system, sans-serif;
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: var(--sans);
  margin: 0; padding: 0 1rem 3rem;
  background:
    radial-gradient(1100px 500px at 80% -10%, rgba(124, 108, 255, .14), transparent 60%),
    radial-gradient(900px 460px at 12% -6%, rgba(39, 224, 255, .10), transparent 60%),
    var(--bg);
  color: var(--text);
  min-height: 100vh;
  overflow-x: hidden;
}
.mono { font-family: var(--mono); }

/* ---- 背景层：粒子画布 / 壁纸 / 网格 / 扫描光束 ---- */
#net { position: fixed; inset: 0; z-index: -4; pointer-events: none; }
#bgwrap { position: fixed; inset: 0; z-index: -3; overflow: hidden; }
.bgimg {
  position: absolute; inset: 0;
  background-size: cover; background-position: center;
  opacity: 0; transition: opacity 1.4s ease;
  filter: blur(3px) saturate(1.25) brightness(.65);
}
.bgimg.on { opacity: .45; animation: kenburns 26s ease-in-out infinite alternate; }
@keyframes kenburns { from { transform: scale(1); } to { transform: scale(1.1); } }
#bgwrap::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(180deg, rgba(4, 6, 12, .45), rgba(4, 6, 12, .9));
}
#grid {
  position: fixed; inset: 0; z-index: -2; pointer-events: none;
  background-image:
    linear-gradient(rgba(39, 224, 255, .06) 1px, transparent 1px),
    linear-gradient(90deg, rgba(39, 224, 255, .06) 1px, transparent 1px);
  background-size: 56px 56px;
  -webkit-mask-image: radial-gradient(ellipse 90% 70% at 50% 18%, #000 30%, transparent 75%);
  mask-image: radial-gradient(ellipse 90% 70% at 50% 18%, #000 30%, transparent 75%);
}
#beam {
  position: fixed; left: 0; right: 0; top: -160px; height: 160px;
  z-index: -1; pointer-events: none;
  background: linear-gradient(180deg, transparent, rgba(39, 224, 255, .045) 45%, rgba(39, 224, 255, .12) 50%, rgba(39, 224, 255, .045) 55%, transparent);
  animation: beam 11s linear infinite;
}
@keyframes beam { to { transform: translateY(calc(100vh + 340px)); } }

.wrap { max-width: 800px; margin: 0 auto; }

/* ---- 顶栏 ---- */
.topbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 1.1rem .2rem;
  font-family: var(--mono); font-size: .8rem; letter-spacing: .1em;
}
.brand { color: var(--accent); font-weight: 600; }
.brand .cur { animation: blink 1.1s steps(1) infinite; }
@keyframes blink { 50% { opacity: 0; } }
.badge { color: var(--muted); display: flex; align-items: center; gap: .45rem; }
.badge .dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #3dffa0; box-shadow: 0 0 8px #3dffa0;
  animation: pulse 2.2s ease-in-out infinite;
}
@keyframes pulse { 50% { opacity: .35; } }

/* ---- HUD 角标 ---- */
.hud { position: relative; }
.hud::before, .hud::after, .c2::before, .c2::after {
  content: ''; position: absolute; width: 20px; height: 20px;
  border: 2px solid var(--border-hi); pointer-events: none;
}
.hud::before { top: -1px; left: -1px; border-right: none; border-bottom: none; }
.hud::after { bottom: -1px; right: -1px; border-left: none; border-top: none; }
.c2 { position: absolute; inset: 0; pointer-events: none; }
.c2::before { top: -1px; right: -1px; border-left: none; border-bottom: none; }
.c2::after { bottom: -1px; left: -1px; border-right: none; border-top: none; }

/* ---- Hero ---- */
.hero {
  background: var(--panel); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border);
  box-shadow: 0 0 0 1px rgba(0,0,0,.4), 0 12px 44px rgba(0, 0, 0, .5), inset 0 1px 0 rgba(255,255,255,.04);
  border-radius: 6px;
  padding: 2.6rem 2rem 2.2rem; text-align: center; margin-top: .6rem;
}
.hero h1 {
  margin: 0 0 .6rem;
  font-size: clamp(1.9rem, 5.4vw, 3rem); font-weight: 700; letter-spacing: .04em;
  background: linear-gradient(110deg, #f2fbff 10%, var(--accent) 38%, var(--violet) 62%, #f2fbff 92%);
  background-size: 220% 100%;
  -webkit-background-clip: text; background-clip: text; color: transparent;
  animation: flow 7s linear infinite;
  filter: drop-shadow(0 0 22px rgba(39, 224, 255, .3));
}
@keyframes flow { to { background-position: -220% 0; } }
.hero .sub {
  font-family: var(--mono); color: var(--dim); font-size: .78rem;
  letter-spacing: .22em; margin: 0 0 1.1rem;
}
.hero .stats {
  font-family: var(--mono); color: var(--muted); font-size: .82rem;
  letter-spacing: .08em; margin: 0 0 1.6rem;
}
.hero .stats b { color: var(--accent); font-weight: 600; }

.btn {
  display: inline-block; position: relative; overflow: hidden;
  background: linear-gradient(160deg, #0c1a2e, #0a2438);
  color: var(--accent); border: 1px solid var(--border-hi); border-radius: 6px;
  cursor: pointer; padding: .85rem 2.6rem;
  font-family: var(--mono); font-size: 1rem; font-weight: 600; letter-spacing: .14em;
  box-shadow: 0 0 18px rgba(39, 224, 255, .18), inset 0 0 14px rgba(39, 224, 255, .06);
  transition: transform .16s, box-shadow .16s, border-color .16s;
}
.btn:hover {
  transform: translateY(-2px); border-color: var(--accent);
  box-shadow: 0 0 34px rgba(39, 224, 255, .4), inset 0 0 20px rgba(39, 224, 255, .12);
}
.btn:active { transform: translateY(0); }
.btn::after {
  content: ''; position: absolute; top: 0; bottom: 0; left: -80%; width: 45%;
  background: linear-gradient(100deg, transparent, rgba(160, 245, 255, .22), transparent);
  transform: skewX(-20deg); transition: left .55s ease;
}
.btn:hover::after { left: 135%; }

#image-container { margin-top: 1.6rem; min-height: 0; }
#image-container .loading { color: var(--dim); font-family: var(--mono); font-size: .85rem; letter-spacing: .18em; }
#image-container .loading .dots::after { content: ''; animation: dots 1.2s steps(4) infinite; }
@keyframes dots { 0% { content: ''; } 25% { content: '.'; } 50% { content: '..'; } 75% { content: '...'; } }
.img-frame { position: relative; display: inline-block; max-width: 100%; }
.random-image {
  display: block; max-width: 100%; max-height: 68vh; height: auto;
  border: 1px solid var(--border); border-radius: 4px;
  box-shadow: 0 0 30px rgba(39, 224, 255, .14), 0 14px 40px rgba(0, 0, 0, .55);
  animation: reveal .65s cubic-bezier(.2, .8, .3, 1) both;
}
@keyframes reveal {
  from { opacity: 0; filter: blur(12px); transform: translateY(14px) scale(.97); }
  to { opacity: 1; filter: blur(0); transform: none; }
}
.sweep {
  position: absolute; left: 0; right: 0; top: -8%; height: 16%; pointer-events: none;
  background: linear-gradient(180deg, transparent, rgba(39, 224, 255, .28) 48%, rgba(220, 250, 255, .8) 50%, rgba(39, 224, 255, .28) 52%, transparent);
  mix-blend-mode: screen; opacity: 0;
  animation: sweep 1.1s ease-out .12s both;
}
@keyframes sweep { 0% { top: -12%; opacity: 0; } 12% { opacity: 1; } 88% { opacity: 1; } 100% { top: 100%; opacity: 0; } }
.img-actions { margin-top: .8rem; font-size: .8rem; font-family: var(--mono); color: var(--dim); }
.img-actions a { color: var(--accent); text-decoration: none; letter-spacing: .06em; }
.img-actions a:hover { text-shadow: 0 0 10px rgba(39, 224, 255, .6); }

/* ---- 卡片 ---- */
section.card {
  position: relative;
  background: var(--panel); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
  border: 1px solid var(--border); border-radius: 6px;
  box-shadow: 0 10px 36px rgba(0, 0, 0, .45), inset 0 1px 0 rgba(255,255,255,.03);
  padding: 1.5rem 1.5rem; margin-top: 1.3rem;
}
section.card > h2 {
  font-family: var(--mono); font-size: .88rem; font-weight: 600; margin: 0 0 1.1rem;
  letter-spacing: .18em; color: var(--text);
  display: flex; align-items: center; gap: .6rem;
}
section.card > h2 .tick { color: var(--accent); }

.endpoint-box {
  display: flex; align-items: center; gap: .75rem;
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 4px; padding: .75rem .9rem;
}
.endpoint-box code {
  flex: 1; word-break: break-all; font-family: var(--mono); font-size: .9rem;
  color: var(--accent); text-shadow: 0 0 12px rgba(39, 224, 255, .35);
}
.endpoint-box::before {
  content: '>'; color: var(--dim); font-family: var(--mono); flex: none;
}

.copy-btn {
  flex: none; background: transparent; color: var(--muted);
  border: 1px solid var(--border); border-radius: 4px;
  padding: .32rem .8rem; font-family: var(--mono); font-size: .74rem;
  letter-spacing: .12em; cursor: pointer;
  transition: color .15s, border-color .15s, box-shadow .15s;
}
.copy-btn:hover { color: var(--accent); border-color: var(--border-hi); box-shadow: 0 0 12px rgba(39, 224, 255, .18); }
.copy-btn.copied { color: #3dffa0; border-color: rgba(61, 255, 160, .5); }

.example { margin-bottom: 1.35rem; }
.example:last-child { margin-bottom: 0; }
.example h3 {
  font-family: var(--mono); font-size: .8rem; margin: 0 0 .55rem; color: var(--text); letter-spacing: .06em;
}
.example h3 span { color: var(--dim); font-weight: 400; font-size: .72rem; }
.term { background: var(--code-bg); border: 1px solid var(--border); border-radius: 4px; overflow: hidden; position: relative; }
.term-head {
  display: flex; align-items: center; gap: .45rem;
  padding: .5rem .8rem; border-bottom: 1px solid var(--border);
  background: rgba(39, 224, 255, .03);
}
.term-head .t { width: 9px; height: 9px; border-radius: 50%; opacity: .75; }
.term-head .t:nth-child(1) { background: #ff5f56; }
.term-head .t:nth-child(2) { background: #ffbd2e; }
.term-head .t:nth-child(3) { background: #27c93f; }
.term-head .term-title {
  margin-left: auto; font-family: var(--mono); font-size: .68rem;
  color: var(--dim); letter-spacing: .14em;
}
pre.code { margin: 0; position: relative; padding: .9rem 4.2rem .9rem 1rem; overflow-x: auto; }
pre.code code {
  font-family: var(--mono); font-size: .82rem; line-height: 1.7;
  color: #a9c3d9; white-space: pre;
}
pre.code .api-url { color: var(--accent); }
pre.code .copy-btn { position: absolute; top: .55rem; right: .55rem; }

.param-item {
  display: flex; gap: .85rem; padding: .6rem 0;
  border-bottom: 1px dashed rgba(39, 224, 255, .1); font-size: .88rem;
}
.param-item:last-child { border-bottom: none; }
.param-item code:first-child {
  flex: none; min-width: 8.2rem; font-family: var(--mono); font-size: .78rem;
  background: var(--accent-dim); color: var(--accent);
  border: 1px solid rgba(39, 224, 255, .2);
  border-radius: 3px; padding: .18rem .55rem; height: fit-content;
}
.param-item .desc { color: var(--muted); }
.param-item .desc code { color: var(--accent); font-family: var(--mono); font-size: .8em; }

footer {
  text-align: center; font-family: var(--mono); color: var(--dim);
  font-size: .72rem; letter-spacing: .16em; margin-top: 2rem;
}
footer a { color: var(--muted); text-decoration: none; }
footer a:hover { color: var(--accent); }

@media (max-width: 560px) {
  .hero { padding: 2rem 1.2rem 1.7rem; }
  section.card { padding: 1.25rem 1.05rem; }
  .param-item { flex-direction: column; gap: .35rem; }
  .topbar { font-size: .68rem; }
}
@media (prefers-reduced-motion: reduce) {
  .bgimg.on, .hero h1, #beam, .brand .cur, .badge .dot, .btn::after, .sweep { animation: none !important; }
  .random-image { animation: none !important; }
  * { transition: none !important; }
}
`;

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="随机图片 API — Cloudflare Workers + R2，设备自适应，免费调用">
<title>随机图片 API</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&family=JetBrains+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
<canvas id="net"></canvas>
<div id="bgwrap"><div class="bgimg" id="bg0"></div><div class="bgimg" id="bg1"></div></div>
<div id="grid"></div>
<div id="beam"></div>
<div class="wrap">

  <header class="topbar">
    <div class="brand">SUIJI://API<span class="cur">▌</span></div>
    <div class="badge"><span class="dot"></span>EDGE&nbsp;ONLINE</div>
  </header>

  <div class="hero hud"><i class="c2"></i>
    <h1>随机图片 API</h1>
    <p class="sub">// DEVICE-ADAPTIVE RANDOM IMAGE SERVICE</p>
    <p class="stats">PC <b id="stat-pc">···</b> &nbsp;·&nbsp; MOBILE <b id="stat-mobile">···</b> &nbsp;·&nbsp; TOTAL <b id="stat-total">···</b></p>
    <button id="get-image-btn" class="btn">⟳ 随机来一张</button>
    <div id="image-container"></div>
  </div>

  <section class="card hud"><i class="c2"></i>
    <h2><span class="tick">▸</span>ENDPOINT / 接口地址</h2>
    <div class="endpoint-box">
      <code class="api-url" id="hero-url"></code>
      <button class="copy-btn" data-copy="#hero-url">复制</button>
    </div>
  </section>

  <section class="card hud"><i class="c2"></i>
    <h2><span class="tick">▸</span>USAGE / 调用方式</h2>

    <div class="example">
      <h3>01 · 浏览器直接打开 <span>— 返回 302 重定向到图片</span></h3>
      <div class="term">
        <div class="term-head"><span class="t"></span><span class="t"></span><span class="t"></span><span class="term-title">BASH</span></div>
        <pre class="code"><code><span class="api-url"></span></code><button class="copy-btn" data-copy-prev>复制</button></pre>
      </div>
    </div>

    <div class="example">
      <h3>02 · HTML 图片标签 <span>— 网页里最常用的方式</span></h3>
      <div class="term">
        <div class="term-head"><span class="t"></span><span class="t"></span><span class="t"></span><span class="term-title">HTML</span></div>
        <pre class="code"><code>&lt;img src="<span class="api-url"></span>" alt="随机图片"&gt;</code><button class="copy-btn" data-copy-prev>复制</button></pre>
      </div>
    </div>

    <div class="example">
      <h3>03 · CSS 背景 <span>— 每次刷新自动换背景</span></h3>
      <div class="term">
        <div class="term-head"><span class="t"></span><span class="t"></span><span class="t"></span><span class="term-title">CSS</span></div>
        <pre class="code"><code>body {
  background-image: url('<span class="api-url"></span>');
  background-size: cover;
  background-position: center;
}</code><button class="copy-btn" data-copy-prev>复制</button></pre>
      </div>
    </div>

    <div class="example">
      <h3>04 · JavaScript <span>— 拿到图片直链后自行处理</span></h3>
      <div class="term">
        <div class="term-head"><span class="t"></span><span class="t"></span><span class="t"></span><span class="term-title">JS</span></div>
        <pre class="code"><code>fetch('<span class="api-url"></span>?format=json')
  .then(r =&gt; r.json())
  .then(d =&gt; {
    console.log(d.url);    // 图片直链
    console.log(d.key);    // 桶内路径
    console.log(d.folder); // pc 或 mobile
  });</code><button class="copy-btn" data-copy-prev>复制</button></pre>
      </div>
    </div>

    <div class="example">
      <h3>05 · Markdown <span>— 论坛、README 里直接引用</span></h3>
      <div class="term">
        <div class="term-head"><span class="t"></span><span class="t"></span><span class="t"></span><span class="term-title">MD</span></div>
        <pre class="code"><code>![随机图片](<span class="api-url"></span>)</code><button class="copy-btn" data-copy-prev>复制</button></pre>
      </div>
    </div>

    <div class="example">
      <h3>06 · 命令行 curl <span>— 下载图片 / 写壁纸轮换脚本</span></h3>
      <div class="term">
        <div class="term-head"><span class="t"></span><span class="t"></span><span class="t"></span><span class="term-title">SHELL</span></div>
        <pre class="code"><code># 直接下载一张随机图（-L 跟随重定向）
curl -L -o wallpaper.jpg '<span class="api-url"></span>'

# 拿 JSON 直链
curl '<span class="api-url"></span>?format=json'</code><button class="copy-btn" data-copy-prev>复制</button></pre>
      </div>
    </div>

    <div class="example">
      <h3>07 · Python <span>— 爬虫 / 机器人里使用</span></h3>
      <div class="term">
        <div class="term-head"><span class="t"></span><span class="t"></span><span class="t"></span><span class="term-title">PY</span></div>
        <pre class="code"><code>import requests

url = '<span class="api-url"></span>'

# 直接拿图片二进制
r = requests.get(url, allow_redirects=True)
img = r.content

# 或者拿直链信息
data = requests.get(url + '?format=json').json()
print(data['url'], data['key'])</code><button class="copy-btn" data-copy-prev>复制</button></pre>
      </div>
    </div>
  </section>

  <section class="card hud"><i class="c2"></i>
    <h2><span class="tick">▸</span>PARAMS / 可选参数</h2>
    <div class="param-item">
      <code>?format=json</code>
      <span class="desc">不重定向，直接返回 JSON：<code>{ url, key, folder }</code>，方便程序解析</span>
    </div>
    <div class="param-item">
      <code>?dir=pc</code>
      <span class="desc">强制返回桌面目录的图片（默认按 User-Agent 自动判断）</span>
    </div>
    <div class="param-item">
      <code>?dir=mobile</code>
      <span class="desc">强制返回移动目录的图片</span>
    </div>
    <div class="param-item">
      <code>设备自适应</code>
      <span class="desc">不带参数时，手机访问返回移动目录、电脑访问返回桌面目录，无需任何配置</span>
    </div>
    <div class="param-item">
      <code>防频繁下载</code>
      <span class="desc">每个 IP 每分钟最多 30 次 /api/random、60 次 /img/ 请求，超限返回 429 并提示稍后再试；正常浏览网页/换壁纸完全不受影响</span>
    </div>
  </section>

  <footer>
    POWERED BY CLOUDFLARE WORKERS + R2 · <a href="https://github.com/xccado/Suiji-api" target="_blank" rel="noopener">GITHUB ↗</a>
  </footer>
</div>

<script>
(function () {
  var rm = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  var fullApiUrl = location.origin + '/api/random';
  document.querySelectorAll('.api-url').forEach(function (el) { el.textContent = fullApiUrl; });

  // 打字机：接口地址逐字打出（ti 独立命名，避免与后面粒子循环的 var i 冲突）
  var hero = document.getElementById('hero-url');
  if (hero && !rm) {
    var ti = 0;
    hero.textContent = '';
    (function type() {
      if (ti <= fullApiUrl.length) {
        hero.textContent = fullApiUrl.slice(0, ti++);
        setTimeout(type, 26);
      }
    })();
  }

  // 数字滚动统计
  function countUp(id, target) {
    var el = document.getElementById(id);
    if (!el) return;
    if (rm) { el.textContent = String(target); return; }
    var t0 = performance.now(), dur = 900;
    (function step(t) {
      var p = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e).toLocaleString();
      if (p < 1) requestAnimationFrame(step);
    })(t0);
  }
  fetch('/api/stats').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) return;
    countUp('stat-pc', d.pc);
    countUp('stat-mobile', d.mobile);
    countUp('stat-total', d.pc + d.mobile);
  }).catch(function () {});

  // 复制按钮
  function toast(btnEl, ok) {
    var old = btnEl.textContent;
    btnEl.textContent = ok ? '已复制 ✓' : '失败';
    btnEl.classList.add('copied');
    setTimeout(function () { btnEl.textContent = old; btnEl.classList.remove('copied'); }, 1600);
  }
  document.querySelectorAll('.copy-btn').forEach(function (b) {
    b.addEventListener('click', function () {
      var text;
      if (b.hasAttribute('data-copy')) {
        var target = document.querySelector(b.getAttribute('data-copy'));
        text = target ? target.textContent : '';
      } else {
        var pre = b.closest('pre');
        text = pre ? pre.querySelector('code').textContent : '';
      }
      navigator.clipboard.writeText(text).then(function () { toast(b, true); }, function () { toast(b, false); });
    });
  });

  function fetchJson() {
    return fetch('/api/random?format=json').then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    });
  }

  var btn = document.getElementById('get-image-btn');
  var container = document.getElementById('image-container');

  btn.addEventListener('click', function () {
    container.innerHTML = '<p class="loading">SCANNING<span class="dots"></span></p>';
    fetchJson().then(function (d) {
      container.innerHTML = '';
      var frame = document.createElement('div');
      frame.className = 'img-frame';
      var sweep = document.createElement('div');
      sweep.className = 'sweep';
      frame.appendChild(sweep);
      var img = new Image();
      img.className = 'random-image';
      img.alt = d.key;
      img.src = d.url;
      img.onload = function () {
        var p = document.createElement('p');
        p.className = 'img-actions';
        var a = document.createElement('a');
        a.href = d.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '↗ ' + d.key;
        p.appendChild(a);
        container.appendChild(p);
      };
      frame.appendChild(img);
      container.appendChild(frame);
    }).catch(function (e) {
      container.innerHTML = '<p class="loading">加载失败：' + e.message + '</p>';
    });
  });

  // 背景壁纸：随机图交叉淡入 + Ken Burns
  var bgEls = [document.getElementById('bg0'), document.getElementById('bg1')];
  var bgIdx = 0;
  function refreshBackground() {
    fetchJson().then(function (d) {
      var next = bgEls[bgIdx], cur = bgEls[bgIdx ^ 1];
      next.style.backgroundImage = 'url(' + d.url + ')';
      next.classList.add('on');
      cur.classList.remove('on');
      bgIdx ^= 1;
    }).catch(function () {});
  }
  refreshBackground();
  setInterval(refreshBackground, 30000);

  // 粒子网络背景
  var canvas = document.getElementById('net');
  if (canvas && !rm) {
    var ctx = canvas.getContext('2d');
    var W, H;
    function resize() { W = canvas.width = innerWidth; H = canvas.height = innerHeight; }
    resize();
    addEventListener('resize', resize);
    var N = Math.min(85, Math.max(35, Math.floor(innerWidth / 18)));
    var pts = [];
    for (var i = 0; i < N; i++) {
      pts.push({
        x: Math.random() * innerWidth, y: Math.random() * innerHeight,
        vx: (Math.random() - .5) * .38, vy: (Math.random() - .5) * .38,
        r: .8 + Math.random() * 1.4
      });
    }
    var mouse = { x: -9999, y: -9999 };
    addEventListener('mousemove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
    addEventListener('mouseleave', function () { mouse.x = -9999; mouse.y = -9999; });
    var LINK = 130;
    function frame() {
      if (!document.hidden) {
        ctx.clearRect(0, 0, W, H);
        for (var i = 0; i < N; i++) {
          var p = pts[i];
          p.x += p.vx; p.y += p.vy;
          if (p.x < -20) p.x = W + 20; if (p.x > W + 20) p.x = -20;
          if (p.y < -20) p.y = H + 20; if (p.y > H + 20) p.y = -20;
        }
        for (var i = 0; i < N; i++) {
          var a = pts[i];
          for (var j = i + 1; j < N; j++) {
            var b = pts[j];
            var dx = a.x - b.x, dy = a.y - b.y;
            var d2 = dx * dx + dy * dy;
            if (d2 < LINK * LINK) {
              var al = (1 - Math.sqrt(d2) / LINK) * .32;
              ctx.strokeStyle = 'rgba(39,224,255,' + al.toFixed(3) + ')';
              ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
          }
          var dxm = a.x - mouse.x, dym = a.y - mouse.y;
          var dm2 = dxm * dxm + dym * dym;
          if (dm2 < 160 * 160) {
            var alm = (1 - Math.sqrt(dm2) / 160) * .5;
            ctx.strokeStyle = 'rgba(139,124,255,' + alm.toFixed(3) + ')';
            ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(mouse.x, mouse.y); ctx.stroke();
          }
          ctx.fillStyle = 'rgba(39,224,255,.75)';
          ctx.beginPath(); ctx.arc(a.x, a.y, a.r, 0, 6.2832); ctx.fill();
        }
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
})();
</script>
</body>
</html>`;


function homepage() {
  return new Response(HTML, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" },
  });
}

// ---------- Worker 入口 ----------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const dirPC = env.PC_DIR || "pc";
    const dirMobile = env.MOBILE_DIR || "mobile";
    const ttl = Math.max(30, parseInt(env.LIST_CACHE_TTL || "", 10) || CACHE_TTL_DEFAULT);

    try {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return json({ error: "method not allowed" }, 405);
      }

      if (url.pathname === "/" || url.pathname === "/index.html") {
        return homepage();
      }

      // ---- 收录统计 ----
      if (url.pathname === "/api/stats") {
        const [pc, mobile] = await Promise.all([
          listImageKeys(env.BUCKET, dirPC, ttl),
          listImageKeys(env.BUCKET, dirMobile, ttl),
        ]);
        return json({ pc: pc.length, mobile: mobile.length });
      }

      // ---- 防频繁下载限速（/api/random 与 /img/*） ----
      const isRandom = url.pathname === "/api/random";
      const isImg = /^\/img\/(.+)$/.test(url.pathname);
      if (isRandom || isImg) {
        const limited = await checkRateLimit(env, request, url, isRandom ? "random" : "img");
        if (limited) return limited;
      }

      // ---- 随机图片 ----
      if (isRandom) {
        const dirOverride = url.searchParams.get("dir");
        const dir =
          dirOverride === "pc" || dirOverride === "mobile"
            ? dirOverride === "pc" ? dirPC : dirMobile
            : isMobileUA(request.headers.get("user-agent")) ? dirMobile : dirPC;

        const keys = await listImageKeys(env.BUCKET, dir, ttl);
        if (!keys.length) {
          return json({ error: "no images", folder: dir }, 404);
        }
        const key = keys[Math.floor(Math.random() * keys.length)];
        const imgPath = "/img/" + encodeKeyPath(key);

        if (url.searchParams.get("format") === "json") {
          return json({ url: url.origin + imgPath, key, folder: dir });
        }
        return new Response(null, {
          status: 302,
          headers: { Location: imgPath, "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" },
        });
      }

      // ---- 图片代理（边缘缓存） ----
      const m = url.pathname.match(/^\/img\/(.+)$/);
      if (m) {
        const key = decodeURIComponent(m[1]);
        const allowed = (key.startsWith(dirPC + "/") || key.startsWith(dirMobile + "/")) && IMAGE_RE.test(key);
        if (!allowed) return new Response("Not found", { status: 404 });

        let cacheHit;
        try {
          cacheHit = await caches.default.match(request);
        } catch { /* 本地 dev 可能无 caches */ }
        if (cacheHit) return cacheHit;

        const obj = await env.BUCKET.get(key);
        if (!obj) return new Response("Not found", { status: 404 });

        const ext = key.split(".").pop().toLowerCase();
        const headers = {
          "Content-Type": MIME[ext] || "application/octet-stream",
          "Cache-Control": "public, max-age=86400",
          "ETag": obj.httpEtag,
          "Access-Control-Allow-Origin": "*",
        };
        if (obj.size != null) headers["Content-Length"] = String(obj.size);
        const resp = new Response(request.method === "HEAD" ? null : obj.body, { headers });

        try {
          ctx.waitUntil(caches.default.put(request, resp.clone()));
        } catch { /* 本地 dev */ }
        return resp;
      }

      return new Response("Not found", { status: 404 });
    } catch (err) {
      return json({ error: "internal", message: String((err && err.message) || err) }, 500);
    }
  },
};
