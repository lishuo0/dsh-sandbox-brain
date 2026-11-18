import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface BrainConfig {
  /** 本地默认 SQLite 文件；部署用 PostgreSQL 连接串。二选一。 */
  database: { url?: string; file?: string };
  aliyun: {
    sandbox: {
      apiKey: string;
      apiUrl: string;
      domain: string;
      template: string;
      roleArn: string;
    };
    oss: {
      region: string;
      endpoint: string;
      bucket: string;
      accessKeyId: string;
      accessKeySecret: string;
    };
  };
  http: { host: string; port: number };
  platform: { appId: string; appKey: string };
  credentialsKey: string;
  dshVersion: string;
  /** 本地沙箱与平台共用的对象目录。相对本项目根目录。 */
  storage?: { dir?: string };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 配置里没写数据库时用的本地 SQLite 文件：和平台指向同一个文件。 */
export const DEFAULT_DATABASE_FILE = "../dsh-sandbox-platform/var/dsh.sqlite";

export function projectRoot(): string {
  return root;
}

/**
 * 本地运行时数据（附件、请求缓存、profile 软链）的根目录。
 *
 * 只能落在配置的 `storage.dir`——它和平台的对象目录是同一份；没配时退到
 * 仓库的 `var/objects`。绝不能回落到脑仓库自身（例如 `.dsh`），那是宿主目录。
 */
export function storageRoot(cfg: BrainConfig, base = root): string {
  const configured = cfg.storage?.dir?.trim() ?? "";
  return configured ? resolve(base, configured) : resolve(base, "var/objects");
}

/** DSH 的 home 目录：profile 软链和插件的本地状态都在这里。 */
export function brainHome(cfg: BrainConfig, base = root): string {
  return resolve(storageRoot(cfg, base), "brain-home");
}

export function loadConfig(): BrainConfig {
  const file = resolve(root, "config.yaml");
  const raw = yaml.load(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("config.yaml 不是一份配置");
  const cfg = raw as BrainConfig;
  // 写 file 用指定的 SQLite 文件；写 url 接 PostgreSQL；都没写就用和平台共用的默认 SQLite。
  const dbFile = cfg.database?.file?.trim() ?? "";
  if (dbFile) {
    cfg.database = { file: resolve(root, dbFile) };
  } else if (cfg.database?.url?.trim()) {
    cfg.database = { url: cfg.database.url.trim() };
  } else {
    cfg.database = { file: resolve(root, DEFAULT_DATABASE_FILE) };
  }
  // 服务间凭据优先取环境变量，部署时不必把真实值写进仓库里的 config.yaml。
  cfg.platform = cfg.platform ?? { appId: "", appKey: "" };
  if (process.env.DSH_PLATFORM_APP_ID !== undefined) cfg.platform.appId = process.env.DSH_PLATFORM_APP_ID;
  if (process.env.DSH_PLATFORM_APP_KEY !== undefined) cfg.platform.appKey = process.env.DSH_PLATFORM_APP_KEY;
  if (process.env.DSH_CREDENTIALS_KEY !== undefined) cfg.credentialsKey = process.env.DSH_CREDENTIALS_KEY;
  if (!cfg.platform?.appId || !cfg.platform?.appKey) throw new Error("config.yaml 缺少 platform.appId 或 platform.appKey");
  if (!cfg.aliyun?.sandbox?.apiUrl || !cfg.aliyun?.sandbox?.domain) {
    throw new Error("config.yaml 缺少阿里云沙箱地址");
  }
  return cfg;
}
