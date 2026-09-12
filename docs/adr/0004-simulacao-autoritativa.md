# ADR-0004 — Simulação autoritativa com tick fixo de 60 Hz

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
O `game-worker` já é autoritativo, o que está certo. Mas o loop é
`while True: ...; await asyncio.sleep(0.02)` — o sleep vem **depois** do trabalho, de
modo que o passo real é `0,02 s + tempo de processamento`. Sob carga, a bola anda mais
devagar. Pior: o avanço da física usa um passo constante em código
(`self.ball.x += self.ball_direction["x"]`) enquanto o intervalo de wall-clock varia,
então a velocidade percebida depende da carga da máquina. Há ainda `random.uniform`
sem semente, e o estado da partida vive num `dict` em memória do processo.

A migração para Go é a oportunidade de acertar isso, e a paridade da física é o maior
risco técnico do projeto.

## Decisão
1. **Tick fixo de 60 Hz** (16,667 ms) com `time.Ticker` e acumulador: se um tick
   atrasa, o próximo compensa; se atrasa muito, descarta com métrica em vez de
   acumular dívida.
2. **O tempo do jogo é um contador inteiro de ticks.** Nenhuma função da física
   consulta `time.Now()`.
3. **Broadcast de snapshot a 30 Hz** (a cada 2 ticks), com interpolação no cliente.
4. **Determinismo:** RNG semeado por partida, com a `seed` viajando no evento
   `match.requested`.
5. **Zero I/O no tick.** Gol, fim de jogo e placar saem como evento para fora do loop.
6. **Um dono por partida**, garantido por lease em Redis com TTL renovado.
7. **Input com número de sequência**, aplicado em ordem, duplicado descartado, último
   `seq` aplicado devolvido no snapshot.

## Consequências
**A favor.** Velocidade do jogo deixa de depender da carga da máquina. Determinismo dá
teste de golden file (gravar N ticks do Python semeado e exigir que o Go reproduza),
replay de partida e depuração reproduzível — sem isso, não há como provar que a
física foi portada corretamente. 60 Hz com 30 Hz de broadcast custa metade da banda
atual e ainda entrega movimento mais suave, porque o cliente interpola em vez de
desenhar um frame por mensagem. Lease permite mais de uma réplica do engine e
recuperação de partida órfã, ambos impossíveis hoje.

**Contra.** Interpolação no cliente é código novo que não existe no legado, e
interpolação malfeita parece pior que nada. O lease é coordenação distribuída — a
parte mais sujeita a bug sutil de todo o desenho, e exige teste de falha explícito
(matar o engine no meio de uma partida). Número de sequência no input muda o protocolo
do WebSocket, então cliente e servidor cortam juntos. E 60 Hz com passo fixo **muda o
comportamento de propósito**: a bola vai andar diferente do legado, e isso precisa ser
explicado ao time em vez de tratado como regressão.

**Rejeitado.** Manter 50 Hz com passo variável baseado em `delta`: seria "fiel" ao
legado, mas fiel a um defeito, e mata o determinismo. Predição completa no cliente:
complexidade de reconciliação desproporcional para Pong; predição só do próprio
paddle fica como etapa opcional no fim da Onda 3.
