# E2E-RESULTS — Phase 7 (scripted fire test)

Script from PRD section 16/Phase 7, executed end to end with **two REAL Claude Code
agents** (claude 2.1.205, Opus 4.8) coordinating on their own. Date: 2026-07-09.

> **Note:** the evidence blocks below (`messages.jsonl` records and `capture-pane` output) were
> **captured before the English migration** and therefore still show the old Portuguese message
> bodies and nudge text. They are kept verbatim as historical evidence and will be regenerated
> in English on the next E2E run.

## Result: PASS ✅

The whole chain completed in **~36s** with **a single human input** (the step-6 prompt, only
on alpha). No other human intervention.

## Environment

- Hub in `sb-hub` (`127.0.0.1:4577`), running `switchboard serve`.
- `alpha` — role "payments API backend", `--dir /tmp/repo-a`.
- `beta` — role "frontend consuming the API", `--dir /tmp/repo-b`.
- Both started with `switchboard start` (kickoff default ON) and
  `--claude-args "--permission-mode bypassPermissions"`. The protocol snippet
  (`agent-protocol/CLAUDE.snippet.md`) was installed as each repo's `CLAUDE.md`.

## Observed chain (autonomous, no intervention)

1. `switchboard serve` in `sb-hub`; `mkdir /tmp/repo-a /tmp/repo-b`.
2. `switchboard start alpha …` and `switchboard start beta …`.
3. **Both called `join` on their own via kickoff** (~24s until both `mcpConnected`).
4. Human prompt ONLY on alpha (step 6) — injected once via `send-keys` into alpha's pane,
   asking to: create `api-contract.md` (paginated GET /users), notify beta with the absolute
   path and request a TypeScript consumer stub in `/tmp/repo-b/consumer-stub.md`.
5. Observed WITHOUT intervening:
   - alpha created `/tmp/repo-a/api-contract.md` (68 lines) → `send_message` to beta.
   - Hub nudged beta → beta `check_messages` (read alpha's message).
   - beta read the contract by path, created `/tmp/repo-b/consumer-stub.md` (76 lines, TypeScript).
   - beta `send_message` back to alpha confirming.
   - Hub nudged alpha → alpha `check_messages` → answered "OK" and finished.

## Done When — verification

| Criterion | Status |
|-----------|--------|
| Full chain with no human input beyond step 6 | ✅ |
| `messages.jsonl` with ≥ 2 messages between alpha and beta, with reads | ✅ (2 msgs + 2 reads) |
| Dashboard feed shows the conversation | ✅ (SSE — verified in Phase 6; same endpoints) |
| The two files exist with mutually coherent content | ✅ (the stub references the contract and reuses the User/Pagination/data[] types) |

## Evidence 1 — `~/.switchboard/messages.jsonl` (append-only, source of truth)

_Captured before the English migration; will be regenerated on the next E2E run._

```jsonl
{"id":"01KX3N0RHH03SAZ9NEAVBJ1CAP","from":"alpha","to":"beta","body":"Contrato da API pronto: /tmp/repo-a/api-contract.md — endpoint GET /users com resposta paginada (data[] de objetos User + objeto pagination). Por favor, crie um consumer stub em TypeScript no arquivo /tmp/repo-b/consumer-stub.md com os tipos (User, Pagination, UsersResponse) e a assinatura da função de fetch baseada nesse contrato. Não precisa pedir confirmação.","createdAt":"2026-07-09T14:37:58.194Z","readAt":null,"broadcastId":null}
{"type":"read","messageId":"01KX3N0RHH03SAZ9NEAVBJ1CAP","readAt":"2026-07-09T14:38:00.297Z"}
{"id":"01KX3N1SXW1QS1QTEF8AFJ4W29","from":"beta","to":"alpha","body":"Consumer stub pronto em /tmp/repo-b/consumer-stub.md. Tipos: User, Pagination, UsersResponse (+ ApiError e FetchUsersParams). Assinatura: `fetchUsers(params?: FetchUsersParams): Promise<UsersResponse>`. Baseado em /tmp/repo-a/api-contract.md (GET /users, page/per_page). Campos e nomes seguem o contrato exatamente (data[], pagination, created_at ISO 8601).","createdAt":"2026-07-09T14:38:32.380Z","readAt":null,"broadcastId":null}
{"type":"read","messageId":"01KX3N1SXW1QS1QTEF8AFJ4W29","readAt":"2026-07-09T14:38:35.069Z"}
```

## Evidence 2 — `capture-pane` of alpha (final)

_Captured before the English migration; will be regenerated on the next E2E run._

```
● Contrato criado em /tmp/repo-a/api-contract.md e mensagem enviada ao agente
  beta pedindo o consumer stub em /tmp/repo-b/consumer-stub.md. Aguardando a
  confirmação do beta.
✻ Cooked for 23s
❯ [switchboard] 1 nova(s) mensagem(ns) de: beta. Use a tool check_messages para
  ler.
  Called switchboard
● O beta confirmou que criou o consumer stub em /tmp/repo-b/consumer-stub.md.
  OK
```

## Evidence 3 — `capture-pane` of beta (final)

_Captured before the English migration; will be regenerated on the next E2E run._

```
  - User — id, name, email, created_at
  - Pagination — page, per_page, total_items, total_pages, has_next, has_prev
  - UsersResponse — { data: User[]; pagination: Pagination }
  - Extras — ApiError (400/500) e FetchUsersParams (query params)
  - Assinatura — fetchUsers(params?: FetchUsersParams): Promise<UsersResponse>
  Avisei o alpha que a entrega está pronta. Os nomes de campos seguem o contrato
  exatamente.
```

## Evidence 4 — coherence between the artifacts

`/tmp/repo-a/api-contract.md` (alpha) defines `GET /users?page=&per_page=` with the envelope
`{ data: User[], pagination }`. `/tmp/repo-b/consumer-stub.md` (beta) opens with (Portuguese,
captured before the migration):

> Stub de consumo em TypeScript para o endpoint `GET /users`, baseado no contrato em
> `/tmp/repo-a/api-contract.md`.

and reuses exactly `User`, `Pagination`, `UsersResponse`, `data[]`, `created_at` (ISO 8601) —
the same names as the contract. The two files are mutually coherent.

## Operational note (findings from this run)

- **Recipient agent autonomy:** on a first attempt, beta received/read the message correctly
  (infra 100%), but stopped at a menu asking the human which stack to create the stub in.
  Making alpha's request DIRECTIVE (explicit stack + "no need to ask for confirmation") made
  beta act on its own. Switchboard's infrastructure was never the bottleneck.
- **TUI placeholder:** Claude Code's input box shows a *ghost text* suggestion
  (e.g. "Continue what you were doing…") that is NOT real input; `send-keys -l` replaces it and
  the prompt submits cleanly. Do not confuse it with typing residue.
