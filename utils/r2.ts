// utils/r2.ts
// 更改这里的导入
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "https://deno.land/x/aws_sdk@v3.515.0/clients/s3/mod.ts";

let s3: S3Client;

// 从环境变量中获取 Cloudflare R2 的配置信息, 在 Deno Deploy 的环境变量中配置
const accountId = Deno.env.get("CLOUDFLARE_ACCOUNT_ID");
const accessKeyId = Deno.env.get("CLOUDFLARE_ACCESS_KEY_ID");
const secretAccessKey = Deno.env.get("CLOUDFLARE_SECRET_ACCESS_KEY");
const bucketName = Deno.env.get("CLOUDFLARE_R2_BUCKET_NAME");
const customDomain = Deno.env.get("CUSTOM_DOMAIN");

// 初始化 R2 客户端
export async function initializeR2() {
    if (!accountId || !accessKeyId || !secretAccessKey || !bucketName || !customDomain) {
        throw new Error("Missing Cloudflare R2 environment variables. Please check CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_ACCESS_KEY_ID, CLOUDFLARE_SECRET_ACCESS_KEY, CLOUDFLARE_R2_BUCKET_NAME and CUSTOM_DOMAIN");
    }

    const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

// 修改这里
    s3 = new S3Client({
        region: "auto",
        endpoint,
        credentials: {
            accessKeyId,
            secretAccessKey,
        },
    });

    console.log("Cloudflare R2 client initialized.");
}

export async function getR2Image(folder: string): Promise<string | undefined> {
    try {
        // 列出指定文件夹下的所有对象, 这里也修改了
        const listObjectsResponse = await s3.send(new ListObjectsV2Command({
            Bucket: bucketName,
            Prefix: folder + "/", // 注意这里的斜杠
        }));
        console.log(`Listed objects in R2 bucket: ${bucketName}, folder: ${folder}`, listObjectsResponse);

        if (!listObjectsResponse.Contents || listObjectsResponse.Contents.length === 0) {
            console.log("No images found in the specified folder.");
            return undefined;
        }

        // 过滤掉非图片文件 (包含 webp)
        const imageKeys = listObjectsResponse.Contents
            .filter(obj => obj.Key && /\.(jpg|jpeg|png|gif|webp)$/i.test(obj.Key))
            .map(obj => obj.Key!);

        if (imageKeys.length === 0) {
            console.log("No images found in the specified folder after filtering.");
            return undefined; // 没有图片
        }

        // 随机选择一个图片
        const randomKey = imageKeys[Math.floor(Math.random() * imageKeys.length)];
        console.log(`Selected random image key: ${randomKey}`);

        // 使用自定义域名构建 URL
        return `https://${customDomain}/${randomKey}`;

    } catch (error) {
        console.error("Error getting image from R2:", error);
        throw error;
    }
}