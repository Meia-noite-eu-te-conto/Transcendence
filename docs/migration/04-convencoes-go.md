# 04 — Convenções Go

Regras para todo serviço em `services/`. O objetivo não é estilo: é impedir que os
problemas do legado (§4 da [análise](01-analise-atual.md)) se reproduzam em Go.

## 1. Versão e módulos

Go 1.23+. Um módulo por serviço mais um para o compartilhado:

```
services/lobby/go.mod      → module github.com/Meia-noite-eu-te-conto/transcendence/services/lobby
libs/go/go.mod             → .../libs/go
```

Módulos separados, não um único módulo na raiz: o CI constrói e testa só o que mudou,
e nenhum serviço herda dependência de outro por acidente. `go.work` na raiz para o
desenvolvimento local.

## 2. Layout

```
services/lobby/
  cmd/lobby/main.go              # só wiring: config, deps, start, shutdown
  internal/
    domain/                      # regra pura. ZERO import de infra.
      room.go  room_test.go
      tournament.go  tournament_test.go
      errors.go                  # sentinelas
    app/                         # casos de uso, orquestra domínio + portas
      create_room.go
      join_room.go
      ports.go                   # interfaces que o app precisa (definidas AQUI)
    adapter/
      http/                      # handlers, roteador, middleware, DTO
      postgres/                  # sqlc gerado + implementações de repositório
      nats/                      # publisher e consumidores
      redis/
    config/config.go             # env → struct, validado no boot
  migrations/                    # goose
  queries/                       # .sql do sqlc
  sqlc.yaml
  Dockerfile
```

**A dependência aponta para dentro:** `adapter` → `app` → `domain`. `domain` não
importa nada do projeto. `app` define as interfaces que consome (`ports.go`) e
`adapter` as implementa — quem precisa da abstração é quem a declara.

O teste disso é mecânico: se `internal/domain` importa `pgx`, `nats` ou
`net/http`, está errado.

## 3. Bibliotecas

| Necessidade | Escolha | Por quê |
| --- | --- | --- |
| Roteador HTTP | `github.com/go-chi/chi/v5` | grupos e middleware sem framework; `net/http` puro serviria, chi poupa boilerplate de middleware |
| Postgres | `github.com/jackc/pgx/v5` (pool) | driver nativo, sem `database/sql` no caminho |
| SQL | `sqlc` | **sem ORM**, de propósito: o hábito de ORM é o que pôs query dentro do loop de 50 Hz |
| Migrations | `github.com/pressly/goose/v3` | versionado em SQL, roda como comando ou embutido |
| NATS | `github.com/nats-io/nats.go` (+ jetstream) | oficial |
| Redis | `github.com/redis/go-redis/v9` | oficial |
| WebSocket | `github.com/coder/websocket` | API ciente de `context`, sem pool global; `gorilla/websocket` é alternativa aceitável |
| JWT | `github.com/golang-jwt/jwt/v5` | |
| Config | `github.com/caarlos0/env/v11` | env → struct, sem arquivo de config |
| Log | `log/slog` (stdlib) | |
| Trace | `go.opentelemetry.io/otel` | |
| Teste | `testing` + `github.com/stretchr/testify/require` | |
| Teste de integração | `github.com/testcontainers/testcontainers-go` | Postgres e NATS de verdade, sem mock de driver |
| Geração OpenAPI | `github.com/oapi-codegen/oapi-codegen/v2` | servidor e tipos a partir do contrato |
| Lint | `golangci-lint` | config única em `.golangci.yml` na raiz |

Dependência fora desta lista precisa de justificativa no PR. Dependência de
infraestrutura nova (outra fila, outro banco) precisa de ADR.

## 4. Erros

```go
// internal/domain/errors.go
var (
    ErrRoomNotFound = errors.New("room not found")
    ErrRoomFull     = errors.New("room full")
    ErrNotRoomOwner = errors.New("player is not the room owner")
)
```

- Domínio devolve sentinela. `app` embrulha com contexto: `fmt.Errorf("join room %s: %w", code, ErrRoomFull)`.
- **Tradução para HTTP só no adapter**, num único lugar:

```go
// adapter/http/errors.go
func writeError(w http.ResponseWriter, r *http.Request, err error) {
    switch {
    case errors.Is(err, domain.ErrRoomNotFound): write(w, 404, "ROOM_NOT_FOUND", err)
    case errors.Is(err, domain.ErrRoomFull):     write(w, 409, "ROOM_FULL", err)
    case errors.Is(err, domain.ErrNotRoomOwner): write(w, 403, "NOT_ROOM_OWNER", err)
    default:
        slog.ErrorContext(r.Context(), "unhandled error", "err", err)
        write(w, 500, "INTERNAL", errors.New("internal error"))
    }
}
```

