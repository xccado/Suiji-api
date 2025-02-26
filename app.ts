import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import {getR2Image, initializeR2} from "./utils/r2.ts"

await initializeR2();

const app = new Application();
const router = new Router();

// 错误处理中间件
app.use(async (ctx, next) => {
  try {
    await next();
  } catch (err) {
    ctx.response.status = 500;
    ctx.response.body = { message: "Internal Server Error", error: err.message };
    console.error(err);
  }
});

// 日志记录中间件
app.use(async (ctx, next) => {
  await next();
  const rt = ctx.response.headers.get("X-Response-Time");
  console.log(`${ctx.request.method} ${ctx.request.url} - ${rt}`);
});

// 计时中间件
app.use(async (ctx, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  ctx.response.headers.set("X-Response-Time", `${ms}ms`);
});

// 静态文件服务 (CSS)
app.use(async (ctx, next) => {
    if (ctx.request.url.pathname.startsWith("/public")) {
      await send(ctx, ctx.request.url.pathname, {
        root: `${Deno.cwd()}`,
      });
    } else {
      await next();
    }
});

// API 路由：获取随机图片
router.get("/api/random", async (ctx) => {
    console.log("Handling /api/random request");
    try {
    const userAgent = ctx.request.headers.get("user-agent");
    const isMobile = /iPhone|iPad|iPod|Android/i.test(userAgent || "");
    const folder = isMobile ? "mobile" : "pc";
    console.log(`User agent: ${userAgent}, isMobile: ${isMobile}, folder: ${folder}`);

        const imageUrl = await getR2Image(folder);
    if (imageUrl) {
      ctx.response.redirect(imageUrl); //直接重定向到 Cloudflare R2 URL
    } else {
      ctx.response.status = 404;
      ctx.response.body = { message: "No images found" };
    }
  } catch (error) {
    console.error("Error in /api/random:", error);
      ctx.response.status = 500;
        ctx.response.body = 'error'

  }
});

// 主页路由
router.get("/", async (ctx) => {
  console.log("Handling / (home) request");
  try{
      const html = await Deno.readTextFile("./views/index.ejs");
        ctx.response.body = html;
        ctx.response.headers.set("Content-Type", "text/html");
  }catch(e){
      console.log(e)
      ctx.response.status = 500;
        ctx.response.body = 'error'
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

const port = 8000;
console.log(`Server running on http://localhost:${port}`);
await app.listen({ port });