---
name: port-game-loop
description: Porta a simulação de Pong do worker Python (Game-Core games_worker) para Go, com física determinística, tick fixo de 60 Hz e prova de paridade por golden file. Use ao trabalhar em internal/domain/pong ou no game-engine.
---

# Portar a simulação do jogo

A parte de maior risco da migração. A física do legado **funciona** — é a
especificação. Mas está envolvida em defeitos que não devem ser portados. A regra é:
**preservar a física, corrigir o loop**, e provar a paridade com golden file.

Referência: `legacy/Game-Core/src/games_worker/` e
[ADR-0004](../../../docs/adr/0004-simulacao-autoritativa.md).

## 1. Preservar × corrigir

| Preservar (é a especificação) | Corrigir de propósito (é defeito) |
| --- | --- |
| geometria: campo 90×80; paddle 2×16; bola raio 2 | tick que desliza (`sleep(0.02)` depois do trabalho) → ticker fixo de 60 Hz |
| velocidade do paddle 4/tick; bola 0,4–0,7 por eixo | RNG avaliado na importação → semente por partida, vinda de `match.requested` |
| reflexão em parede e em paddle | query de banco no loop → evento para fora do loop |
| colisão de canto por distância euclidiana (`max_distance_ball_player`) | `while True` sem cancelamento → `select` com `ctx.Done()` |
| reposicionamento da bola ao colidir de frente | estado em `dict` de processo → estado com dono e lease |
| reset no centro com pausa de 3 s | 50 Hz de broadcast → 30 Hz com interpolação no cliente |
| 5 pontos para ganhar | `playerColor` herdando de `enumerate` e pulando o 2 → slot 0..3 |
| gol sem último toque pontua todos os outros | placar em todo snapshot → `GameEvent` |
| IA do bot: extrapola a trajetória, jitter ±5, reage a cada 0,15 s | timeout de 180 s sem evento → `game.aborted` explícito |

**60 Hz com passo fixo muda o comportamento de propósito**: a bola vai andar diferente
do legado. Isso não é regressão, é a correção — e precisa estar claro para o time.
Para a velocidade percebida ficar equivalente, escale o deslocamento por tick:
`speed_legacy * 50/60`. Documente a escolha no código.

## 2. Domínio puro primeiro

```go
// internal/domain/pong/game.go
type Game struct {
    Tick    uint32
    Ball    Ball
    Paddles [4]Paddle
    Scores  [4]uint8
    Status  Status
    rng     *rand.Rand   // semeado por partida
    // ...
}

// Step avança exatamente um tick. Determinístico, sem I/O, sem goroutine.
// Devolve os eventos gerados neste tick (gol, fim), para o chamador publicar.
func (g *Game) Step(inputs [4]int8) []Event
```

Regras não negociáveis:
- `Step` não faz I/O, não loga, não chama `time.Now()`, não aloca em laço quente.
- O tempo é `g.Tick`, inteiro. Pausa de 3 s é `g.pauseUntilTick = g.Tick + 180`.
- Ordem de operações em `float64` **fixa**. Mudar a ordem muda o resultado no último
  bit e quebra o golden file.
- Toda aleatoriedade sai de `g.rng`. Nenhum `rand.Float64()` global.

O bot é uma função pura: `func BotInput(g *Game, slot int) int8`. Ele lê o estado e
devolve direção — não é uma goroutine com `sleep`, como no legado.

## 3. Golden file — a única prova aceitável

Sem isto, não há como afirmar que a física foi portada.

**Passo A — instrumentar o Python.** Num branch descartável, adicione uma semente a
`GameConfig` e um dump por tick:

```python
# script de captura, fora do container
random.seed(seed)
session = GameSession(players, "golden", "room", room_type)
for _ in range(n_ticks):
    await session.update_ball_position()
    print(json.dumps({"tick": t, "ball": session.ball.to_dict(),
                      "players": {p.color: p.to_dict() for p in session.players.values()},
                      "scores": ..., "status": session.game_status}))
```

Grave em `services/game/testdata/golden/<cenario>.jsonl`.

**Passo B — cenários a capturar.** No mínimo:

| Cenário | Por que |
| --- | --- |
| `2p-sem-input` | trajetória livre e reflexão em parede |
| `2p-input-fixo` | colisão de paddle repetida |
| `2p-canto` | a lógica de distância euclidiana, a mais sutil |
| `2p-gol-sem-toque` | o ramo que pontua todos os outros |
| `2p-partida-completa` | até 5 pontos, com resets |
| `1p-bot` | IA determinística |

**Passo C — teste no Go.**

```go
func TestGoldenParity(t *testing.T) {
    for _, name := range scenarios {
        golden := loadGolden(t, name)
        g := pong.New(golden.Config, golden.Seed)
        for _, want := range golden.Frames {
            g.Step(want.Inputs)
            requireClose(t, want.Ball.X, g.Ball.X, 1e-6)
            // ... paddles, scores, status
        }
    }
}
```

Tolerância `1e-6` por tick. Se divergir, a causa é quase sempre **ordem de operações**
ou **ordem de iteração** — `self.players.values()` em Python é ordem de inserção; em Go
use o array indexado por slot, nunca `map`.

## 4. O loop, fora do domínio

```go
func (r *Runner) Run(ctx context.Context) error {
    ticker := time.NewTicker(TickDuration)  // 16.667ms
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            if !r.lease.Valid() { return ErrLeaseLost }
            inputs := r.drainInputs()            // não bloqueante
            events := r.game.Step(inputs)        // puro
            if r.game.Tick%SnapshotEvery == 0 { r.broadcast() }
            r.emit(events)                       // canal, não I/O direto
        }
    }
}
```

- **Lease:** `SET game:{id}:owner <instance> NX PX 5000`, renovado a cada ~1 s. Perder
  o lease encerra o runner. Sem lease, não simula.
- **Input:** chega do `game-api` por NATS core, com `seq`. Descarte `seq` menor ou
  igual ao último aplicado; guarde o maior para devolver como `last_ack_seq`.
- **Se um tick atrasa**, compense no próximo; se atrasar muito, descarte com métrica.
  Nunca acumule dívida de tick.

## 5. Teste de falha (obrigatório)

Matar o `game-engine` no meio de uma partida e verificar que outra réplica retoma pelo
lease expirado. Este teste existe porque o lease é a parte mais sujeita a bug sutil de
todo o desenho. Rode com uma única réplica até ele passar.

## Critérios de aceite

- [ ] `internal/domain/pong` sem import de infra, sem goroutine, sem `time.Now()`
- [ ] golden file dos 8 cenários, todos passando com tolerância `1e-6`
- [ ] `go test -race` limpo
- [ ] nenhuma query de banco no caminho de `Step`
- [ ] tick fixo com compensação e métrica de p99 de duração do tick
- [ ] lease adquirido, renovado e liberado no shutdown
- [ ] teste de retomada de partida órfã passa
- [ ] input duplicado descartado; `last_ack_seq` devolvido no snapshot
- [ ] cada divergência intencional documentada no código e no PR