- `err` nunca é ignorado. `_ = f()` só com comentário dizendo por quê.
- `panic` apenas em erro de programação durante o boot (config inválida, migration
  falhando). Nunca em handler — há `recover` no middleware, mas ele é rede de
  segurança, não fluxo de controle.
- O legado engole exceção e devolve lista vazia (`GameRepository` loga e retorna `[]`).
  Isso transforma falha em resultado vazio silencioso. Não repita: propague.

## 5. Contexto e concorrência

- `ctx context.Context` é o **primeiro** parâmetro de toda função que faz I/O, e é
  passado adiante. Não guarde `ctx` em struct.
- Todo `ctx` de request tem timeout. Toda query tem timeout.
- **Nenhuma goroutine sem dono e sem saída.** Padrão:

```go
func (e *Engine) Run(ctx context.Context) error {
    g, ctx := errgroup.WithContext(ctx)
    g.Go(func() error { return e.consumeMatches(ctx) })
    g.Go(func() error { return e.renewLeases(ctx) })
    return g.Wait()
}
```

O legado tem `while True` sem condição de parada em quatro lugares
(`listen`, `move_bot`, `process_player_move`, `check_players_connected`) — nenhum
respeita cancelamento. Em Go isso é vazamento de goroutine.

- Shutdown gracioso obrigatório: `SIGTERM` → para de aceitar, drena, libera lease,
  fecha pool, sai. Prazo de 15 s.
- Estado compartilhado com dono único: preferir um canal para uma goroutine dona a
  `sync.Mutex` espalhado. Em `game-engine`, cada partida é uma goroutine dona do seu
  estado; ninguém mais toca nele.

## 6. O loop de simulação

Regras próprias, porque é a parte com requisito de tempo real:

```go
const (
    TickRate      = 60
    TickDuration  = time.Second / TickRate
    SnapshotEvery = 2  // broadcast a 30 Hz
)

func (g *Game) Run(ctx context.Context) error {
    ticker := time.NewTicker(TickDuration)
    defer ticker.Stop()
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        case <-ticker.C:
            g.drainInputs()          // não bloqueante
            g.step()                 // física pura, determinística
            if g.tick%SnapshotEvery == 0 {
                g.broadcast()        // publish sem bloquear
            }
            g.emitPendingEvents()    // gol, fim — sai por canal, não por I/O aqui
        }
    }
}
```

Proibido dentro do tick: query de banco, chamada HTTP, `time.Sleep`, alocação em
laço quente, log. `g.step()` recebe estado e devolve estado — testável sem nada ligado.

O tempo do jogo é `g.tick` (inteiro). Nunca `time.Now()`. Isso é o que permite
golden file, replay e teste determinístico.

## 7. Testes

| Tipo | Onde | Roda com |
| --- | --- | --- |
| Domínio | `internal/domain/*_test.go` | `go test ./...`, sem Docker |
| Caso de uso | `internal/app/*_test.go` com fake das portas | idem |
| Adapter de banco | `internal/adapter/postgres/*_test.go` | tag `//go:build integration` + testcontainers |
| Contrato | `test/contract/` | requests do OpenAPI contra o serviço |
| Paridade | `test/parity/` | legado × novo, ver skill `parity-check` |

- Teste de tabela para regra de domínio. `require`, não `assert` (pare no primeiro erro).
- Sem mock de banco. Ou é fake em memória na porta, ou é Postgres de verdade.
- Física tem teste de golden file (skill `port-game-loop`). Não é opcional.
- `go test -race ./...` no CI. Corrida de dados falha o build.

## 8. Observabilidade

```go
slog.InfoContext(ctx, "room created",
    "roomCode", room.Code, "roomType", room.Type, "ownerId", room.OwnerID)
```

- Mensagem em inglês, minúscula, sem interpolação. Contexto vai em campo chave-valor.
- Nunca logue token, senha ou `Authorization`.
- `traceId` propaga do gateway até o consumidor NATS (no envelope do evento).
- Métricas mínimas por serviço: latência e taxa de erro por rota, lag do consumidor,
  e no engine: partidas ativas, duração real do tick (p99), input descartado.
- `/healthz` (vivo) e `/readyz` (dependências ok) em todo serviço.

## 9. Nomenclatura

- Pacote: substantivo curto, minúsculo, sem `_` (`room`, `pong`, `httpx`). Nunca `utils`
  ou `helpers` — o legado tem `utils/` em dois serviços fazendo coisas sem relação.
- Interface por comportamento: `RoomRepository`, `EventPublisher`, `Clock`.
- Nada de stutter: `room.Room`, não `room.RoomModel`.
- Campo exportado em DTO com tag: `json:"roomCode"` (camelCase na borda, Go idiomático dentro).
- Arquivo: `snake_case.go`, alinhado ao tipo principal.
