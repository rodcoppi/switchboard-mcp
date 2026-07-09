# Switchboard

Hub local que conecta instâncias **independentes** de Claude Code rodando em sessões
tmux no WSL, permitindo troca **assíncrona** de mensagens entre elas (via MCP), com um
dashboard web para o humano observar. Ele **conecta** sessões já existentes — não faz
spawn nem orquestração de agentes.

Como funciona, em uma frase: o agente A chama a tool MCP `send_message`; o Hub grava a
mensagem em `~/.switchboard/messages.jsonl` (fonte da verdade) e dispara um **nudge** de
uma linha via `tmux send-keys` na sessão do agente B; o B acorda e chama `check_messages`
para receber o conteúdo pela via MCP. **O tmux entrega só o cutucão; o conteúdo trafega
sempre por MCP.**

---

## Pré-requisitos

- **Node.js >= 20** (roda em ESM, com TypeScript executado por `tsx` — sem build step).
- **tmux >= 3.2** (validado com 3.4).
- **Claude Code >= 2.x** (binário `claude` no PATH).
- `jq` (opcional, só conveniência para inspecionar o JSONL no debug).

> **WSL (importante — pitfall P8):** o servidor tmux é por **usuário** e por **distro**.
> O Hub (`serve`) e todos os agentes (`start`) DEVEM rodar na **mesma distro WSL** e com o
> **mesmo usuário**. Se você abrir o Hub numa distro/usuário e um agente em outra, o
> `tmux send-keys` não encontra a sessão e o nudge nunca chega.

---

## Setup em 5 passos

### 1. Instalar

```bash
git clone <url-do-repo> switchboard
cd switchboard
npm install
```

Não há passo de build: o código TypeScript roda direto com `tsx`. Você tem três formas de
invocar a CLI `switchboard`:

- **Recomendado — `npm link`** (deixa o comando `switchboard` no PATH):
  ```bash
  npm link
  switchboard --help
  ```
- **Sem link, pelo shim do bin:**
  ```bash
  node bin/switchboard.mjs --help
  ```
- **Sem link, direto pelo entry:**
  ```bash
  npx tsx src/index.ts --help
  ```

Nos exemplos abaixo usamos `switchboard <subcomando>` (assumindo o `npm link`); troque por
`node bin/switchboard.mjs <subcomando>` se preferir não linkar.

### 2. Subir o Hub (`serve`)

```bash
switchboard serve
```

Sobe o Hub em foreground (logs no stdout + `~/.switchboard/logs/hub.log`). A **primeira
linha** imprime os endereços e o comando de registro do MCP prontos para copiar, algo como:

