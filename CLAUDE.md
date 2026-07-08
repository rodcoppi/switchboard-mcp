# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é este repositório

Projeto **Switchboard**: um hub local que conecta instâncias independentes de Claude Code rodando em sessões tmux no WSL, permitindo troca assíncrona de mensagens entre elas (via MCP) com dashboard web de observação. Ele **conecta** sessões já existentes — não faz spawn nem orquestração de agentes.

**`PRD-switchboard.md` é a fonte da verdade.** Ainda não há código: a implementação segue as fases 0–7 do PRD, na ordem. Antes de trabalhar em qualquer área, leia a seção correspondente do PRD (e a tabela de pitfalls, seção 17).

## Regras do executor (do PRD, obrigatórias)

- Execute as fases NA ORDEM. Phase 0 (spikes de validação) é obrigatória e não pode ser pulada. Só avance para a Phase N+1 com todos os "Done When" da Phase N verificados de verdade (rodando o comando, não assumindo).
- Cada fase termina com um commit próprio: `feat(phase-N): <resumo>`.
- Spike da Phase 0 falhou → PARE e reporte o erro completo. Não improvise arquitetura alternativa sem aprovação.
- Não adicione dependências fora da stack travada (seção 5 do PRD). Precisa de algo? Pergunte antes.
- Não invente features fora do PRD. Divergência vira pergunta, não decisão unilateral.
- Ordem de prioridade em conflitos (seção 4): segurança local > conveniência; debugabilidade > elegância; confiabilidade de entrega > tempo real; nunca bloquear o turno do agente (toda tool MCP responde em < 1s); MVP (Phases 0–5) antes de qualquer pixel do dashboard.

## Stack travada

- Node.js >= 20 (ESM), TypeScript 5.x executado com `tsx` — **sem build step, sem bundler**.
- Produção: `@modelcontextprotocol/sdk`, `express`, `zod`, `ulid`, `commander`. Dev: `vitest`, `@types/express`, `@types/node`.
- Pré-requisitos de sistema: tmux >= 3.2, claude >= 2.x, jq (debug).
- **Proibido na v1:** websockets, banco de dados, ORM, framework de frontend, bundler, docker.

## Comandos

```bash
npx vitest run                          # todos os testes
npx vitest run test/store.test.ts      # um arquivo de teste
npx tsx src/index.ts <subcomando>      # CLI em dev (bin "switchboard" via npm link)

# CLI (subcomandos): serve | start <name> | status | send <to> <msg> | stop <name> | down | logs [-f]
# Registro do MCP no Claude Code (uma vez, escopo user):
claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

Testes de integração do dispatcher usam tmux real (skip automático se tmux ausente). O gate de cada fase são os "Done When" do PRD, não cobertura.

## Arquitetura (big picture)

Um único processo Node (o **Hub**, `127.0.0.1:4577`) serve tudo: endpoint MCP Streamable HTTP em `/mcp` (SDK oficial, modo stateful), REST + SSE em `/api/*` para dashboard e CLI, e o dashboard estático em `/`.

Fluxo de mensagem: agente A chama a tool MCP `send_message` → Hub grava em `~/.switchboard/messages.jsonl` (append-only, fonte da verdade) → dispatcher dispara **nudge** via `tmux send-keys` na sessão do destinatário (uma linha de notificação + Enter separado) → agente B acorda e chama `check_messages` para receber o conteúdo via MCP.

Divisão fundamental: **tmux entrega só o cutucão (1 linha); o conteúdo trafega sempre via MCP.** O canal frágil (teclado simulado) fica mínimo; o canal robusto (HTTP) é a fonte da verdade.

Componentes em `src/server/` (estrutura completa na seção 6 do PRD):
- `mcp.ts` — 4 tools: `join`, `send_message`, `check_messages`, `list_agents`. As descriptions das tools na seção 9 do PRD são parte da spec — copiar verbatim. Mapeamento sessão MCP → agente num `Map` em memória, criado no `join`.
- `dispatcher.ts` — cooldown por agente (15s), coalescing de nudges (rajadas viram 1 nudge), fila para mute/offline.
- `tmux.ts` — única camada que executa tmux, sempre via `execFile` (nunca `exec` com string).
- `store.ts` — `messages.jsonl` append-only + snapshot `agents.json` (write-temp + `fs.rename` atômico). Boot faz replay do JSONL; linhas corrompidas: logar e pular, nunca crashar. Marcar como lida = append de evento `{"type":"read",...}`, nunca edição in-place.

Identidade: agentes são endereçados por **nome** (nunca session id — nomes sobrevivem a restarts). O registro acontece no `switchboard start` via REST, ANTES de o Claude Code abrir; o `join` via MCP só confirma a conexão.

## Invariantes de segurança (não negociáveis)

- Bind **exclusivamente** em `127.0.0.1`, hard-coded, não configurável (mensagem entregue vira input executável de um agente — expor na rede = RCE).
- **Guarda de pane-command:** antes de qualquer `send-keys`, verificar `pane_current_command`. Se o pane roda um shell (`bash`, `zsh`, `sh`, `fish`), ABORTAR o nudge (o texto seria executado como comando). Só nudgar se roda `node`/`claude`. Teste automatizado disso é obrigatório.
- Corpo de mensagem nunca via tmux — só o cutucão. Nudge é sempre uma linha (`replace(/[\r\n]+/g, " ")`).
- `send-keys` sempre com `-l` (literal) e `--` antes do texto; Enter em comando tmux SEPARADO após delay de ~500ms (enviar junto digita mas não submete em TUIs — pitfall P1).

## Convenções

- Código e identificadores em inglês; textos voltados ao usuário (nudge, CLI help, README) em português.
- Anti-loop entre agentes: rate limit por par ordenado (12/min default), mensagens de erro das tools redigidas PARA o modelo ler e se corrigir, `maxMessageBytes` 16 KB (payload grande → arquivo + path).
- Config em `~/.switchboard/config.json`, todos os valores com default (o arquivo pode não existir).
