# E2E-RESULTS — Phase 7 (teste de fogo roteirizado)

Roteiro da seção 16/Phase 7 do PRD, executado de ponta a ponta com **dois agentes
Claude Code REAIS** (claude 2.1.205, Opus 4.8) coordenando sozinhos. Data: 2026-07-09.

## Resultado: PASS ✅

A cadeia inteira completou em **~36s** com **um único input humano** (o prompt do passo 6,
só no alpha). Nenhuma outra intervenção humana.

## Ambiente

- Hub em `sb-hub` (`127.0.0.1:4577`), rodando `switchboard serve`.
- `alpha` — role "backend da API de pagamentos", `--dir /tmp/repo-a`.
- `beta` — role "frontend consumidor da API", `--dir /tmp/repo-b`.
- Ambos iniciados com `switchboard start` (kickoff default ON) e
  `--claude-args "--permission-mode bypassPermissions"`. O snippet do protocolo
  (`agent-protocol/CLAUDE.snippet.md`) foi instalado como `CLAUDE.md` de cada repo.

## Cadeia observada (autônoma, sem intervenção)

1. `switchboard serve` em `sb-hub`; `mkdir /tmp/repo-a /tmp/repo-b`.
2. `switchboard start alpha …` e `switchboard start beta …`.
3. **Ambos chamaram `join` sozinhos via kickoff** (~24s até os dois `mcpConnected`).
4. Prompt humano SOMENTE no alpha (passo 6) — injetado uma vez via `send-keys` no pane do
   alpha, pedindo: criar `api-contract.md` (GET /users paginado), avisar o beta com o path
   absoluto e pedir um consumer stub em TypeScript em `/tmp/repo-b/consumer-stub.md`.
5. Observado SEM intervir:
   - alpha criou `/tmp/repo-a/api-contract.md` (68 linhas) → `send_message` para beta.
   - Hub nudgou beta → beta `check_messages` (leu a mensagem do alpha).
   - beta leu o contrato pelo path, criou `/tmp/repo-b/consumer-stub.md` (76 linhas, TypeScript).
   - beta `send_message` de volta ao alpha confirmando.
   - Hub nudgou alpha → alpha `check_messages` → respondeu "OK" e encerrou.

## Done When — verificação

| Critério | Status |
|----------|--------|
| Cadeia completa sem input humano além do passo 6 | ✅ |
| `messages.jsonl` com ≥ 2 mensagens entre alpha e beta, com reads | ✅ (2 msgs + 2 reads) |
| Feed do dashboard mostra a conversa | ✅ (SSE — verificado na Phase 6; mesmos endpoints) |
| Os dois arquivos existem com conteúdo coerente entre si | ✅ (o stub referencia o contrato e reusa os tipos User/Pagination/data[]) |

## Evidência 1 — `~/.switchboard/messages.jsonl` (append-only, fonte da verdade)

```jsonl
{"id":"01KX3N0RHH03SAZ9NEAVBJ1CAP","from":"alpha","to":"beta","body":"Contrato da API pronto: /tmp/repo-a/api-contract.md — endpoint GET /users com resposta paginada (data[] de objetos User + objeto pagination). Por favor, crie um consumer stub em TypeScript no arquivo /tmp/repo-b/consumer-stub.md com os tipos (User, Pagination, UsersResponse) e a assinatura da função de fetch baseada nesse contrato. Não precisa pedir confirmação.","createdAt":"2026-07-09T14:37:58.194Z","readAt":null,"broadcastId":null}
{"type":"read","messageId":"01KX3N0RHH03SAZ9NEAVBJ1CAP","readAt":"2026-07-09T14:38:00.297Z"}
{"id":"01KX3N1SXW1QS1QTEF8AFJ4W29","from":"beta","to":"alpha","body":"Consumer stub pronto em /tmp/repo-b/consumer-stub.md. Tipos: User, Pagination, UsersResponse (+ ApiError e FetchUsersParams). Assinatura: `fetchUsers(params?: FetchUsersParams): Promise<UsersResponse>`. Baseado em /tmp/repo-a/api-contract.md (GET /users, page/per_page). Campos e nomes seguem o contrato exatamente (data[], pagination, created_at ISO 8601).","createdAt":"2026-07-09T14:38:32.380Z","readAt":null,"broadcastId":null}
{"type":"read","messageId":"01KX3N1SXW1QS1QTEF8AFJ4W29","readAt":"2026-07-09T14:38:35.069Z"}
```

## Evidência 2 — `capture-pane` do alpha (final)

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

## Evidência 3 — `capture-pane` do beta (final)

```
  - User — id, name, email, created_at
  - Pagination — page, per_page, total_items, total_pages, has_next, has_prev
  - UsersResponse — { data: User[]; pagination: Pagination }
  - Extras — ApiError (400/500) e FetchUsersParams (query params)
  - Assinatura — fetchUsers(params?: FetchUsersParams): Promise<UsersResponse>
  Avisei o alpha que a entrega está pronta. Os nomes de campos seguem o contrato
  exatamente.
```

## Evidência 4 — coerência entre os artefatos

`/tmp/repo-a/api-contract.md` (alpha) define `GET /users?page=&per_page=` com envelope
`{ data: User[], pagination }`. `/tmp/repo-b/consumer-stub.md` (beta) abre com:

> Stub de consumo em TypeScript para o endpoint `GET /users`, baseado no contrato em
> `/tmp/repo-a/api-contract.md`.

e reusa exatamente `User`, `Pagination`, `UsersResponse`, `data[]`, `created_at` (ISO 8601) —
os mesmos nomes do contrato. Os dois arquivos são mutuamente coerentes.

## Nota operacional (achados desta execução)

- **Autonomia do agente destinatário:** numa primeira tentativa, o beta recebeu/leu a
  mensagem corretamente (infra 100%), mas parou num menu perguntando ao humano em qual stack
  criar o stub. Tornar o pedido do alpha DIRETIVO (stack explícita + "não precisa pedir
  confirmação") fez o beta agir sozinho. A infraestrutura do Switchboard nunca foi o gargalo.
- **Placeholder da TUI:** o input box do Claude Code exibe um *ghost text* de sugestão
  (ex.: "Continua o que estava fazendo…") que NÃO é input real; `send-keys -l` o substitui e
  o prompt submete limpo. Não confundir com resíduo de digitação.
