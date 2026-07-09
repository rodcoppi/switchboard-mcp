# NOTES — achados dos spikes da Phase 0

> **Nota (adendo v1.1 do PRD):** pesquisa de concorrentes (claude-peers-mcp, Walkie-Talkie)
> confirmou que a combinação do Switchboard não existe montada. Três ideias avaliadas do
> claude-peers-mcp: **capability token** → adotado na v1 (ver PRD 9.1/11/15); **urgency
> tiers** → v2 (PRD seção 20); **bracketed-paste no send-keys** → DESCARTADO POR DESIGN:
> ele mitiga a digitação de conteúdo arbitrário no pane, coisa que o Switchboard nunca faz
> (corpo só via MCP; o que entra no pane é um nudge de formato fixo, uma linha, com nomes
> validados por regex). Não reavaliar sem mudar essa premissa.

Arquivo exigido pelos Done When dos spikes 0.3 e 0.4 do PRD (seção 16). Registra os achados
que a implementação das Phases 1–7 precisa conhecer. Fonte da verdade continua sendo o PRD;
isto aqui é evidência de execução + gotchas de API.

## Status dos spikes

| Spike | Status | Evidência |
|-------|--------|-----------|
| 0.2 `01-sendkeys-basic.sh` | **PASS** (3/3 execuções, tmux 3.4) — 2026-07-08 | seção abaixo |
| 0.3 `02-sendkeys-claude.sh` | **PASS** (PONG + teste de fila com evidência de captura) — 2026-07-08 | seção abaixo |
| 0.4 `03-mcp-http/` | **PASS** — Done When executado de verdade com Claude Code real em 2026-07-08 | seção abaixo |

**Gate da Phase 0: FECHADO (0.2 ✅ 0.3 ✅ 0.4 ✅).**

### Ambiente (0.1)

Node v24.7.0 · claude 2.1.205 · **tmux 3.4** · jq 1.7.1 · portas 4577/4578 livres · WSL2
(kernel 6.6.87.2-microsoft-standard-WSL2), Ubuntu 24.04 noble.

Nota de instalação: tmux e jq foram instalados **sem sudo** a partir dos `.deb` oficiais do
Ubuntu (`apt-get download` + `dpkg -x`) em `~/.local/opt/switchboard-tools/`, com wrappers em
`~/.local/bin/{tmux,jq}` que setam `LD_LIBRARY_PATH`. Funcionalmente idêntico ao pacote do
sistema (tmux roda 100% em user-space). Para trocar pela instalação de sistema depois:
`sudo apt install tmux jq` e apagar os dois wrappers + `~/.local/opt/switchboard-tools/`.

## Spike 0.2 — send-keys básico (2026-07-08)

`./spikes/01-sendkeys-basic.sh` → **PASS 3/3**: `PASS (tmux 3.4; linha submetida apareceu 2x
no pane)`. Técnica validada: texto com `send-keys -l --`, ~500 ms, Enter em comando separado.

**Achado crítico para o `tmux.ts` (Phase 3) — sintaxe de target com match exato:**

- Em comandos de **target-session** (`has-session`, `kill-session`): `-t "=NOME"` funciona.
- Em comandos de **target-pane/window** (`send-keys`, `capture-pane`, `list-panes`):
  `-t "=NOME"` **falha** com `can't find pane: =NOME` (tmux 3.4, sessão viva!). A forma
  correta é **`-t "=NOME:"`** (dois-pontos qualificando `sessão:janela`).

Esse detalhe custou o primeiro FAIL do spike (a sessão nunca morreu; o target é que não
resolvia). Sem o `=`, o tmux resolve por prefixo e um `kill-session -t sb-alpha` poderia
matar `sb-alpha-outra` — usar sempre `=` + `:` conforme o tipo de comando.

## Spike 0.3 — send-keys no Claude Code real (2026-07-08)

`./spikes/02-sendkeys-claude.sh` → **PASS**. Métricas observadas (pane 200x50, `claude` em
`/tmp`):

- Readiness da TUI: **4 s** (incluindo 1 diálogo de confiança tratado com Enter).
- Resposta do modelo pós-Enter: **3 s** (detecção anti-falso-positivo: linha com PONG sem
  "Responda", fora do input box, case-insensitive).