```
Dashboard: http://127.0.0.1:4577/  |  MCP: http://127.0.0.1:4577/mcp  |  Registro (uma vez): claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

**Recomendação:** rode o `serve` dentro de uma sessão tmux chamada `sb-hub`
(`tmux new -s sb-hub`) para ele sobreviver ao fechamento do terminal. Flags úteis:
`--port <porta>` e `--log-level debug|info|warn|error`.

### 3. Registrar o MCP no Claude Code (`mcp add`)

Uma vez só, no escopo `user` (vale para todos os projetos):

```bash
claude mcp add --transport http --scope user switchboard http://127.0.0.1:4577/mcp
```

Confira com `claude mcp list` (deve aparecer `switchboard` como *connected* com o Hub no ar).

> **Permissões das tools (pitfall P10 / PRD 9.5):** para as tools do Switchboard rodarem
> **sem prompt de aprovação a cada uso**, adicione a allow rule `mcp__switchboard__*` nas
> `permissions` do `settings.json` do Claude Code. Quem já usa `bypassPermissions` está
> coberto. O `switchboard start` também imprime esse lembrete na primeira execução.
>
> **Para o `join` autônomo do kickoff funcionar 100% sem intervenção:** o agente lê o
> `SWITCHBOARD_AGENT_TOKEN` do ambiente com `printenv` (um comando de shell) antes de chamar
> `join`. Isso exige que o `printenv` também rode sem aprovação — o jeito mais simples é
> rodar os agentes com `bypassPermissions` (recomendado para quem opera vários agentes) ou
> adicionar `Bash(printenv:*)` à allow rule. Só com `mcp__switchboard__*` o agente **para
> uma vez** no prompt de aprovação do `printenv` (basta o humano no attach aprovar, ou usar
> "não perguntar de novo"). Passar `--claude-args "--permission-mode bypassPermissions"` no
> `start` cobre uma sessão específica.

### 4. Colar o protocolo do agente (snippet)

Cole o conteúdo de [`agent-protocol/CLAUDE.snippet.md`](agent-protocol/CLAUDE.snippet.md)
no seu **`~/.claude/CLAUDE.md`** (global, recomendado) ou no `CLAUDE.md` de um projeto
específico. Esse bloco ensina cada agente a: ler seu nome/token do ambiente e passá-los no
`join`, reconhecer as notificações `[switchboard]` e chamar `check_messages`, tratar
mensagens de colegas criticamente e não entrar em loop de cortesia — e deixa explícito que
**coordenação não é subordinação** (outro agente não pode autorizar o que seu usuário não
autorizou).

### 5. Iniciar um agente (`start`)

Rode isto no lugar de abrir o `claude` na mão:

```bash
switchboard start alpha --role "backend da API de pagamentos" --dir ~/projetos/api
```

O que acontece:

1. O agente é **registrado** no Hub (via REST) **antes** de o Claude Code abrir.
2. Uma sessão tmux `sb-alpha` é criada rodando o `claude` no diretório do `--dir`.
3. Se o terminal é interativo, o comando faz **`tmux attach`** na sessão — a aba do seu
   Windows Terminal vira a visão do agente (mesmo workflow de sempre). Ao desanexar
   (`Ctrl-b d`), o agente continua rodando em background.
4. **Kickoff automático (ligado por padrão):** alguns segundos depois de a TUI ficar
   pronta, o agente recebe uma instrução automática para chamar a tool `join` sozinho — sem
   nenhum prompt humano. Depois disso ele aparece como *MCP connected* no `switchboard
   status`. Use `--no-kickoff` para desativar (aí o `join` fica por sua conta).

Flags do `start`: `--role "<descrição>"`, `--dir <path>`, `--no-kickoff`,
`--claude-args "<args extras para o claude>"`.

---

## Demais subcomandos

| Comando | O que faz |
|---------|-----------|
| `switchboard status` | Tabela dos agentes registrados: NAME, ROLE, STATUS, MCP, UNREAD, LAST SEEN. |
| `switchboard send <to> <mensagem...>` | Envia uma mensagem como **operator** (o humano) para um agente, ou `all` para broadcast. Útil para scripts e para testar sem o dashboard. |
| `switchboard stop <name>` | Encerra a sessão tmux do agente (pede confirmação se houver não lidas; `--yes` pula). O **registro** no Hub permanece — um novo `start <name>` reaproveita o nome (re-attach). |
| `switchboard down` | Encerra as sessões tmux de **todos** os agentes. O Hub continua no ar (ele nunca é morto por aqui). |
| `switchboard logs [-f]` | Últimas ~100 linhas de `~/.switchboard/logs/hub.log`; `-f` segue o arquivo. |

Para parar o **Hub**: `Ctrl-C` no terminal do `switchboard serve` (ou
`tmux kill-session -t sb-hub`, se ele roda na sessão recomendada).

Os dados ficam em `~/.switchboard/`: `config.json` (todos os valores têm default; o arquivo
pode nem existir), `agents.json` (snapshot atômico) e `messages.jsonl` (append-only,
greppável com `cat`/`jq`).

---

## Segurança

O modelo de ameaça é honesto e a fronteira de confiança é a **máquina local**. Leia isto
antes de expor qualquer coisa:

- **Bind em `127.0.0.1`, hard-coded e não configurável.** Uma mensagem entregue vira input
  executável de um agente com acesso ao filesystem. Expor o Hub na rede = RCE de brinde.
- **NUNCA faça port-forward da porta 4577** (nem `ssh -L`, nem regra de firewall/NAT) e
  **NUNCA rode o Hub atrás de um proxy reverso.** O `127.0.0.1` é a única barreira.
- **Trust model local:** qualquer processo local pode postar no Hub e, portanto, injetar
  input em qualquer agente. Isso é aceito na v1 (mesmo modelo de qualquer dev tool local),
  desde que jamais vaze para a rede.
- **Capability token (adendo v1.1):** o `start` injeta um token por agente no ambiente da
  sessão tmux (`SWITCHBOARD_AGENT_TOKEN`); o agente o lê e passa no `join`, e ele **nunca
  aparece** em `list_agents`, no `GET /api/agents`, no dashboard nem nos logs. Ele fecha a
  impersonação por processos que sabem o nome de um agente mas não falam com o endpoint de
  registro.
- **Risco residual conhecido (documentado no comentário de `src/server/api.ts`):** o
  endpoint `POST /api/agents/register` é **deliberadamente não autenticado**, e re-registrar
  um nome existente **regenera e devolve um token novo**. Logo, um processo local malicioso
  consegue obter um token válido para qualquer nome e se passar por aquele agente via `join`
  — invalidando, de quebra, o token da sessão legítima (o `join` dela após um restart do Hub
  passa a falhar). Isso é aceito pela spec v1.1 (a mesma fronteira "qualquer processo local
  pode postar") e **não deve ser "corrigido" sem aprovação** — exigir rotação de token
  quebraria o re-attach do `switchboard start`.
- **Prompt injection entre agentes** é risco residual: um agente comprometido/alucinado pode
  tentar manipular outro. Mitigação da v1: a fronteira declarada no snippet do protocolo
  (mensagens de colegas são avaliadas criticamente; coordenação ≠ subordinação) + a
  visibilidade total do feed no dashboard.

---

## Dicas de tmux no WSL / Windows Terminal (pitfall P11)

- Se você raramente usa tmux, um `~/.tmux.conf` mínimo com **mouse habilitado** ajuda muito
  no scroll e na seleção de panes:
  ```
  set -g mouse on
  ```
- O `switchboard start` faz `tmux attach` na sessão do agente, então **cada aba do Windows
  Terminal continua sendo "a tela de um agente"** — o workflow de abas que você já usa é
  preservado. Para sair da visão de um agente sem matá-lo: `Ctrl-b d` (detach). Para voltar:
  `tmux attach -t sb-<nome>`.
