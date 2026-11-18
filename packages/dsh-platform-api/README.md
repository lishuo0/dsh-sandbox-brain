# @brain/dsh-platform-api

脑对外的 HTTP 面：会话、消息、事件流、工作区文件、后台任务。纯 Node HTTP，自带调用方认证，不经过 DSH 的浏览器认证和 Typert RPC。

完整契约（请求头、请求体、响应、SSE 帧、错误码）见 [docs/接口.md](../../docs/接口.md)。

## 端点

```text
POST /brain/v1/sessions                              新建或恢复会话
POST /brain/v1/sessions/{id}/messages                提交消息
POST /brain/v1/sessions/{id}/cancel                  中断当前轮次
POST /brain/v1/sessions/{id}/force-cancel            强制收束轮次
GET  /brain/v1/sessions/{id}/events?after=N          事件回放 + 实时帧（SSE）
GET  /brain/v1/sessions/{id}/projections             投影基线
POST /brain/v1/sessions/{id}/model                   切换模型
GET  /brain/v1/sessions/{id}/commands                命令列表
POST /brain/v1/sessions/{id}/commands                执行命令
GET|PUT /brain/v1/sessions/{id}/goal                 读取/修改目标
POST /brain/v1/sessions/{id}/goal/{action}           暂停/恢复/完成/清除
POST /brain/v1/sessions/{id}/preset                  切换预设
GET|POST|DELETE /brain/v1/sessions/{id}/message-feedback
POST /brain/v1/sessions/{id}/feedback                会话级备注
GET  /brain/v1/sessions/{id}/jobs                    后台任务清单（SSE）
GET  /brain/v1/sessions/{id}/jobs/{jobId}/output     任务输出（SSE）
POST /brain/v1/sessions/{id}/jobs/{jobId}/kill       终止任务
GET|POST /brain/v1/sessions/{id}/workspace-files     列目录 / 上传
GET  /brain/v1/sessions/{id}/workspace-files/content 读文件
GET  /brain/v1/sessions/{id}/workspace-files/stat    文件元信息
GET  /brain/v1/models  /brain/v1/presets  /brain/v1/permission-presets
GET  /brain/v1/client-token                          浏览器 UI 启动令牌
```

会话列表、搜索、统计不在这里。它们按用户过滤，而 DSH 不认识用户，平台直接查数据库。

## 认证

```text
x-app-id        调用方标识
x-app-key       调用方密钥（≥16 字符）
x-dsh-user-id   这次请求代表哪个用户（必填，可用 requireUser: false 放宽）
x-request-id    可选的幂等/追踪 id，缺省时自动生成并回显
```

凭据可以配在 JSON 文件里（`credentialsFile`，默认读 `DSH_PLATFORM_APPS`），也可以直接写在 profile 的 `apps` 列表里：

```json
{
  "apps": [
    { "appId": "platform", "appKey": "…", "name": "生产" },
    { "appId": "platform-staging", "appKey": "…", "name": "预发" }
  ]
}
```

三条约束：摘要比较是常数时间；未知 `appId` 和错误密钥返回同一个 401；没有凭据就拒绝加载。

## 配置

```yaml
- id: platform-api
  name: '@brain/dsh-platform-api'
  config:
    requireUser: true
    pageSize: 200
    heartbeatMs: 15000
    apps:
      - appId: platform
        appKey: !!js process.env.PLATFORM_APP_KEY
    # headers:            # 平台已有自己的头名时覆盖
    #   appId: x-app-id
    #   appKey: x-app-key
    #   userId: x-dsh-user-id
    #   requestId: x-request-id
```

密钥轮换需要重启 profile；没有热加载。

## 两条设计约束

**除 `create` 外的会话路由只作用于本副本上活着的 Agent。** 冷会话要恢复必须走 `create`，路由本身保持无状态。否则一个调用方可以通过消息端点唤醒别的用户的会话。

**归属对不上时返回 404，而不是 403。** 未知会话和别人的会话给同一个答案，避免用 id 枚举。归属读共享库的 `dsh_sessions`；没有挂数据库时只告警、不校验，仅适合单用户开发机。

## 状态

实现与测试已覆盖：认证、会话创建/恢复、消息排队与同 `requestId` 去重、取消与强制收束、SSE 回放/实时帧/心跳、模型与预设切换、后台任务、工作区文件、错误码。集成测试在 `test/integration/routes.test.ts`，端到端技能流在 `test/e2e/skill-flow.test.ts`。
