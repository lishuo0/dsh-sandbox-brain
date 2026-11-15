import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

export interface BrainConfig {
  database: { url: string };
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

export function projectRoot(): string {
  return root;
}

export function loadConfig(): BrainConfig {
  const file = resolve(root, "config.yaml");
  const raw = yaml.load(readFileSync(file, "utf8"));
  if (!raw || typeof raw !== "object") throw new Error("config.yaml 不是一份配置");
  const cfg = raw as BrainConfig;
  if (!cfg.database?.url) throw new Error("config.yaml 缺少 database.url");
  if (!cfg.platform?.appId || !cfg.platform?.appKey) throw new Error("config.yaml 缺少 platform.appId 或 platform.appKey");
  if (!cfg.aliyun?.sandbox?.apiUrl || !cfg.aliyun?.sandbox?.domain) {
    throw new Error("config.yaml 缺少阿里云沙箱地址");
  }
  return cfg;
}
