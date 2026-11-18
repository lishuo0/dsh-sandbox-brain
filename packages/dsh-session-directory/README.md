# @brain/dsh-session-directory

把会话解析成"属于谁、哪个项目"。沙箱注册表每次工具调用都问它。

## 为什么需要

DSH 不认识用户。沙箱要按会话路由到对应 microVM，就必须有一个地方回答：

```text
sessionId → { userId, workspaceId }
```

数据来自平台写的 `sessions` 表，这个插件只读。

## 用法

```yaml
- id: session-directory
  name: '@brain/dsh-session-directory'
  config:
    cacheTtlMs: 30000      # 0 关闭缓存
    cacheMaxEntries: 10000
```

```ts
const owner = await ctx.sessionDirectory.owner(sessionId)
// { userId, workspaceId, volumeName?, skillsVolume?, skillGroups?, mcpGroups? } 或 undefined
```

工作区独占一台沙箱，沙箱里只挂这块工作区的工作卷，所以所有工作区的挂载点和会话 cwd
都是同一个固定路径（`/desk`）。沙箱注册表自己决定这个路径，owner 只负责告诉它卷名。

## 缓存是必需的

一次文件操作会问一次，一个步骤十几次工具调用：

```text
无缓存  每个 read/write 一次数据库往返
有缓存  同一会话三十秒内只查一次
```

缓存的失效策略是 TTL + `forget(sessionId)`。**没有主动失效也能安全跑**：缓存里的答案只会指向调用方本来就有权限的沙箱——会话换主人是平台侧的操作，正常情况下不会发生。

## 关于"查不到"

```text
会话不存在            → undefined
存在但没有 workspace   → undefined，并记一条 warn
```

两者对调用方是同一个结果。沙箱注册表拿到 undefined 会拒绝服务——**宁可失败，也不要给一个猜出来的沙箱**。
