// Suiji-api — 随机图片 API
// Cloudflare Workers + R2 原生绑定：无需 AccessKey，桶可保持私有，图片经边缘缓存代理输出
// 路由:
//   GET /                首页（内嵌 HTML/CSS，单文件部署）
//   GET /api/random      随机图片：默认 302 跳转到 /img/<key>；?format=json 返回 JSON；?dir=pc|mobile 强制指定目录
//   GET /api/stats       两目录收录图片数量
//   GET /img/<key>       从 R2 代理图片（边缘缓存，仅允许已配置目录下的图片扩展名）

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

// ---------- 内嵌首页 ----------
const CSS = `
:root {
  --bg: #f6f7f9; --card: rgba(255,255,255,.82); --border: rgba(0,0,0,.08);
  --text: #1f2937; --muted: #6b7280; --code-bg: #f3f4f6; --code-text: #374151;
  --accent: #f6821f; --accent-weak: rgba(246,130,31,.12);
  --shadow: 0 8px 24px rgba(0,0,0,.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f1115; --card: rgba(21,23,29,.85); --border: rgba(255,255,255,.1);
    --text: #e5e7eb; --muted: #9ca3af; --code-bg: #1a1d24; --code-text: #d1d5db;
    --shadow: 0 8px 24px rgba(0,0,0,.4);
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei', sans-serif;
  margin: 0; padding: 1.25rem 1rem 3rem;
  background: var(--bg); color: var(--text);
  min-height: 100vh;
}
.background-container {
  position: fixed; inset: 0; z-index: -2;
  background-size: cover; background-position: center;
  transition: background-image .6s;
  background-image: var(--bg-image);
}
.background-container::after {
  content: ''; position: absolute; inset: 0;
  background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.35));
}
@media (prefers-color-scheme: dark) {
  .background-container::after { background: rgba(15,17,21,.55); }
}
.wrap { max-width: 760px; margin: 0 auto; }
.hero {
  background: var(--card); backdrop-filter: blur(12px);
  border: 1px solid var(--border); border-radius: 18px;
  box-shadow: var(--shadow);
  padding: 2.5rem 1.75rem 2rem; text-align: center;
}
.hero h1 { margin: 0 0 .4rem; font-size: 1.75rem; letter-spacing: .5px; }
.hero .sub { color: var(--muted); margin: 0 0 1rem; font-size: 1rem; }
.hero .stats { color: var(--muted); font-size: .85rem; margin: 0 0 1.25rem; }
.hero .stats b { color: var(--text); font-weight: 600; }
.btn {
  display: inline-block; background: var(--accent); color: #fff;
  border: none; border-radius: 12px; cursor: pointer;
  padding: .85rem 2.4rem; font-size: 1.05rem; font-weight: 600;
  transition: transform .15s, box-shadow .15s;
}
.btn:hover { transform: translateY(-2px); box-shadow: 0 6px 18px rgba(246,130,31,.45); }
.btn:active { transform: translateY(0); }
#image-container { margin-top: 1.5rem; min-height: 0; }
#image-container .loading { color: var(--muted); }
.random-image {
  max-width: 100%; max-height: 70vh; height: auto;
  border-radius: 14px; border: 1px solid var(--border);
  box-shadow: 0 10px 30px rgba(0,0,0,.25);
  animation: fadeIn .35s ease;
}
@keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; } }
.img-actions { margin-top: .8rem; font-size: .9rem; color: var(--muted); }
.img-actions a { color: var(--accent); text-decoration: none; }
section.card {
  background: var(--card); backdrop-filter: blur(12px);
  border: 1px solid var(--border); border-radius: 18px;
  box-shadow: var(--shadow);
  padding: 1.6rem 1.5rem; margin-top: 1.25rem;
}
section.card > h2 {
  font-size: 1.15rem; margin: 0 0 1rem;
  display: flex; align-items: center; gap: .5rem;
}
section.card > h2 .dot {
  width: 8px; height: 8px; border-radius: 50%; background: var(--accent);
  display: inline-block; flex: none;
}
.endpoint-box {
  display: flex; align-items: center; gap: .75rem;
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 10px; padding: .7rem .9rem;
}
.endpoint-box code { flex: 1; word-break: break-all; font-size: .9rem; color: var(--code-text); }
.copy-btn {
  flex: none; background: transparent; color: var(--muted);
  border: 1px solid var(--border); border-radius: 8px;
  padding: .3rem .7rem; font-size: .82rem; cursor: pointer;
  transition: color .15s, border-color .15s;
}
.copy-btn:hover { color: var(--text); }
.copy-btn.copied { color: #27ae60; border-color: #27ae60; }
.example { margin-bottom: 1.4rem; }
.example:last-child { margin-bottom: 0; }
.example h3 { font-size: .95rem; margin: 0 0 .5rem; color: var(--text); }
.example h3 span { color: var(--muted); font-weight: 400; font-size: .85rem; }
pre.code {
  position: relative; margin: 0;
  background: var(--code-bg); border: 1px solid var(--border);
  border-radius: 10px; padding: .85rem 3.8rem .85rem 1rem;
  overflow-x: auto; font-size: .84rem; line-height: 1.65;
}
pre.code code { font-family: ui-monospace, SFMono-Regular, Consolas, 'Courier New', monospace; color: var(--code-text); white-space: pre; }
pre.code .copy-btn { position: absolute; top: .5rem; right: .5rem; }
.param-item { display: flex; gap: .75rem; padding: .55rem 0; border-bottom: 1px dashed var(--border); font-size: .92rem; }
.param-item:last-child { border-bottom: none; }
.param-item code:first-child {
  flex: none; min-width: 7.5rem; font-size: .84rem;
  background: var(--accent-weak); color: var(--accent);
  border-radius: 6px; padding: .15rem .5rem; height: fit-content;
}
.param-item .desc { color: var(--muted); }
footer { text-align: center; color: var(--muted); font-size: .82rem; margin-top: 1.5rem; }
footer a { color: var(--muted); }
@media (max-width: 520px) {
  .hero { padding: 2rem 1.25rem 1.6rem; }
  .hero h1 { font-size: 1.4rem; }
  section.card { padding: 1.3rem 1.1rem; }
  .param-item { flex-direction: column; gap: .3rem; }
}
`;

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="description" content="随机图片 API — Cloudflare Workers + R2，设备自适应，免费调用">
<title>随机图片 API</title>
<style>${CSS}</style>
</head>
<body>
<div class="background-container"></div>
<div class="wrap">

  <div class="hero">
    <h1>随机图片 API</h1>
    <p class="sub">每次请求返回一张随机图片 · 自动识别设备 · Cloudflare 边缘加速</p>
    <p class="stats">已收录 <b id="stat-pc">…</b> 张桌面壁纸 · <b id="stat-mobile">…</b> 张移动壁纸</p>
    <button id="get-image-btn" class="btn">随机来一张</button>
    <div id="image-container"></div>
  </div>

  <section class="card">
    <h2><span class="dot"></span>接口地址</h2>
    <div class="endpoint-box">
      <code class="api-url"></code>
      <button class="copy-btn" data-copy=".api-url">复制</button>
    </div>
  </section>

  <section class="card">
    <h2><span class="dot"></span>调用方式</h2>

    <div class="example">
      <h3>1 · 浏览器直接打开 <span>— 返回 302 重定向到图片</span></h3>
      <pre class="code"><code class="api-url"></code><button class="copy-btn" data-copy-prev>复制</button></pre>
    </div>

    <div class="example">
      <h3>2 · HTML 图片标签 <span>— 网页里最常用的方式</span></h3>
      <pre class="code"><code>&lt;img src="<span class="api-url"></span>" alt="随机图片"&gt;</code><button class="copy-btn" data-copy-prev>复制</button></pre>
    </div>

    <div class="example">
      <h3>3 · CSS 背景 <span>— 每次刷新自动换背景</span></h3>
      <pre class="code"><code>body {
  background-image: url('<span class="api-url"></span>');
  background-size: cover;
  background-position: center;
}</code><button class="copy-btn" data-copy-prev>复制</button></pre>
    </div>

    <div class="example">
      <h3>4 · JavaScript <span>— 拿到图片直链后自行处理</span></h3>
      <pre class="code"><code>fetch('<span class="api-url"></span>?format=json')
  .then(r => r.json())
  .then(d => {
    console.log(d.url);   // 图片直链
    console.log(d.key);   // 桶内路径
    console.log(d.folder); // pc 或 mobile
  });</code><button class="copy-btn" data-copy-prev>复制</button></pre>
    </div>

    <div class="example">
      <h3>5 · Markdown <span>— 论坛、README 里直接引用</span></h3>
      <pre class="code"><code>![随机图片](<span class="api-url"></span>)</code><button class="copy-btn" data-copy-prev>复制</button></pre>
    </div>

    <div class="example">
      <h3>6 · 命令行 curl <span>— 下载图片 / 写壁纸轮换脚本</span></h3>
      <pre class="code"><code># 直接下载一张随机图（-L 跟随重定向）