- Delay texto→Enter de **500 ms funcionou de forma confiável em todas as execuções**
  (spikes 0.2 3x, 0.3 e teste de fila 2x) → **`nudgeEnterDelayMs: 500` do PRD confirmado,
  sem recalibração**.

**Diálogo de confiança (wording do claude 2.1.205):** ao abrir num diretório novo, o texto é
"Quick safety check: Is this a project you created or one you trust?" com opção
"❯ 1. Yes, I trust this folder" — NÃO contém mais a frase antiga "Do you trust the files in
this folder?". Detectar por `trust this folder` / `quick safety check` (case-insensitive).
Enter aceita o default. **Consequência para a Phase 4 (`switchboard start` + kickoff):** num
`--dir` nunca antes confiado, a TUI fica parada no diálogo; um kickoff cego após 8 s
digitaria texto num MENU (dígitos selecionam opções!). O kickoff deve verificar readiness da
TUI (ou o humano aceita o diálogo no attach — o `start` com attach deixa o humano na frente
da tela, o que mitiga na prática).

**Teste de fila (P3, passo 4 do 0.3) — PASS com evidência de captura.** Metodologia: prompt 1
"Conte de 1 até 50, um número por linha, devagar" submetido; em t+4 s (contagem em 7/50,
turno claramente ativo, spinner rodando) um segundo send-keys entregou "Quando terminar de
contar, escreva apenas FILA-OK." + Enter separado. Capturas:

1. **Meio do turno** (t=7 s): transcript mostra `● 1 … 7` em streaming — turno 1 ativo no
   instante da injeção.
2. **Final** (t=15 s): contagem completa até 50, marcador de fim de turno, e SÓ ENTÃO o eco
   `❯ Quando terminar de contar, escreva apenas FILA-OK.` seguido de `● FILA-OK`.

Conclusão: input digitado durante turno ativo **entra na fila e é processado ao fim do
turno, sem quebrar a TUI** — exatamente o comportamento que o dispatcher assume (P3 não é
erro). Nenhuma perda de input observada.

## Spike 0.4 — execução do Done When (2026-07-08)

Ambiente: Node v24.7.0, claude 2.1.205, `@modelcontextprotocol/sdk` 1.29.0, WSL2.

Roteiro do PRD 0.4 executado na íntegra (não apenas curl):

