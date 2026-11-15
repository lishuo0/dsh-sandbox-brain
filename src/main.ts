import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { loadConfig, projectRoot } from "./config.js";

/**
 * 只读 brain/config.yaml。进程环境里的数据库、沙箱、OSS 都从这一份注入，
 * profile 只引用这些变量，不再另存一份密钥。
 */
const cfg = loadConfig();
const root = projectRoot();
const pool = new pg.Pool({ connectionString: cfg.database.url });
try {
  await pool.query(readFileSync(resolve(root, "src/schema.sql"), "utf8"));
} finally {
  await pool.end();
}
const home = resolve(root, ".dsh");
mkdirSync(resolve(home, "profiles"), { recursive: true });

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DSH_HOME: home,
  DSH_HOST: cfg.http.host,
  PORT: String(cfg.http.port),
  DSH_DATABASE_URL: cfg.database.url,
  E2B_API_KEY: cfg.aliyun.sandbox.apiKey,
  E2B_API_URL: cfg.aliyun.sandbox.apiUrl,
  E2B_DOMAIN: cfg.aliyun.sandbox.domain,
  E2B_TEMPLATE: cfg.aliyun.sandbox.template,
  E2B_ROLE_ARN: cfg.aliyun.sandbox.roleArn,
  OSS_REGION: cfg.aliyun.oss.region,
  OSS_ENDPOINT: cfg.aliyun.oss.endpoint,
  OSS_BUCKET: cfg.aliyun.oss.bucket,
  OSS_ACCESS_KEY_ID: cfg.aliyun.oss.accessKeyId,
  OSS_ACCESS_KEY_SECRET: cfg.aliyun.oss.accessKeySecret,
  PLATFORM_APP_ID: cfg.platform.appId,
  PLATFORM_APP_KEY: cfg.platform.appKey,
  DSH_CREDENTIALS_KEY: cfg.credentialsKey,
};
if (!cfg.aliyun.sandbox.apiKey.trim()) {
  env.SANDBOX_ADAPTER = "mock";
  const configured = cfg.storage?.dir?.trim() ?? "";
  env.DSH_LOCAL_STORE = configured ? resolve(root, configured) : resolve(root, "var/objects");
  mkdirSync(env.DSH_LOCAL_STORE, { recursive: true });
  console.log(`sandbox local ${env.DSH_LOCAL_STORE}`);
}

const require = createRequire(import.meta.url);
let pkgPath: string;
try {
  pkgPath = require.resolve("@deepseek-ai/dsh/package.json");
} catch {
  console.error(`没有找到 @deepseek-ai/dsh@${cfg.dshVersion}。在 brain 目录执行 npm install 后再启动。`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin?: string | Record<string, string> };
const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dsh;
if (!rel) {
  console.error(`@deepseek-ai/dsh@${cfg.dshVersion} 没有 dsh 可执行文件。`);
  process.exit(1);
}
const bin = resolve(dirname(pkgPath), rel);
const profile = resolve(root, "profile/api");
const linked = resolve(home, "profiles/api");
if (existsSync(linked)) rmSync(linked, { recursive: true, force: true });
symlinkSync(profile, linked);
const child = spawn(process.execPath, [bin, "--profile", "api", "--port", String(cfg.http.port)], {
  env,
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
