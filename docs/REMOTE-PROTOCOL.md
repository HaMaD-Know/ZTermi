# Remote host protocol (version 1)

Between Terminia (`src/remote/`) and the agent (`agent/lib/server.mjs`). JSON over HTTPS - or HTTP from private addresses only. Every request carries `Authorization: Bearer <token>`; responses are `application/json`, `Cache-Control: no-store`. Errors are `{ "error": "<message>" }` with the HTTP status.

| Status | Meaning |
| --- | --- |
| 400 | invalid request body |
| 401 | missing or wrong token (counts towards the lockout) |
| 403 | plain HTTP from a public address; program not in the exec allowlist; folder outside the roots |
| 404 | unknown route, session or command |
| 409 | session busy (one command at a time per session), or the session limit is reached |
| 413 | body over 256 KB or script over 200 KB |
| 429 | locked out after 5 failed sign-ins in 10 minutes |

## Endpoints

### `GET /v1/info`

```json
{ "protocol": 1, "agent": "terminia-agent", "version": "1.0.0", "hostname": "devbox",
  "platform": "win32", "powershell": { "edition": "Core", "version": "7.5.1" },
  "roots": ["C:\\src"], "exec": ["npm", "git"], "sessions": { "max": 4, "active": 1 }, "tls": true }
```

Terminia refuses an agent whose `protocol` differs from its own.

### Sessions

- `GET /v1/sessions` → `{ "sessions": [{ "id", "cwd", "busy", "createdAt", "lastUsedAt" }] }`
- `POST /v1/sessions` `{ "cwd"?: string }` → `201 { "id", "cwd", "createdAt" }`. `cwd` must be inside a root (default: the first root). One PowerShell process with one persistent runspace per session.
- `DELETE /v1/sessions/{id}` → `204`.

### Commands

- `POST /v1/sessions/{id}/commands` `{ "script": string }` → `202 { "id" }`. The script runs in the session's runspace exactly as typed at a console prompt (`Out-Default` formatting at the session width).
- `GET /v1/sessions/{id}/commands/{cid}?after=<seq>&wait=<ms>` → long poll (wait ≤ 25 000 ms); returns as soon as there is output after `seq`, or when the command finishes, or when the wait expires:

```json
{ "chunks": [{ "seq": 1, "stream": "stdout", "text": "hello\n" }],
  "done": true,
  "result": { "success": true, "exitCode": 0, "cwd": "C:\\src\\app", "durationMs": 41,
              "cancelled": false, "truncated": false, "error": null } }
```

  `stream` is one of `stdout stderr warning verbose information debug system`. `exitCode` is `$LASTEXITCODE` when a native program ran during the command, else 0/1 from PowerShell's success flag. Output beyond 8 MB per command is dropped and `truncated` is set.
- `POST /v1/sessions/{id}/commands/{cid}/cancel` → `202 {}`; stops the pipeline. The poll then finishes with `cancelled: true`.

### Completion

`POST /v1/sessions/{id}/complete` `{ "input": string (≤ 4096), "cursor": integer }` →

```json
{ "replacementIndex": 0, "replacementLength": 7, "matches": [{ "text": "Get-ChildItem", "type": "Command", "tooltip": "…" }] }
```

From PowerShell's `TabExpansion2` in the session's runspace (so it knows its variables, location and modules).

### Structured exec

`POST /v1/exec` `{ "program": "npm", "args": ["install", "left-pad"], "cwd"?: string }` → `202 { "sessionId", "commandId" }`; poll and cancel as for commands. `program` must be a bare name (`^[A-Za-z0-9._-]+$`) in the allowlist; `args` up to 100 single-line strings of ≤ 1000 characters. Runs in a transient session that is closed after it finishes.

## CORS

Only for origins listed with `--allow-origin` (used for the browser preview during development). The iPad app does not need CORS: its requests go through the native HTTP plugin.

## Agent ↔ PowerShell host

Inside the agent, each session is a `pwsh`/`powershell.exe -NoProfile -NonInteractive` process running `agent/host/terminia-host.ps1`. They talk JSON lines on stdin/stdout; replies are prefixed with `U+001E` + `TERMINIA:` so they cannot be confused with bytes a native program writes to the inherited console handle (those are reported as `stdout`):

```text
in : {"type":"run","id":..,"script":..}
     {"type":"exec","id":..,"program":..,"args":[..],"cwd":..}
     {"type":"cancel","id":..}  {"type":"complete","id":..,"input":..,"cursor":..}  {"type":"exit"}
out: {"type":"ready",..}  {"type":"out","id":..,"stream":..,"text":..}
     {"type":"done","id":..,"success":..,"exitCode":..,"cwd":..,"cancelled":..,"error":..,"durationMs":..}
     {"type":"completion","id":..,"replacementIndex":..,"replacementLength":..,"matches":[..]}
```