1. Servidor no ar em `127.0.0.1:4578/mcp`.
2. `claude mcp add --transport http --scope local spike http://127.0.0.1:4578/mcp` → `claude mcp list` mostrou `✔ Connected`.
3. + 4. **Dois `claude -p` SIMULTÂNEOS** ("Use the ping tool from the spike MCP server and
   report its output."), lançados em background no mesmo instante. Resultado: **ambos
   receberam `pong`** (exit 0 nos dois) e o log do servidor mostrou **duas sessões distintas**
   (`10796b54-…` e `64d7b75e-…`) com pings a ~0,8 s de distância (22:47:31.626Z e 22:47:32.388Z).
   Risco R2 (múltiplas sessões Claude Code no mesmo servidor stateful) eliminado.
5. **Teste de restart com cliente real** (P6): sem TTY disponível, o "claude interativo" foi
   aproximado por um `claude -p` mantido vivo durante o restart — o turno foi segurado com um
   comando Bash bloqueante de 30 s (`node -e "setTimeout(()=>{},30000)"`) entre dois pings; o
   servidor foi morto e reerguido dentro dessa janela. É a MESMA pilha de cliente MCP HTTP do
   modo interativo. Comportamento observado (log do servidor):

   ```
   [spike] session initialized: 621ff6e5-…          # ping 1 ok (servidor antigo)
   [spike] MCP Streamable HTTP … escutando …        # restart
   [spike] unknown session id rejected (404): 621ff6e5-…
   [spike] session initialized: 0dd64b5d-…          # cliente RE-INICIALIZOU sozinho
   [spike] ping called …                            # ping 2 ok, sessão nova
   ```

   **Achado central do P6: o cliente MCP do Claude Code 2.1.205 se recupera sozinho do 404
   `Session not found` — re-inicializa a sessão (novo `initialize`, novo session id) e
   re-executa a tool call, de forma totalmente transparente para o modelo** (o relatório do
   agente disse "nenhum erro ocorreu"; ambos os pings retornaram `pong`).
6. `claude mcp remove spike` executado (config limpa).

Smoke test via curl também verde: `initialize` (retorna `mcp-session-id` no header) →
`notifications/initialized` (HTTP 202) → `tools/call ping` (`data: {"result":{"content":
[{"type":"text","text":"pong"}]…}`); session id desconhecido → 404 JSON `-32001`; body JSON
malformado → 400 JSON `-32700` (ver achado 5).

### Consequência do achado P6 para a Phase 2 (mcp.ts)

A reconexão é transparente para o MODELO, mas **não para o Hub**: a sessão nova chega sem
nenhum vínculo com o agente. Como o Map sessão→agente vive em memória, após restart do Hub
toda tool chamada numa sessão não mapeada (o cliente re-inicializa sozinho e segue chamando
tools) deve responder com erro redigido para o modelo se corrigir: "você não está registrado
nesta sessão; chame a tool join novamente". O replay do JSONL + `agents.json` recupera o
resto do estado. Não contar com o cliente "avisar" que reconectou — ele não avisa.

## Achados de API do SDK (@modelcontextprotocol/sdk 1.29.0)

1. **Versão e imports corretos (v1.x, NÃO v2-alpha).** A doc do context7 mistura exemplos da
   v2-alpha, cujos caminhos não existem na 1.x. Os imports certos na 1.29.0 são:

   ```ts
   import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
   import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
   import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
   ```

   O subpath `server/streamableHttp.js` só existe a partir de ~1.10; `registerTool` e
   `onsessionclosed` são posteriores a 1.0. Por isso o `package.json` do spike pina
   `"^1.29.0"` — um range `^1.0.0` aceitaria versões onde o import crasha
   (`ERR_PACKAGE_PATH_NOT_EXPORTED`). Manter o range apertado na Phase 2 e **commitar o
   `package-lock.json`** quando o repo git for iniciado.

2. **`server.registerTool(name, config, handler)` é a API atual; `server.tool()` está
   deprecated.** Usar `registerTool` com `{ description, inputSchema }` (zod cru como shape,
   sem `z.object()` em volta) na Phase 2.

3. **Padrão stateful do handler HTTP + gotcha do `req.body`:** com `express.json()` no
   pipeline, o stream já foi consumido; é OBRIGATÓRIO passar o body parseado como 3º
   argumento — `transport.handleRequest(req, res, req.body)`. Esquecer o 3º arg faz o
   transport tentar reler o stream e a request pendura/falha. Um transport (+ um `McpServer`)
   por sessão, reusado via header `mcp-session-id`; sessão nova só quando
   `isInitializeRequest(req.body)` e sem session id; session id desconhecido → 404 JSON-RPC
   `-32001` (o cliente re-inicializa — ver P6 acima).

4. **Ciclo de vida de sessão é incompleto por design: `onclose`/`onsessionclosed` NÃO cobrem
   morte abrupta do cliente.** Verificado ao vivo: DELETE explícito dispara
   `onsessionclosed` + `onclose` e limpa o Map (reusar o SID depois → 404). Mas cliente que
   morre sem DELETE não dispara NADA — na execução do Done When, as sessões dos `claude -p`
   e do curl ficaram órfãs no Map até o fim do processo (nenhuma linha `transport closed` no
   log). **Phase 2: obrigatório expirar sessões por inatividade** (timestamp do último
   request por sessão + sweep periódico) e/ou reconciliar via re-join; senão o Hub acumula
   transports órfãos e agentes "fantasma" seguem listados como conectados.

5. **Body JSON malformado estoura ANTES do handler.** O erro do `express.json()` acontece no
   middleware, fora do alcance do try/catch do handler; sem tratamento, o Express devolve
   página de erro HTML (fora do envelope JSON-RPC) e loga stack trace de 10 linhas por typo
   de cliente. Corrigido no spike com error-middleware de 4 argumentos após as rotas
   respondendo `{jsonrpc:"2.0", error:{code:-32700, message:"Parse error"}, id:null}` com
   status 400 (verificado por curl com body `{invalid`). **Obrigatório na Phase 2** — o
   `api.ts` exige erros sempre em JSON, e stack trace de parse mascara erro real no log
   (debugabilidade > elegância).
