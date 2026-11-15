#!/usr/bin/env bash
# 启动本地数据库和脑。平台请用平台项目里的 ./scripts/dev.sh，那个会把两边一起拉起。
#   ./scripts/dev.sh
#   ./scripts/dev.sh stop
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="$(cd "$ROOT/.." && pwd)/dsh-sandbox-platform"
RUN="$ROOT/var/run"
LOG="$ROOT/var/log"
CMD="${1:-start}"

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
    echo "脑已停止。数据库仍由 Docker 保持，需要停下时在本目录执行 docker compose stop。"
    ;;
  start)
    if [[ -f "$PLATFORM/scripts/ensure-config.mjs" ]]; then
      node "$PLATFORM/scripts/ensure-config.mjs"
    fi
    if ! command -v docker >/dev/null 2>&1; then
      echo "没有 docker。安装并启动 Docker 后再执行 ./scripts/dev.sh" >&2
      exit 1
    fi
    if ! docker info >/dev/null 2>&1; then
      if command -v colima >/dev/null 2>&1; then
        echo "启动 Colima"
        colima start
      else
        echo "Docker 没有在运行。" >&2
        exit 1
      fi
    fi
    compose up -d
    for i in $(seq 1 60); do
      compose exec -T postgres pg_isready -U dsh -d dsh >/dev/null 2>&1 && break
      sleep 1
    done
    if port_open 8080; then
      echo "脑已在 8080 监听"
      exit 0
    fi
    (
      cd "$ROOT"
      nohup npm start >> "$LOG/brain.log" 2>&1 &
      echo $! > "$RUN/brain.pid"
    )
    echo "脑日志 $LOG/brain.log"
    ;;
  *)
    echo "用法: ./scripts/dev.sh [start|stop]" >&2
    exit 1
    ;;
esac
