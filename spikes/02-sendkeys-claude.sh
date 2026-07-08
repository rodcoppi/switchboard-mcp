#!/usr/bin/env bash
#
# spikes/02-sendkeys-claude.sh — Spike 0.3 do PRD (seção 16)
#
# Valida a técnica padrão de send-keys (PRD 10.2/10.3, pitfalls P1/P3/P5/P9)
# contra um Claude Code REAL rodando dentro do tmux:
#
#   1. Cria a sessão sb-spike1 rodando `claude` em /tmp.
#   2. Espera a TUI ficar pronta (poll, sem sleep cego), tratando o diálogo
#      de confiança que aparece ao abrir um diretório novo.
#   3. Envia um prompt com a técnica padrão: `send-keys -l --` + delay de
#      ~500ms + Enter em comando SEPARADO (pitfall P1).
#   4. Faz poll do pane até detectar a RESPOSTA do modelo (critério robusto
#      contra o falso-positivo do próprio texto digitado — ver abaixo).
#   5. Imprime os tempos observados (readiness e resposta), que alimentam o
#      NOTES.md e recalibram nudgeEnterDelayMs.
#
# ATENÇÃO: este script abre uma instância REAL de Claude Code e consome
# tokens. Só deve ser executado pelo orquestrador da Phase 0.
#
# Uso: ./02-sendkeys-claude.sh [--keep]
#   --keep  não mata a sessão ao final — necessário para o passo 4 do PRD
#           0.3 (teste manual de fila: com o Claude ocupado num turno longo,
#           disparar outro send-keys e observar o enfileiramento — P3).
#
# Dependências: bash, tmux, coreutils. Requer `claude` autenticado no PATH.
# Exit codes: 0 = PASS, 1 = FAIL, 2 = erro de uso/pré-requisito.
#
# Nota: usamos `set -u` mas NÃO `set -e`, porque os loops de poll dependem
# de comandos que falham legitimamente (captures durante redraw, etc.);
# cada erro relevante é tratado explicitamente.

set -u

SESSION="sb-spike1"
READINESS_TIMEOUT_S=60
READINESS_POLL_S=2
ANSWER_TIMEOUT_S=90
ANSWER_POLL_S=3
PROMPT="Responda apenas com a palavra PONG."

# ---------------------------------------------------------------------------
# Argumentos
# ---------------------------------------------------------------------------
KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *)
      echo "uso: $0 [--keep]" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Pré-requisitos
# ---------------------------------------------------------------------------
if ! command -v tmux >/dev/null 2>&1; then
  echo "ERRO: tmux não encontrado no PATH (pré-requisito da Phase 0.1)." >&2
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  echo "ERRO: claude não encontrado no PATH (pré-requisito da Phase 0.1)." >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { printf '%s\n' "$*"; }

# Captura o histórico recente do pane (últimas 60 linhas de scrollback,
# como especificado no PRD 0.3 passo 3).
capture_history() {
  tmux capture-pane -t "=$SESSION:" -p -S -60 2>/dev/null
}

# Captura só a área visível do pane (para detectar diálogos/readiness,
# onde o que importa é o estado ATUAL da tela, não o scrollback).
capture_visible() {
  tmux capture-pane -t "=$SESSION:" -p 2>/dev/null
}

session_alive() {
  tmux has-session -t "=$SESSION" 2>/dev/null
}

cleanup() {
  if (( KEEP )); then
    log "[keep] sessão $SESSION mantida viva para o teste manual de fila (PRD 0.3 passo 4)."
    log "[keep] observar: tmux attach -t $SESSION   |   encerrar: tmux kill-session -t $SESSION"
  else
    tmux kill-session -t "=$SESSION" 2>/dev/null || true
  fi
}

fail() {
  log "FAIL: $*"
  log "----- capture do pane (últimas 60 linhas) para debug -----"
  capture_history || log "(capture indisponível — a sessão já morreu)"
  log "-----------------------------------------------------------"
  exit 1
}

# ---------------------------------------------------------------------------
# 1. Sessão limpa: mata pré-existente e cria nova rodando `claude` em /tmp
# ---------------------------------------------------------------------------
tmux kill-session -t "=$SESSION" 2>/dev/null || true

trap cleanup EXIT

# -x/-y fixam o tamanho do pane (tmux >= 3.2): sem isso a sessão herdaria o
# default-size do tmux.conf do usuário, e uma largura pequena poderia quebrar
# o eco do prompt em duas linhas — invalidando a garantia de não-wrap em que
# o critério de detecção da resposta (passo 5) se apoia.
if ! tmux new-session -d -x 200 -y 50 -s "$SESSION" -c /tmp claude; then
  fail "não consegui criar a sessão tmux $SESSION"
