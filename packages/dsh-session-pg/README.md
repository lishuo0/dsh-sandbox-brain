# @brain/dsh-session-pg

PostgreSQL 会话存储，替换随发行版的 JSONL 后端。

## 两个必须守住的属性

**一、一个写者。**

`create` 和 `open(id, 'write')` 在 `dsh_session_leases` 里抢一行，持约方每 `leaseMs / 3` 续一次。崩溃的副本没法自己释放，所以**过期是唯一的回收方式**。

```sql
INSERT INTO dsh_session_leases (session_id, owner, generation, expires_at)
VALUES ($1, $2, 1, now() + …)
ON CONFLICT (session_id) DO UPDATE
  SET owner = EXCLUDED.owner, expires_at = EXCLUDED.expires_at
WHERE dsh_session_leases.expires_at < now()
RETURNING generation
```

返回 0 行就是没抢到，抛 `SessionAlreadyOwnedError`。

**二、只追加且连续。**

`(session_id, seq)` 是主键。第二个写者会撞唯一约束——这是"双写会失败"而不是"日志悄悄坏掉"的保证。

## 写入路径

```text
循环提交事件 → session/event 通知 → 句柄缓冲（200ms 窗口）
             → 到点批量 INSERT + UPDATE next_seq/revision
             → flush 是持久性屏障，轮次边界等它
```

后台批量写失败时**保留批次**、暂停自动路径、记日志；下一次显式 flush 会重试并把错误抛给调用方。

## 配置

```yaml
- id: session-persistence
  name: '@brain/dsh-session-pg'
  config:
    leaseMs: 30000        # 租约时长；崩溃后这么久才能被接管
    heartbeatMs: 10000    # 默认 leaseMs/3
    liveBatchMs: 200      # 实时事件的批处理窗口
```

## 表结构

见 `deploy/sql/001_schema.sql`：

```text
dsh_session_headers   session_id PK, header jsonb, inherited_count, next_seq, revision
dsh_session_events    (session_id, seq) PK, event jsonb
dsh_session_leases    session_id PK, owner, generation, expires_at
```

header 存整段 jsonb 而不是拆列：它随 DSH 版本演进，拆列等于每次上游加字段都要改表。

## 崩溃恢复

后端**不修补**被中断的轮次：它返回物理上连续的前缀，丢掉撕裂的尾部。补 `turn/end { interrupted }` 是读方（agent-loop 的 resume）的职责，通过同一个写句柄追加。

## 已知限制

```text
flush 是网络往返      批量窗口缓解，但轮次边界确实会等一次
租约过期窗口          崩溃后最长 leaseMs 内该会话不可接管
版本变化              上游改 header 结构时，jsonb 里存的是旧结构，读方要兼容
```
