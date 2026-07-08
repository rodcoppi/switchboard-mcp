# Spike 0.4 — MCP Streamable HTTP (stateful)

Mini servidor MCP do PRD (seção 16, item 0.4): 1 tool `ping` que retorna `pong`, servida via
`StreamableHTTPServerTransport` em `http://127.0.0.1:4578/mcp`, modo stateful (uma sessão MCP
por instância de Claude Code). Prova o risco R2: múltiplas sessões Claude Code no mesmo servidor.

## Subir o servidor

```bash
cd spikes/03-mcp-http
npm install        # primeira vez
npx tsx server.ts  # loga cada sessão iniciada/encerrada e cada ping
```

## Roteiro de teste (PRD 0.4)

1. Com o servidor rodando, registrar o MCP no escopo local:

   ```bash
   claude mcp add --transport http --scope local spike http://127.0.0.1:4578/mcp
   ```

2. Primeira instância:

   ```bash
   claude -p "Use the ping tool from the spike MCP server and report its output."
   ```

3. Repetir o passo 2 numa SEGUNDA instância SIMULTÂNEA (outro terminal) — duas sessões MCP
   no mesmo servidor. As duas devem receber `pong`; o log do servidor deve mostrar dois
   `session initialized` distintos.

4. Teste de restart: com um `claude` interativo conectado, matar o servidor (Ctrl+C), subir
   de novo (`npx tsx server.ts`) e pedir o ping outra vez. Observar a recuperação: o session
   id antigo leva 404 `Session not found` e o cliente deve re-inicializar. Documentar o
   comportamento observado em `spikes/NOTES.md` (pitfall P6 do PRD).

5. Limpeza:

   ```bash
   claude mcp remove spike
   ```

**Done When:** as duas instâncias recebem `pong`; comportamento pós-restart documentado em NOTES.md.

## Status da execução — PASS (2026-07-08, roteiro real, não só curl)

Executado com claude 2.1.205 + SDK 1.29.0 (evidências e achados completos em
[`../NOTES.md`](../NOTES.md)):

- Passos 1–3 e 4: `claude mcp add` conectou (`✔ Connected`); **dois `claude -p` simultâneos
  receberam `pong`**, com **dois `session initialized` distintos** no log do servidor
  (pings a ~0,8 s de distância). Risco R2 provado.
- Passo 4 do roteiro acima (restart, P6): executado com um cliente Claude Code real mantido
  vivo durante o restart (aproximação headless do "claude interativo": turno segurado por um
  comando Bash bloqueante de 30 s entre dois pings — mesma pilha de cliente MCP HTTP).
  Observado: session id antigo → 404 `Session not found` → **o cliente re-inicializa sozinho
  e re-executa a tool call, transparente para o modelo** (segundo ping retornou `pong`).
- Passo 5: `claude mcp remove spike` executado.

Este PASS fecha apenas o spike 0.4. O **gate da Phase 0 segue ABERTO**: os spikes 0.2 e 0.3
(`01-sendkeys-basic.sh`, `02-sendkeys-claude.sh`) dependem de tmux, ausente no ambiente atual
— status rastreado em `../NOTES.md`.

## Smoke test sem Claude Code (curl)

```bash
# initialize (a resposta traz o header mcp-session-id)
curl -sS -D - -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}' \
  http://127.0.0.1:4578/mcp

# depois, com SID=<mcp-session-id retornado>:
#   notifications/initialized  -> HTTP 202
#   tools/call ping            -> data: {"result":{"content":[{"type":"text","text":"pong"}]},...}
curl -sS -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' http://127.0.0.1:4578/mcp
curl -sS -H "Accept: application/json, text/event-stream" -H "Content-Type: application/json" -H "mcp-session-id: $SID" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"ping","arguments":{}}}' http://127.0.0.1:4578/mcp
```