fi
log "sessão $SESSION criada (claude em /tmp, pane 200x50); aguardando readiness da TUI..."

# ---------------------------------------------------------------------------
# 2. READINESS: poll a cada ${READINESS_POLL_S}s por até ${READINESS_TIMEOUT_S}s
#
# Marcador de readiness escolhido: a string "? for shortcuts".
# Por quê: o Claude Code interativo renderiza essa dica na linha de status
# logo abaixo do input box, e ela só aparece quando a TUI está de fato
# pronta para receber input — não aparece no diálogo de confiança nem em
# telas de login. É um marcador estável entre versões 1.x/2.x.
# Fallback: a string "│ >" — a linha do próprio input box (borda vertical
# U+2502 + prompt ">" ASCII). Cobre versões futuras que troquem o texto da
# linha de dicas. O diálogo de confiança usa "❯" (U+276F) como cursor de
# seleção, não ">" ASCII, então o fallback não colide com ele.
#
# Diálogo de confiança: ao abrir `claude` num diretório novo como /tmp pode
# aparecer "Do you trust the files in this folder?". Enter aceita o default
# ("Yes, proceed"). Detectamos e enviamos Enter quantas vezes o diálogo
# aparecer no capture (reenvio é inofensivo: Enter com input box vazio é
# ignorado pela TUI), e seguimos o poll.
#
# Medição de tempo: $SECONDS (builtin do bash) — nunca `date +%s` dentro de
# interpolação insegura.
# ---------------------------------------------------------------------------
readiness_start=$SECONDS
ready=0
trust_enters=0

while (( SECONDS - readiness_start < READINESS_TIMEOUT_S )); do
  if ! session_alive; then
    fail "sessão morreu durante o boot (claude saiu? verificar autenticação)"
  fi

  pane="$(capture_visible || true)"

  # Diálogo de confiança tem prioridade sobre a checagem de readiness.
  # Wordings conhecidos: "Do you trust the files in this folder?" (antigo) e
  # "Quick safety check ... Yes, I trust this folder" (claude 2.1.205).
  if [[ "${pane,,}" == *"trust the files"* || "${pane,,}" == *"trust this folder"* || "${pane,,}" == *"quick safety check"* ]]; then
    tmux send-keys -t "=$SESSION:" Enter
    trust_enters=$(( trust_enters + 1 ))
    log "diálogo de confiança detectado; Enter enviado (aceitando o default) [${trust_enters}x]"
    sleep "$READINESS_POLL_S"
    continue
  fi

  if [[ "$pane" == *"? for shortcuts"* || "$pane" == *"│ >"* ]]; then
    ready=1
    break
  fi

  sleep "$READINESS_POLL_S"
done

if (( ! ready )); then
  fail "timeout de ${READINESS_TIMEOUT_S}s aguardando a TUI ficar pronta (marcador '? for shortcuts' / '│ >' não apareceu)"
fi

readiness_elapsed=$(( SECONDS - readiness_start ))
log "TUI pronta em ${readiness_elapsed}s (diálogos de confiança tratados: ${trust_enters})"

# Pequena folga pós-render: a TUI acabou de desenhar o input box; 1s evita
# enviar keystrokes no meio de um redraw inicial.
sleep 1

# ---------------------------------------------------------------------------
# 3. Guarda de pane-command (PRD 10.3, pitfall P2 — invariante de segurança)
#
# Se o claude tivesse saído deixando um shell no pane, o send-keys abaixo
# executaria o texto como comando. Neste spike a sessão roda `claude` como
# comando direto (sem shell por baixo), mas a guarda fica como cinto de
# segurança e espelha o comportamento obrigatório do dispatcher.
# ---------------------------------------------------------------------------
pane_cmd="$(tmux list-panes -t "=$SESSION:" -F '#{pane_current_command}' 2>/dev/null || true)"
# Guarda fail-closed (PRD 10.3): se não conseguimos LER o comando do pane,
# não podemos afirmar que é seguro digitar nele — abortar, nunca prosseguir.
if [[ -z "$pane_cmd" ]]; then
  fail "não consegui verificar pane_current_command — abortando send-keys (guarda fail-closed, PRD 10.3)"
fi
case "$pane_cmd" in
  bash|zsh|sh|dash|fish)
    fail "pane roda um shell ('$pane_cmd') — abortando send-keys (P2: texto viraria comando)"
    ;;
