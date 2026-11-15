# @brain/dsh-credentials-session

Per-session model-key provider. It replaces `credentials-local` when the
platform supplies each user's model key on the brain API.

## How it works

1. The platform resolves the user's key and sends it on `POST /brain/v1/sessions`
   as `x-dsh-model-key` (create and cold resume both need it).
2. `@brain/dsh-platform-api` stores the key in process memory, keyed by
   session id, and drops it on `session/disposed`.
3. `llm-deepseek` resolves its credential on every model request. This provider
   reads the current Agent from `agents.currentInitiator()`, looks up that
   session's key, and returns it.

There is no global fallback: a request from a session with no stored key throws
`credentials-session: no model key for session "<id>"`. Calls outside a turn
(model discovery at startup) report "unconfigured" instead.

## Configuration

```yaml
- id: credentials-session
  name: '@brain/dsh-credentials-session'
  config:
    ref: DEEPSEEK_API_KEY   # credential reference this provider answers
```

Disable the base `credentials` row when mounting this provider; both register
the `credentials` service.
