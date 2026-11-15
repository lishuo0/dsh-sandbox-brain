# @brain/dsh-platform-api

REST surface for the agent platform. Plain HTTP, our own contract, our own
authentication — DSH's browser auth and Typert RPC are not involved.

## Endpoints

```text
POST /brain/v1/sessions                    { cwd, preset?, sessionId? }  → 201 { sessionId }
POST /brain/v1/sessions/{id}/messages      { text }                      → 202
POST /brain/v1/sessions/{id}/cancel                                      → 202
GET  /brain/v1/sessions/{id}/events?after=N                              → SSE
   event: event       已提交事件 { seq, type, data }
   event: assistant   模型流式分片（进程内，不落盘）
   event: status      驱动状态 { status }
   event: inbox       队列变化 { phase: inserted|claimed|discarded }
   event: ready       回放结束，开始推实时帧
   : keepalive        心跳注释行，默认 15 秒
```

只有四个端点。会话列表、搜索、统计这类只读查询由平台直查数据库——它们按用户过滤，而 DSH 不认识用户。

## Authentication

```text
x-app-id        调用方标识
x-app-key       调用方密钥（≥16 字符）
x-dsh-user-id   这次请求代表哪个用户（必填，可用 requireUser: false 放宽）
x-request-id    可选的幂等/追踪 id，缺省时自动生成并回显
```

凭据放在一个 JSON 文件里，可以配多个：

```json
{
  "apps": [
    { "appId": "agent-platform", "appKey": "…", "name": "生产" },
    { "appId": "agent-platform-staging", "appKey": "…", "name": "预发" }
  ]
}
```

三条设计约束：

**一、比较是常数时间。** 用的是摘要再比对，不是字符串相等，密钥不能靠响应时间逐字节猜。

**二、未知 appId 和密钥错误返回同一个 401。** 否则调用方可以枚举出哪些 appId 存在。

**三、没有凭据文件就拒绝加载。** 一个未鉴权的公网接口比启动失败更糟。

## Configuration

```yaml
- id: platform-api
  name: '@brain/dsh-platform-api'
  config:
    credentialsFile: !!js process.env.DSH_PLATFORM_APPS
    requireUser: true
    pageSize: 200
    heartbeatMs: 15000
    # headers:            # 平台已有自己的头名时覆盖
    #   appId: x-app-id
    #   appKey: x-app-key
    #   userId: x-dsh-user-id
    #   requestId: x-request-id
```

`DSH_PLATFORM_APPS` 是凭据文件路径。轮换密钥需要重启 profile——没有热加载，因为热加载要有原子切换和失败回滚，现在不值得。

## 历史与实时是两条路

```text
历史（已提交）    平台直查数据库，自己投影
实时（未提交）    只有脑知道：assistant 分片、运行状态、队列变化
```

前端典型流程：

```text
1. GET <平台>/brain/v1/sessions/{id}/history?limit=50   → 查库，投影成节点
2. 取最后一个 seq
3. GET <脑>/brain/v1/sessions/{id}/events?after=<seq>   → 只收增量
```

`events?after=-1` 能回放，但它依赖该会话的 Agent 正好活在这个副本上；历史不该依赖副本，所以产品上不要用它读历史。

没有 `assistant` 帧就做不出逐字输出——`assistant` 的流式分片是瞬时的，落盘的只有结束后的完整消息。

## Status

| 部分 | 状态 |
|---|---|
| 路由与 HTTP 工具 | 完成 |
| 认证（多凭据、常数时间） | 完成 |
| SSE 回放 + 实时推送 + 心跳 | 完成 |
| `prompt` / `cancel` | 完成，走 `agent.followup` / `agent.cancel` |
| `create`（新建或接续） | **需要核对**：用的是 `ctx.agents.createAgent`，要与 API 控制器里的 `ensureSession` 行为对齐 |
| `events` 回放 | 完成，按 `seq` 逐条读日志 |
| 会话不存在时 | 返回 404，**不自动恢复**——否则一个租户能唤醒另一个租户的会话 |

### 为什么 404 而不是自动恢复

`agentFor` 只查内存里活跃的 Agent。要恢复冷会话必须走 `createAgent` 并读日志——那会引入"谁有权恢复"的判断。把这个决定留在 `create` 端点里，路由本身保持无状态。

## 已验证 / 未验证

代码没有编译验证过（这个仓库没装 DSH 依赖）。第一次 `tsc` 时预计要修：

- `ctx.agents.createAgent` 的选项形状
- `SessionEvent.data` 的访问方式
- `agent.cancel` 的参数类型
- `ctx.on('session/event')` 的回调签名
