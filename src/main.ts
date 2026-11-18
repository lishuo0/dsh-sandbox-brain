import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import pg from "pg";
import { brainHome, loadConfig, projectRoot, storageRoot } from "./config.js";

/**
 * 只读 brain/config.yaml。进程环境里的数据库、沙箱、OSS 都从这一份注入，
 * profile 只引用这些变量，不再另存一份密钥。
 */
const cfg = loadConfig();
const root = projectRoot();
// 本地运行时数据（附件、请求缓存、profile 软链）只能落在配置的 storage.dir，
// 不能写回脑仓库自身；storage.dir 与平台的对象目录是同一份。
const home = brainHome(cfg, root);
mkdirSync(resolve(home, "profiles"), { recursive: true });
// profile 现在不在仓库目录下，`@brain/*` 这些 workspace 包要从仓库的
// node_modules 解析；给 home 挂一个软链，保持依赖解析链不断。
const homeModules = resolve(home, "node_modules");
if (!existsSync(homeModules)) symlinkSync(resolve(root, "node_modules"), homeModules, "dir");

const env: NodeJS.ProcessEnv = {
  ...process.env,
  DSH_HOME: home,
  DSH_HOST: cfg.http.host,
  PORT: String(cfg.http.port),
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
if (cfg.database.file) {
  // 本地 SQLite：先把 schema 建好，再把文件路径交给 profile。
  const file = cfg.database.file;
  mkdirSync(dirname(file), { recursive: true });
  const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as typeof import("node:sqlite");
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(readFileSync(resolve(root, "src/schema.sqlite.sql"), "utf8"));
  } finally {
    db.close();
  }
  env.DSH_DATABASE_FILE = file;
  delete env.DSH_DATABASE_URL;
  console.log(`database sqlite ${file}`);
} else {
  const pool = new pg.Pool({ connectionString: cfg.database.url });
  try {
    await pool.query(readFileSync(resolve(root, "src/schema.sql"), "utf8"));
  } finally {
    await pool.end();
  }
  env.DSH_DATABASE_URL = cfg.database.url;
  delete env.DSH_DATABASE_FILE;
}
if (!cfg.aliyun.sandbox.apiKey.trim()) {
  env.DSH_LOCAL_STORE = storageRoot(cfg, root);
  mkdirSync(env.DSH_LOCAL_STORE, { recursive: true });
  const explicit = process.env.SANDBOX_ADAPTER?.trim() ?? "";
  const dockerReady =
    spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: "ignore",
      timeout: 3_000,
    }).status === 0;
  if (explicit !== "") {
    env.SANDBOX_ADAPTER = explicit;
    if (explicit === "docker" && !dockerReady) {
      console.error(
        "SANDBOX_ADAPTER=docker 但 docker 守护进程不可用；请先安装并启动 Docker（macOS 可用 colima），或改用 SANDBOX_ADAPTER=mock。",
      );
      process.exit(1);
    }
  } else if (dockerReady) {
    env.SANDBOX_ADAPTER = "docker";
  } else {
    env.SANDBOX_ADAPTER = "mock";
    console.warn("未检测到可用的 Docker，本地沙箱回退到 mock（没有内核隔离）。");
  }
  console.log(`sandbox ${env.SANDBOX_ADAPTER} local ${env.DSH_LOCAL_STORE}`);
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
