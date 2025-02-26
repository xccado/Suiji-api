# 随机图片 API (Random Image API)

[![Deno Deploy](https://img.shields.io/badge/Deno%20Deploy-ready-brightgreen?logo=deno)](https://deno.com/deploy)

这是一个基于 Cloudflare R2 和 Deno Deploy 构建的随机图片 API。它可以根据用户设备（桌面或移动设备）自动返回相应尺寸的图片，并且支持自定义域名。

## 功能特点

*   **设备自适应：**  自动检测 User-Agent，为桌面和移动设备提供不同文件夹中的图片。
*   **Cloudflare R2 集成：** 使用 Cloudflare R2 作为图片存储，提供高可用性和全球分发。
*   **自定义域名支持：** 可以通过环境变量配置自定义域名。
*   **Deno Deploy 部署：**  使用 Deno Deploy 进行快速、便捷的部署。
*   **美观的 UI 界面:** 提供一个美观大方的主页，方便用户了解和使用API
*   **易于使用：** 提供了多种使用 API 的方法，包括直接在 HTML、CSS、JavaScript 和 Markdown 中使用。

## 项目结构
├── app.ts // 主程序文件
├── public/
│ └── style.css // CSS 样式文件
├── views/
│ └── index.ejs // 主页模板
└── utils/
└── r2.ts // Cloudflare R2 交互模块

## 快速开始

### 1. 前提条件

*   拥有 Cloudflare 账户和已启用的 R2 存储桶。
*   拥有 Deno Deploy 账户（免费版即可）。
*   （可选）拥有一个自定义域名。

### 2. Cloudflare R2 设置

1.  **创建 R2 存储桶：**
    *   在 Cloudflare 仪表板中，转到 R2 部分。
    *   创建一个新的存储桶。
    *   在存储桶的“设置”中，找到并记录以下信息：
        *   **Bucket Name（存储桶名称）**
        *   **Account ID（账户 ID）**。
    *   在“设置”->“R2 API 令牌”中，创建 API 令牌，并记录：
        *    **Access Key ID**
        *   **Secret Access Key**

2.  **上传图片：**
    *   在存储桶中创建两个文件夹：`pc` (用于桌面图片) 和 `mobile` (用于移动设备图片)。
    *   将图片上传到相应的文件夹中。 确保存储桶中的图片是公开可访问的。

3. **(可选) 自定义域名设置:**
   * 在r2存储桶设置中,选择添加自定义域,然后根据提示操作.
   * 在你的域名注册商（例如 GoDaddy、Namecheap）处，为你的自定义域名添加一个 CNAME 记录。这个 CNAME 记录应该指向你的 Cloudflare R2 存储桶的默认域名（类似于 `your-bucket-name.account-id.r2.cloudflarestorage.com`）。
   * Cloudflare 建议开启cloudflare代理（橙色云图标）

### 3. Deno Deploy 设置

1.  **创建项目：**
    *   在 Deno Deploy 网站上创建一个新项目。
    *   将项目关联到你的 GitHub 仓库（包含 `app.ts`、`public/`、`views/` 和 `utils/` 文件夹）。
2.  **配置环境变量：**
    *   在 Deno Deploy 项目的“设置”->“环境变量”中，添加以下变量：
        *   `CLOUDFLARE_ACCOUNT_ID`:  你的 Cloudflare Account ID。
        *   `CLOUDFLARE_ACCESS_KEY_ID`:  你的 R2 Access Key ID。
        *   `CLOUDFLARE_SECRET_ACCESS_KEY`: 你的 R2 Secret Access Key。
        *   `CLOUDFLARE_R2_BUCKET_NAME`: 你的 R2 存储桶名称。
        *   `CUSTOM_DOMAIN` (可选): 你的自定义域名（如果使用）。
3.  **部署：**
    *   点击“部署”按钮，Deno Deploy 将自动构建和部署你的 API。