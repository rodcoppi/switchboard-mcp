#!/usr/bin/env bash
#
# spikes/01-sendkeys-basic.sh — Phase 0, item 0.2 do PRD (spike send-keys básico)
#
# Valida a técnica padrão de nudge do Switchboard (PRD 10.2/10.3):
#   1. texto enviado com `tmux send-keys -l --` (-l = literal, senão tmux
#      interpreta nomes de tecla; -- blinda contra texto começando com "-")
#   2. delay de ~500ms
#   3. Enter em comando tmux SEPARADO
#
# ESCOPO (importante para o NOTES.md): este spike valida APENAS a entrega de
# input via send-keys num pane rodando `cat`. Como o pty do `cat` está em modo
# canônico, a linha submeteria no newline mesmo se texto+Enter fossem enviados
# no MESMO send-keys — ou seja, o modo de falha do pitfall P1 (PRD seção 17)
# NÃO é reproduzível nem descartável aqui: ele só se manifesta em TUIs
# raw-mode e é validado no spike 02, com Claude Code real. A sequência de
# envio (texto -l, ~500ms, Enter separado) é usada aqui apenas para exercitar
# a MESMA técnica que o dispatcher usará. Um PASS aqui não diz nada sobre P1.
#
# Critério de PASS: o pane roda `cat`. Uma linha SUBMETIDA aparece DUAS vezes
# no capture-pane: uma pelo eco do tty (o que foi digitado) e outra pelo output
# do próprio cat (que só ecoa a linha DEPOIS que o Enter a submete). Portanto:
#   - contagem >= 2  → Enter entregue e linha submetida → PASS
#   - contagem == 1  → Enter NÃO foi entregue/processado (falha de delivery,
#                      ex.: target/pane errado — NÃO é o P1; ver ESCOPO) → FAIL
#   - contagem == 0  → send-keys não entregou nada → FAIL
#
# Alvos tmux sempre com prefixo `=` (match EXATO de nome de sessão): sem ele,
# o tmux resolve targets por PREFIXO quando não há nome exato, e o kill-session
# poderia matar uma sessão de trabalho do usuário chamada, p.ex., "sb-spike01".
# ATENÇÃO (achado empírico, tmux 3.4): em comandos de target-PANE (send-keys,
# capture-pane), "=NOME" sozinho falha com "can't find pane"; a forma correta
# de match exato é "=NOME:" (com dois-pontos, qualificando como sessão:janela).
# Em comandos de target-SESSION (has-session, kill-session), "=NOME" funciona.
#
# Somente bash + tmux + coreutils. Sem `set -e`: has-session e grep têm
# exit != 0 esperado; falhas críticas são tratadas explicitamente com fail().

set -u

SESSION="sb-spike0"
TEXT="hello switchboard"

cleanup() {
  # SEMPRE mata a sessão do spike, inclusive em falha ou interrupção.
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "FAIL: $1"
  if [ -n "${2-}" ]; then
    echo "---- capture-pane (debug) ----"
    printf '%s\n' "$2"
    echo "------------------------------"
  fi
  exit 1
}

command -v tmux >/dev/null 2>&1 \
  || fail "tmux não encontrado no PATH (pré-requisito: tmux >= 3.2)" ""

# Versão mínima exigida pelo PRD (item 0.1 / seção 5): tmux >= 3.2. Um PASS
# em tmux mais antigo mascararia um ambiente fora da spec.
TMUX_VERSION_RAW="$(tmux -V 2>/dev/null || true)"
TMUX_VERSION_NUM="$(printf '%s\n' "$TMUX_VERSION_RAW" | grep -oE '[0-9]+\.[0-9]+' | head -n 1 || true)"
if [ -z "$TMUX_VERSION_NUM" ]; then
  echo "AVISO: não foi possível parsear a versão do tmux ('$TMUX_VERSION_RAW');" \
       "prosseguindo, mas confirme manualmente que é >= 3.2 (PRD seção 5)."
else
  TMUX_MAJOR="${TMUX_VERSION_NUM%%.*}"
  TMUX_MINOR="${TMUX_VERSION_NUM#*.}"
  if [ "$TMUX_MAJOR" -lt 3 ] || { [ "$TMUX_MAJOR" -eq 3 ] && [ "$TMUX_MINOR" -lt 2 ]; }; then
    fail "versão do tmux fora da spec: '$TMUX_VERSION_RAW' (PRD exige >= 3.2)" ""
  fi
fi

# Mata sessão pré-existente com o mesmo nome (exit != 0 de has-session é
# esperado quando ela não existe — por isso fica fora de qualquer set -e).
# `=` força match exato: nunca matar sessão alheia por prefixo.
if tmux has-session -t "=$SESSION" 2>/dev/null; then
  tmux kill-session -t "=$SESSION" 2>/dev/null || true
fi

# Sessão destacada rodando `cat`: cada linha submetida volta ecoada pelo cat.
tmux new-session -d -s "$SESSION" cat \
  || fail "não foi possível criar a sessão tmux '$SESSION'" ""

# Pequena folga para o pane e o cat estarem prontos antes do send-keys.
sleep 0.3

# 1) Texto literal, com -l e -- obrigatórios (PRD 10.3).
tmux send-keys -t "=$SESSION:" -l -- "$TEXT" \
  || fail "send-keys do texto falhou" ""

# 2) Delay ~500ms e Enter em comando SEPARADO (mesma técnica do dispatcher).
sleep 0.5
tmux send-keys -t "=$SESSION:" Enter \
  || fail "send-keys do Enter falhou" ""

# 3) Poll do pane: captura a cada 0.2s por até ~5s, saindo assim que a linha
#    submetida aparecer >= 2x. Um sleep fixo + captura única gera falso-negativo
#    sob carga no WSL2 (eco do cat ainda não visível no instante da captura).
#    grep -c sai com exit 1 quando a contagem é 0 — resultado válido, daí `|| true`.
PANE_OUTPUT=""
COUNT=0
MAX_POLLS=25   # 25 x 0.2s = ~5s
i=0
while [ "$i" -lt "$MAX_POLLS" ]; do
  sleep 0.2
  if ! PANE_OUTPUT="$(tmux capture-pane -t "=$SESSION:" -p)"; then
    fail "capture-pane falhou" ""
  fi
  COUNT="$(printf '%s\n' "$PANE_OUTPUT" | grep -c -F -- "$TEXT" || true)"
  if [ "$COUNT" -ge 2 ]; then
    break
  fi
  i=$((i + 1))
done

if [ "$COUNT" -ge 2 ]; then
  echo "PASS (${TMUX_VERSION_RAW:-versão do tmux desconhecida}; linha submetida apareceu ${COUNT}x no pane)"
  exit 0
elif [ "$COUNT" -eq 1 ]; then
  fail "texto apareceu 1x após ~5s: Enter não foi entregue/processado (falha de delivery — NÃO é o pitfall P1; P1 só é testável em TUI raw-mode, no spike 02 com Claude Code real)" "$PANE_OUTPUT"
else
  fail "texto não apareceu no pane: send-keys não entregou nada" "$PANE_OUTPUT"
fi
