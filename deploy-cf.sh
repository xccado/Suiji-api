#!/usr/bin/env bash
# Suiji-api 一键部署到 Cloudflare Workers（R2 原生绑定，无需 AccessKey）
# 用法:
#   ./deploy-cf.sh                          # 交互式（提示输入 Token）
#   CLOUDFLARE_API_TOKEN=xxx ./deploy-cf.sh
#
# Token 需要的 Permissions（用模板 "Edit Cloudflare Workers" 即可）:
#   Account | Workers Scripts | Edit
#   Account | Workers R2 Storage | Edit
#   Account | Account Settings | Read

set -euo pipefail
cd "$(dirname "$0")"

WORKER_NAME="suiji-api"
BUCKET_NAME="suiji-images"

# ---------- 1. Token ----------
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "==> 未检测到 CLOUDFLARE_API_TOKEN 环境变量"
  echo "    请到 https://dash.cloudflare.com/profile/api-tokens"
  echo "    用模板 [Edit Cloudflare Workers] 创建 Token，然后："
  echo "    CLOUDFLARE_API_TOKEN=你的token $0"
  exit 1
fi
export CLOUDFLARE_API_TOKEN

# ---------- 2. 确保 R2 桶存在，并写进 wrangler.toml ----------
if ! grep -q 'r2_buckets' wrangler.toml; then
  echo "==> 检查/创建 R2 桶 ${BUCKET_NAME} ..."
  CREATE_OUT="$(npx wrangler r2 bucket create "$BUCKET_NAME" 2>&1 || true)"
  echo "$CREATE_OUT" | head -3
  # 已存在或创建成功都继续，验证一下桶确实存在
  npx wrangler r2 bucket list 2>/dev/null | jq -e --arg b "$BUCKET_NAME" \
    'any(.[]; .name == $b)' >/dev/null 2>&1 || {
      echo "桶 ${BUCKET_NAME} 不存在且创建失败，原始输出："; echo "$CREATE_OUT"; exit 1;
    }
  cat >> wrangler.toml <<EOF

[[r2_buckets]]
binding = "BUCKET"
bucket_name = "${BUCKET_NAME}"
EOF
  echo "==> R2 桶已绑定: ${BUCKET_NAME}"
else
  echo "==> wrangler.toml 已有 R2 配置，跳过"
fi

# ---------- 3. 部署 ----------
echo "==> 部署 Worker ..."
npx wrangler deploy

# ---------- 4. 结果 ----------
SUBDOMAIN="$(npx wrangler whoami 2>/dev/null | grep -oE 'https://[a-z0-9.-]+workers\.dev' | head -1 || true)"
echo ""
echo "=============================================="
echo "  部署完成！"
if [[ -n "${SUBDOMAIN:-}" ]]; then
  echo "  API 地址: https://${WORKER_NAME}.$(echo "$SUBDOMAIN" | sed 's|https://||')"
else
  echo "  API 地址: https://${WORKER_NAME}.<你的子域>.workers.dev"
fi
echo ""
echo "  接下来:"
echo "  1. 上传图片到 R2 桶 ${BUCKET_NAME} 的 pc/ 和 mobile/ 目录"
echo "     (dash -> R2 -> ${BUCKET_NAME} -> Upload，或用 rclone/s3 工具)"
echo "  2. 测试: curl -I 'https://<api地址>/api/random'"
echo "  3. 绑自定义域名: dash -> Workers & Pages -> ${WORKER_NAME}"
echo "     -> Settings -> Domains & Routes -> Add -> Custom domain"
echo "=============================================="