curl -L -o wallpaper.jpg '<span class="api-url"></span>'

# 拿 JSON 直链
curl '<span class="api-url"></span>?format=json'</code><button class="copy-btn" data-copy-prev>复制</button></pre>
    </div>

    <div class="example">
      <h3>7 · Python <span>— 爬虫 / 机器人里使用</span></h3>
      <pre class="code"><code>import requests

url = '<span class="api-url"></span>'

# 直接拿图片二进制
r = requests.get(url, allow_redirects=True)
img = r.content

# 或者拿直链信息
data = requests.get(url + '?format=json').json()
print(data['url'], data['key'])</code><button class="copy-btn" data-copy-prev>复制</button></pre>
    </div>
  </section>

  <section class="card">
    <h2><span class="dot"></span>可选参数</h2>
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
  </section>

  <footer>
    Powered by Cloudflare Workers + R2 ·
    <a href="https://github.com/xccado/Suiji-api" target="_blank" rel="noopener">GitHub</a>
  </footer>
</div>

<script>
(function () {
  var fullApiUrl = location.origin + '/api/random';
  document.querySelectorAll('.api-url').forEach(function (el) { el.textContent = fullApiUrl; });

  var btn = document.getElementById('get-image-btn');
  var container = document.getElementById('image-container');
  var bg = document.querySelector('.background-container');

  // 收录统计
  fetch('/api/stats').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
    if (!d) return;
    var pc = document.getElementById('stat-pc'), mob = document.getElementById('stat-mobile');
    if (pc) pc.textContent = d.pc;
    if (mob) mob.textContent = d.mobile;
  }).catch(function () {});

  function toast(btnEl, ok) {
    var old = btnEl.textContent;
    btnEl.textContent = ok ? '已复制' : '失败';
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

  btn.addEventListener('click', function () {
    container.innerHTML = '<p class="loading">加载中…</p>';
    fetchJson().then(function (d) {
      container.innerHTML = '';
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
        a.textContent = '在新标签页打开原图';
        p.appendChild(a);
        container.appendChild(p);
      };
      container.appendChild(img);
    }).catch(function (e) {
      container.innerHTML = '<p class="loading">加载失败：' + e.message + '</p>';
    });
  });

  function refreshBackground() {
    fetchJson().then(function (d) {
      bg.style.backgroundImage = 'url(' + d.url + ')';
    }).catch(function () {});
  }

  refreshBackground();
  setInterval(refreshBackground, 30000);
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

      // ---- 随机图片 ----
      if (url.pathname === "/api/random") {
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
