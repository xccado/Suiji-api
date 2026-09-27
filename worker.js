// Suiji-api — 随机图片 API
// Cloudflare Workers + R2 原生绑定：无需 AccessKey，桶可保持私有，图片经边缘缓存代理输出
// 路由:
//   GET /                首页（内嵌 HTML/CSS，单文件部署）
//   GET /api/random      随机图片：默认 302 跳转到 /img/<key>；?format=json 返回 JSON；?dir=pc|mobile 强制指定目录
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
* { box-sizing: border-box; }
body {
  font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
  margin: 0; padding: 1rem;
  display: flex; justify-content: center; align-items: flex-start;
  min-height: 100vh; text-align: center;
}
.background-container {
  position: fixed; top: 0; left: 0; width: 100%; height: 100%;
  background-size: cover; background-position: center;
  z-index: -1;
  background-image: linear-gradient(rgba(255,255,255,0.4), rgba(255,255,255,0.4)), var(--bg-image);
}
.container {
  background-color: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(8px);
  padding: 2rem 2.5rem; border-radius: 16px;
  border: 1px solid rgba(0,0,0,0.06);
  box-shadow: 0 8px 24px rgba(0,0,0,0.12);
  max-width: 100%; width: 640px; margin: 2rem auto;
}
h1 { color: #2c3e50; margin-bottom: 0.5rem; font-size: 1.6rem; }
p { color: #7f8c8d; line-height: 1.6; }
button#get-image-btn {
  background-color: #f6821f; color: #fff;
  padding: 0.9rem 2.2rem; border: none; border-radius: 10px;
  cursor: pointer; font-size: 1.05rem; margin-top: 1rem;
  transition: transform .15s ease, box-shadow .15s ease;
}
button#get-image-btn:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(246,130,31,.4); }
#image-container { margin-top: 2rem; }
.random-image {
  max-width: 100%; height: auto; border-radius: 12px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  animation: fadeIn .4s ease;
}
@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
.loading, .error { color: #2c3e50; }
#api-info { margin-top: 2.5rem; border-top: 1px solid rgba(0,0,0,.08); padding-top: 1.5rem; text-align: left; }
#api-info h2 { color: #2c3e50; font-size: 1.2rem; }
#api-info h4 { color: #2c3e50; margin-bottom: .2rem; }
.api-url-container {
  display: flex; align-items: center; justify-content: space-between;
  background: #f4f5f7; padding: .8rem 1rem; border-radius: 8px;
}
#copy-btn {
  background: transparent; border: none; cursor: pointer;
  font-size: .95rem; color: #2c3e50; padding: .2rem .4rem;
}
#copy-btn.copied { color: #27ae60; }
pre {
  background: #f4f5f7; padding: .8rem 1rem; border-radius: 8px;
  overflow-x: auto; font-size: .85rem; line-height: 1.5;
}
code { font-family: 'SFMono-Regular', Consolas, 'Courier New', monospace; color: #333; }
.html-code { color: #8e44ad; } .css-code { color: #2980b9; } .js-code { color: #e67e22; }
`;

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>随机图片 API</title>
<style>${CSS}</style>
</head>
<body>
<div class="background-container"></div>
<div class="container">
  <h1>随机图片 API</h1>
  <p>点击下方按钮，立即获取随机图片</p>
  <button id="get-image-btn">获取图片</button>
  <div id="image-container"></div>
  <div id="api-info">
    <h2>API 使用说明</h2>
    <p>通过以下 URL 直接获取随机图片（默认 302 重定向到图片）：</p>
    <div class="api-url-container">
      <pre style="background:none;padding:0"><code id="api-url"></code></pre>
      <button id="copy-btn" title="复制 API 地址">复制</button>
    </div>

    <h4>1. 直接作为图片引用</h4>
    <pre><code class="html-code">&lt;img src="<span id="api-url-example"></span>" alt="Random Image"&gt;</code></pre>

    <h4>2. 作为 CSS 背景</h4>
    <pre><code class="css-code">body {
  background-image: url('<span id="api-url-example2"></span>');
  background-size: cover;
}</code></pre>

    <h4>3. 获取 JSON（含图片直链）</h4>
    <pre><code class="js-code">fetch('<span id="api-url-example3"></span>?format=json')
  .then(r => r.json())
  .then(d => console.log(d.url, d.key));</code></pre>

    <h4>设备自适应</h4>
    <p>API 根据 User-Agent 自动返回 pc/ 或 mobile/ 目录下的图片；也可以用 <code>?dir=pc</code> 或 <code>?dir=mobile</code> 强制指定。</p>
  </div>
</div>
<script>
(function () {
  var apiEndpoint = '/api/random';
  var fullApiUrl = location.origin + apiEndpoint;
  ['api-url', 'api-url-example', 'api-url-example2', 'api-url-example3'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.textContent = fullApiUrl;
  });

  var btn = document.getElementById('get-image-btn');
  var container = document.getElementById('image-container');
  var bg = document.querySelector('.background-container');
  var copyBtn = document.getElementById('copy-btn');

  function fetchImage() {
    return fetch(apiEndpoint).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.blob();
    });
  }

  btn.addEventListener('click', function () {
    container.innerHTML = '<p class="loading">加载中...</p>';
    fetchImage().then(function (blob) {
      var url = URL.createObjectURL(blob);
      container.innerHTML = '';
      var img = new Image();
      img.className = 'random-image';
      img.alt = 'Random Image';
      img.src = url;
      container.appendChild(img);
    }).catch(function (err) {
      container.innerHTML = '<p class="error">加载失败：' + err.message + '</p>';
    });
  });

  function setBackgroundImage() {
    fetchImage().then(function (blob) {
      document.documentElement.style.setProperty('--bg-image', 'url(' + URL.createObjectURL(blob) + ')');
    }).catch(function () {});
  }

  copyBtn.addEventListener('click', function () {
    navigator.clipboard.writeText(fullApiUrl).then(function () {
      copyBtn.classList.add('copied');
      copyBtn.textContent = '已复制';
      setTimeout(function () {
        copyBtn.classList.remove('copied');
        copyBtn.textContent = '复制';
      }, 2000);
    });
  });

  setBackgroundImage();
  setInterval(setBackgroundImage, 30000);
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
