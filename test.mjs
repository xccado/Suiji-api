// 本地集成测试：Miniflare v4 模拟 R2 绑定，验证全链路
import { Miniflare } from "miniflare";
import assert from "node:assert";

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64"
);

function makeMf(r2BucketName) {
  return new Miniflare({
    workers: [{
      name: "suiji",
      modules: [{ type: "ESModule", path: "./worker.js" }],
      compatibilityDate: "2025-09-01",
      r2Buckets: ["BUCKET"],
      bindings: { PC_DIR: "pc", MOBILE_DIR: "mobile", LIST_CACHE_TTL: "60" },
    }],
  });
}

const mf = makeMf();
const bucket = await mf.getR2Bucket("BUCKET");
// 造数据：pc 2 张图 + 1 个非图片，mobile 1 张图
await bucket.put("pc/a.jpg", PNG_1x1);
await bucket.put("pc/b.png", PNG_1x1);
await bucket.put("pc/ignore.txt", new Uint8Array([1, 2, 3]));
await bucket.put("mobile/m1.webp", PNG_1x1);
console.log("[setup] R2 objects created");

const call = (path, headers = {}, method = "GET") =>
  mf.dispatchFetch("https://example.com" + path, { headers, method, redirect: "manual" });

// --- 1. 首页 ---
let res = await call("/");
assert.equal(res.status, 200);
assert.match(res.headers.get("content-type"), /text\/html/);
const html = await res.text();
assert.ok(html.includes("随机图片 API"), "homepage content");
assert.ok(html.includes("api/random"), "homepage mentions api");
console.log("[PASS] GET / -> 200 html");

// --- 2. 桌面 UA -> /api/random 302 到 /img/pc/... ---
for (let i = 0; i < 6; i++) {
  res = await call("/api/random", { "user-agent": "Mozilla/5.0 (X11; Linux x86_64)" });
  assert.equal(res.status, 302);
  const loc = res.headers.get("location");
  assert.ok(loc.startsWith("/img/pc/"), "desktop redirect -> " + loc);
  assert.ok(!loc.includes("ignore.txt"), "must not pick non-image");
}
console.log("[PASS] /api/random (desktop UA) x6 -> 302 /img/pc/*, never non-image");

// --- 3. 移动 UA -> mobile 目录 ---
for (let i = 0; i < 4; i++) {
  res = await call("/api/random", { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" });
  assert.equal(res.status, 302);
  assert.ok(res.headers.get("location").startsWith("/img/mobile/"), res.headers.get("location"));
}
console.log("[PASS] /api/random (iPhone UA) x4 -> 302 /img/mobile/*");

// --- 4. ?dir= 强制指定 ---
res = await call("/api/random?dir=mobile", { "user-agent": "curl/8" });
assert.equal(res.status, 302);
assert.ok(res.headers.get("location").startsWith("/img/mobile/"));
res = await call("/api/random?dir=pc", { "user-agent": "iPhone" });
assert.equal(res.status, 302);
assert.ok(res.headers.get("location").startsWith("/img/pc/"));
console.log("[PASS] /api/random?dir= override works");

// --- 5. JSON 格式 ---
res = await call("/api/random?format=json");
assert.equal(res.status, 200);
const data = await res.json();
assert.ok(data.url.startsWith("https://example.com/img/pc/"), JSON.stringify(data));
assert.ok(data.key.startsWith("pc/"));
assert.equal(data.folder, "pc");
console.log("[PASS] /api/random?format=json ->", JSON.stringify(data));

// --- 6. 图片代理：跟随重定向拿真实图片 ---
res = await call("/api/random");
const imgPath = res.headers.get("location");
res = await call(imgPath);
assert.equal(res.status, 200);
assert.match(res.headers.get("content-type"), /^image\//);
const body = Buffer.from(await res.arrayBuffer());
assert.equal(body.toString("base64"), PNG_1x1.toString("base64"), "body must equal uploaded image");
console.log(`[PASS] GET ${imgPath} -> 200 ${res.headers.get("content-type")} byte-exact`);

// --- 7. 图片代理：非法路径拒绝 ---
res = await call("/img/pc/../../etc/passwd");
assert.equal(res.status, 404);
res = await call("/img/secret/evil.png");
assert.equal(res.status, 404);
res = await call("/img/pc/ignore.txt");
assert.equal(res.status, 404);
console.log("[PASS] /img/ path traversal / wrong dir / non-image -> 404");

// --- 8. 404 ---
res = await call("/nope");
assert.equal(res.status, 404);
console.log("[PASS] unknown route -> 404");

// --- 9. HEAD 请求 ---
res = await call("/api/random", { "user-agent": "curl/8" });
const headLoc = res.headers.get("location");
res = await call(headLoc, {}, "HEAD");
assert.equal(res.status, 200);
assert.equal(await res.text(), "");
console.log("[PASS] HEAD /img/* -> 200 empty body");

// --- 10. 空目录 ---
const mf2 = new Miniflare({
  workers: [{
    name: "suiji-empty",
    modules: [{ type: "ESModule", path: "./worker.js" }],
    compatibilityDate: "2025-09-01",
    r2Buckets: ["BUCKET"],
  }],
});
res = await mf2.dispatchFetch("https://example.com/api/random");
assert.equal(res.status, 404);
const err = await res.json();
assert.equal(err.error, "no images");
console.log("[PASS] empty bucket -> 404 {error:'no images'}");

console.log("\n=== ALL 10 TESTS PASSED ===");
await mf.dispose();
await mf2.dispose();
process.exit(0);
