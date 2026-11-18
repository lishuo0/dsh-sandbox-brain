#!/usr/bin/env bash
# 启动本地数据库和脑。
# config.yaml 默认 database.file（SQLite，和平台共用一个文件，不需要数据库和 Docker）；
# 配了 database.url 才启动 PostgreSQL。
#   ./scripts/dev.sh [start|stop|status]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUN="$ROOT/var/run"
LOG="$ROOT/var/log"
PG_DIR="$ROOT/var/pg"
CMD="${1:-start}"

db_mode() {
  node --input-type=module -e '
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
const config = process.argv[1];
let inDb = false, file = "", url = "";
for (const raw of readFileSync(config, "utf8").split("\n")) {
  if (!raw.trim() || raw.trimStart().startsWith("#")) continue;
  if (/^\S/.test(raw)) { inDb = /^database:\s*$/.test(raw); continue }
  if (!inDb) continue;
  const match = raw.match(/^\s+(file|url):\s*(.*)$/);
  if (!match) continue;
  const value = match[2].trim().replace(/^["\x27]|["\x27]$/g, "");
  if (match[1] === "file") file = value; else url = value;
}
// 没写 database 时用和平台共用的默认 SQLite（与 src/config.ts 一致）。
const fallback = resolve(dirname(config), "../dsh-sandbox-platform/var/dsh.sqlite");
console.log(file ? `sqlite ${resolve(dirname(config), file)}` : url ? "postgres" : `sqlite ${fallback}`);
' "$ROOT/config.yaml"
}

DB="$(db_mode)"
DB_KIND="${DB%% *}"
DB_FILE="${DB#* }"

mkdir -p "$RUN" "$LOG"

compose() {
  if docker compose version >/dev/null 2>&1; then
    docker compose -f "$ROOT/docker-compose.yml" "$@"
  elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose -f "$ROOT/docker-compose.yml" -p dsh-sandbox "$@"
  else
    echo "没有 docker compose。先安装并启动 Docker。" >&2
    exit 1
  fi
}

port_open() {
  node -e 'const n=require("net"); const s=n.connect(Number(process.argv[1]), "127.0.0.1", () => { s.end(); process.exit(0) }); s.on("error", () => process.exit(1))' "$1"
}

kill_tree() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

local_pg_ready() {
  command -v initdb >/dev/null 2>&1 && command -v pg_ctl >/dev/null 2>&1 &&
    command -v pg_isready >/dev/null 2>&1 && command -v createdb >/dev/null 2>&1
}

start_local_database() {
  echo "启动数据库（本地 PostgreSQL，${PG_DIR}）"
  if [[ ! -f "$PG_DIR/PG_VERSION" ]]; then
    LC_ALL=C initdb -D "$PG_DIR" -U dsh --auth-local=trust --auth-host=trust -E UTF8 --locale=C >/dev/null
  fi
  if ! pg_ctl -D "$PG_DIR" status >/dev/null 2>&1; then
    LC_ALL=C pg_ctl -D "$PG_DIR" -l "$LOG/postgres.log" -o "-p 5432 -k /tmp" start >/dev/null
  fi
  local i
  for i in $(seq 1 60); do
    pg_isready -h 127.0.0.1 -p 5432 -U dsh >/dev/null 2>&1 && break
    sleep 1
  done
  createdb -h 127.0.0.1 -p 5432 -U dsh dsh 2>/dev/null || true
}

ensure_config() {
  node --input-type=module -e '
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
const file = process.argv[1];
let text = readFileSync(file, "utf8");
let changed = false;
if (/appKey:\s*""/.test(text)) {
  text = text.replace(/appKey:\s*""/, `appKey: "${randomBytes(12).toString("hex")}"`);
  changed = true;
}
if (/credentialsKey:\s*""/.test(text)) {
  text = text.replace(/credentialsKey:\s*""/, `credentialsKey: "${randomBytes(32).toString("base64")}"`);
  changed = true;
}
if (changed) {
  writeFileSync(file, text);
  console.log("已为 config.yaml 生成 appKey / credentialsKey，调用方需使用同一组值。");
}
' "$ROOT/config.yaml"
}

case "$CMD" in
  stop)
    if [[ -f "$RUN/brain.pid" ]]; then
      pid="$(cat "$RUN/brain.pid")"
      if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
        kill_tree "$pid"
        wait "$pid" 2>/dev/null || true
      fi
      rm -f "$RUN/brain.pid"
    fi
    if [[ "$DB_KIND" == "postgres" && -f "$PG_DIR/PG_VERSION" ]] && pg_ctl -D "$PG_DIR" status >/dev/null 2>&1; then
      pg_ctl -D "$PG_DIR" stop -m fast >/dev/null
      echo "脑和本地数据库已停止。"
    elif [[ "$DB_KIND" == "sqlite" ]]; then
      echo "脑已停止。SQLite 无需停止数据库。"
    else
      echo "脑已停止。数据库仍由 Docker 保持，需要停下时在本目录执行 docker compose stop。"
    fi
    ;;
  status)
    if [[ "$DB_KIND" == "sqlite" ]]; then
      echo "sqlite    $DB_FILE"
    else
      port_open 5432 && echo "postgres  5432  已监听" || echo "postgres  5432  未监听"
    fi
    port_open 8080 && echo "brain     8080  已监听" || echo "brain     8080  未监听"
    ;;
  start)
    ensure_config
    if [[ "$DB_KIND" == "sqlite" ]]; then
      echo "数据库 SQLite（${DB_FILE}），不需要启动数据库"
    elif ! port_open 5432; then
      if docker_ready; then
        compose up -d
        for i in $(seq 1 60); do
          compose exec -T postgres pg_isready -U dsh -d dsh >/dev/null 2>&1 && break
          sleep 1
        done
      elif command -v colima >/dev/null 2>&1 && command -v docker >/dev/null 2>&1; then
        echo "启动 Colima"
        colima start
        compose up -d
        for i in $(seq 1 60); do
          compose exec -T postgres pg_isready -U dsh -d dsh >/dev/null 2>&1 && break
          sleep 1
        done
      elif local_pg_ready; then
        start_local_database
      else
        echo "没有 Docker，也没有本地 PostgreSQL。安装 Docker，或 brew install postgresql@16。" >&2
        exit 1
      fi
    fi
    if port_open 8080; then
      echo "脑已在 8080 监听"
      exit 0
    fi
    # profile 按包的 lib/ 加载（不是 tsx 直接跑源码）；不重建会把改动留在源码里，
    # 起新进程却仍跑旧行为。
    echo "构建 workspace 包"
    if ! (cd "$ROOT" && npm run build); then
      echo "构建失败，未启动脑。" >&2
      exit 1
    fi
    (
      cd "$ROOT"
      nohup npm start >> "$LOG/brain.log" 2>&1 &
      echo $! > "$RUN/brain.pid"
    )
    echo "脑日志 $LOG/brain.log"
    ;;
  *)
    echo "用法: ./scripts/dev.sh [start|stop|status]" >&2
    exit 1
    ;;
esac
