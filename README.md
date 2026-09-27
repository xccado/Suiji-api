# 随机图片 API (Suiji-api)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-orange?logo=cloudflare)](https://workers.cloudflare.com/)

基于 **Cloudflare Workers + R2 原生绑定** 的随机图片 API。根据用户设备（桌面/移动）自动返回对应目录的随机图片。

## 功能特点

* **R2 原生绑定**：无需 AccessKey/SecretKey，桶保持**私有**即可，不再需要给桶配公开访问和自定义域名
* **边缘缓存**：图片经 Worker 代理输出并写入 Cache API，重复请求命中 Cloudflare 边缘节点
* **目录列表缓存**：TTL 内存缓存，不用每次请求都扫桶（原来每次请求都调 S3 listObjectsV2）
* **设备自适应**：自动检测 User-Agent，返回 `pc/` 或 `mobile/` 目录的图片，也可用 `?dir=` 强制指定
* **防频繁下载**：按 IP 限速（默认 `/api/random` 30 次/分、`/img/` 60 次/分），超限返回 429，可用环境变量调整或关闭
* **单文件部署**：首页 HTML/CSS 全部内嵌在 worker 里，无静态资源依赖
* **JSON 模式**：`?format=json` 返回图片直链，方便程序化调用

## API

| 路由 | 说明 |
| --- | --- |
| `GET /api/random` | 随机图片，302 重定向到图片代理地址 |
| `GET /api/random?format=json` | 返回 `{ url, key, folder }` JSON |
| `GET /api/random?dir=pc` 或 `?dir=mobile` | 强制指定目录 |
| `GET /img/<key>` | 图片代理（边缘缓存 1 天） |
| `GET /` | 使用说明首页 |

## 快速开始

### 1. 前提条件

* Cloudflare 账户（免费版即可，Workers 免费额度每天 10 万次请求）
* 创建一个 API Token：<https://dash.cloudflare.com/profile/api-tokens> → 模板 **Edit Cloudflare Workers**

### 2. 一键部署

```bash
CLOUDFLARE_API_TOKEN=你的token ./deploy-cf.sh
```

脚本会自动：创建 R2 桶（默认 `suiji-images`）→ 写入 wrangler.toml → 部署 Worker。

### 3. 上传图片

在 R2 桶里建两个目录并上传图片：

* `pc/` — 桌面端图片
* `mobile/` — 移动端图片

上传方式：dash → R2 → 你的桶 → Upload；或用 rclone 等 S3 工具。

### 4. 测试

```bash
curl -I 'https://suiji-api.<你的子域>.workers.dev/api/random'
# HTTP/2 302 -> /img/pc/xxx.jpg
```

### 5. （可选）自定义域名

dash → Workers & Pages → `suiji-api` → Settings → Domains & Routes → Add → Custom domain。
**不需要**再给 R2 桶配自定义域名或公开访问。

## 配置项（wrangler.toml `[vars]`，均有默认值）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PC_DIR` | `pc` | 桌面端图片目录 |
| `MOBILE_DIR` | `mobile` | 移动端图片目录 |
| `LIST_CACHE_TTL` | `300` | 目录列表缓存秒数 |
| `RATE_LIMIT_RANDOM` | `30` | `/api/random` 每窗口每 IP 请求上限，`0` 关闭 |
| `RATE_LIMIT_IMG` | `60` | `/img/*` 每窗口每 IP 请求上限，`0` 关闭 |
| `RATE_LIMIT_WINDOW` | `60` | 限速窗口（秒） |

> 限速基于 Cloudflare 边缘节点计数（尽力而为，按 IP 固定窗口），足以拦截暴力爬图；如需全局精确限速可自行加 Durable Object。

## 项目结构

```
├── worker.js        # Worker 主程序（首页内嵌，单文件）
├── wrangler.toml    # 部署配置（R2 绑定）
├── deploy-cf.sh     # 一键部署脚本
└── README.md
```

## 从 Deno 版迁移

本项目原为 Deno Deploy + R2 S3 API 版本，现已改为 Workers 原生部署。如果你的 R2 桶里已有图片，无需改动——部署后 Worker 会直接读取原桶的 `pc/` 和 `mobile/` 目录，之前通过 S3 API/自定义域名公开访问的图片也可以继续按原 URL 访问（互不影响）。

## License

MIT
