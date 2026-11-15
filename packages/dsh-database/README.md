# @brain/dsh-database

一个进程一个 PostgreSQL 连接池，注册为 `ctx.db`。

## 为什么单独一个包

三个消费者要连库：

```text
session-persistence    会话日志与租约
sandboxes              沙箱绑定
session-directory      会话归属
```

如果各配一个 URL，就是三个池、三份超时、三处要改。这里统一成一个。

## 用法

```yaml
- id: database
  name: '@brain/dsh-database'
  config:
    url: "postgres://…"
    maxConnections: 10
    statementTimeoutMs: 5000
```

```ts
static inject = ['db']

const rows = await this.ctx.db.query<{ id: string }>('SELECT id FROM dsh_sessions WHERE user_id = $1', [userId])

await this.ctx.db.transaction(async run => {
  await run('INSERT …')
  await run('UPDATE …')
})
```

## 契约

```text
query       取连接、执行、归还，一次完成；调用方拿不到连接，漏不出来
transaction 同一个连接上执行多条，抛错即回滚
ping        往返耗时，可用于启动自检
close       等飞行中的查询结束再关池
```

`query` 的 `params` 用 `$1, $2, …` 占位，不接受字符串拼接。

## 注意

**连接数是有预算的。**

```text
总连接数 = 副本数 × maxConnections + 平台侧池
```

RDS 的 `max_connections` 是硬上限，扩容副本前先算这笔账。

**池级错误不致命。** 空闲连接被服务端断掉时会触发 `error` 事件，这里只记日志、让池换一条，不让单个网络抖动表现为进程崩溃。
