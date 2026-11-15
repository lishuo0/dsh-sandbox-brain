# @brain/dsh-web-limiter

Per-user and global concurrency limit for `web_fetch`, implemented as a
`tools/execute` wrapper. It exists because `web_fetch` runs on the brain and
shares its memory, CPU, and egress across tenants.

## Configuration

```yaml
- id: web-limiter
  name: '@brain/dsh-web-limiter'
  config:
    maxGlobal: 4     # concurrent web_fetch calls across the deployment
    maxPerUser: 2    # concurrent calls per user (per session without a directory)
    maxQueue: 32     # waiting calls before new calls fail fast
    queueMs: 10000   # maximum wait before failing
    tools: [web_fetch]
```

`maxGlobal`, `maxPerUser`, `maxQueue`, and `queueMs` must be positive safe
integers; `tools` defaults to `["web_fetch"]`.

## Behaviour

- A call takes a slot immediately when both caps allow it.
- Otherwise it waits FIFO for up to `queueMs`. A waiter whose user is at its cap
  is skipped so other users can proceed; it stays queued until its user frees a
  slot or its deadline passes.
- Timeout, abort, a full queue, or a closed limiter produce an error result with
  `error.info.code = "WEB_FETCH_BUSY"` — the call never reaches the network.
- The limit key is `userId` when `sessionDirectory` is mounted, otherwise the
  session id.
- Other tools pass through unchanged.

## What it does not fix

The brain's egress IP is still shared, and the response body still lives in the
brain process during the call (bounded by `web-fetch-http` caps). True tenant
isolation needs a sandbox-side fetch or a controlled egress proxy.