esac
log "guarda de pane-command ok (pane_current_command='$pane_cmd')"

# ---------------------------------------------------------------------------
# 4. Envio do prompt — técnica padrão (PRD 10.2, pitfalls P1/P5/P9):
#    - `-l` (literal): tmux não interpreta o texto como nomes de tecla;
#    - `--`: blinda contra texto começando com "-";
#    - texto é uma linha única (sem \r\n — P5);
#    - Enter em comando SEPARADO após ~500ms: no mesmo comando o texto é
#      digitado mas NÃO submetido em TUIs (P1).
# ---------------------------------------------------------------------------
log "enviando prompt: \"$PROMPT\""
if ! tmux send-keys -t "=$SESSION:" -l -- "$PROMPT"; then
  fail "send-keys do texto falhou"
fi
sleep 0.5
if ! tmux send-keys -t "=$SESSION:" Enter; then
  fail "send-keys do Enter falhou"
fi
log "prompt submetido (delay texto→Enter: 500ms); aguardando resposta do modelo..."

# ---------------------------------------------------------------------------
# 5. Poll da RESPOSTA: a cada ${ANSWER_POLL_S}s por até ${ANSWER_TIMEOUT_S}s,
#    com capture-pane -S -60.
#
# Falso-positivo a evitar: o texto digitado JÁ CONTÉM "PONG" — o eco do
# prompt aparece no transcript como "> Responda apenas com a palavra PONG.",
# e o scrollback de 60 linhas pode conter FRAMES STALE da TUI Ink (input box
# pré-submit com o texto digitado, ecos duplicados após redraws), cada um
# carregando o prompt inteiro. Por isso contagem de ocorrências de "PONG" no
# capture NÃO serve como critério: frames stale duplicam o prompt e dariam
# falso PASS — inclusive mascarando exatamente o pitfall P1 (Enter que nunca
# submeteu) que este spike existe para detectar.
# Critério de sucesso (único), avaliado linha a linha:
#   linha contendo "PONG" (comparação case-insensitive, tolerando "Pong."/
#   "pong" do modelo) que NÃO contém "Responda" e que NÃO é linha de input
#   box (não começa com "│ >" nem ">"). O eco do prompt tem "Responda" e
#   "PONG" na MESMA linha: com o pane fixado em 200 colunas na criação da
#   sessão e o prompt de ~38 caracteres, não há wrap que os separe.
# ---------------------------------------------------------------------------
answer_start=$SECONDS
answered=0
criterion=""

while (( SECONDS - answer_start < ANSWER_TIMEOUT_S )); do
  if ! session_alive; then
    fail "sessão morreu enquanto aguardava a resposta"
  fi

  cap="$(capture_history || true)"

  # Linha com PONG (case-insensitive), sem "Responda", fora do input box
  # (pure bash, sem grep).
  while IFS= read -r line; do
    # Linha de input box (frame vivo ou stale pré-submit) nunca conta como
    # resposta — é onde o texto digitado mas não submetido apareceria.
    trimmed="${line#"${line%%[![:space:]]*}"}"
    if [[ "$trimmed" == "│ >"* || "$trimmed" == ">"* ]]; then
      continue
    fi
    up="${line^^}"
    if [[ "$up" == *PONG* && "$up" != *RESPONDA* ]]; then
      answered=1
      criterion="linha com PONG (case-insensitive) sem 'Responda', fora do input box"
      break
    fi
  done <<< "$cap"
  (( answered )) && break

  sleep "$ANSWER_POLL_S"
done

answer_elapsed=$(( SECONDS - answer_start ))

if (( ! answered )); then
  fail "timeout de ${ANSWER_TIMEOUT_S}s sem detectar a resposta PONG do modelo"
fi

# ---------------------------------------------------------------------------
# 6. Resultado — os tempos abaixo alimentam spikes/NOTES.md e recalibram
#    nudgeEnterDelayMs (PRD 0.3 Done When).
# ---------------------------------------------------------------------------
log ""
log "===== métricas observadas (para NOTES.md) ====="
log "readiness da TUI:            ${readiness_elapsed}s"
log "resposta do modelo (pós-Enter): ${answer_elapsed}s"
log "diálogos de confiança:       ${trust_enters}"
log "critério de detecção:        ${criterion}"
log "delay texto->Enter usado:    500ms (nudgeEnterDelayMs)"
log "==============================================="
log ""
log "PASS: send-keys entregou e submeteu o prompt; resposta PONG detectada."
exit 0
