---
name: go-service
description: Cria um serviço Go novo em services/ com o layout padrão do projeto (cmd, internal/domain, app, adapter), Dockerfile, migrations, healthcheck e wiring de observabilidade. Use ao iniciar gateway, lobby, game ou stats, ou qualquer serviço Go novo deste repositório.
---

# Criar um serviço Go

Segue as [convenções Go](../../../docs/migration/04-convencoes-go.md). Antes de gerar
arquivo, confirme com o usuário: nome do serviço, se tem banco, se consome ou publica
evento, e quais binários (alguns serviços têm mais de um, como `game`).

## 1. Esqueleto

```
services/<svc>/
  go.mod                       module .../services/<svc>
  cmd/<bin>/main.go            só wiring
  internal/
    domain/                    regra pura — ZERO import de infra
    app/
      ports.go                 interfaces que o app consome
      <caso_de_uso>.go
    adapter/
      http/{router.go,handlers.go,errors.go,middleware.go,dto.go}
      postgres/{db.go,repository.go,gen/}   (se tem banco)
      nats/{publisher.go,consumer.go}       (se tem evento)
      redis/client.go                       (se precisa)
    config/config.go
  migrations/                  goose, se tem banco
  queries/                     .sql do sqlc, se tem banco
  sqlc.yaml
  Dockerfile
  .golangci.yml -> ../../.golangci.yml
```

A dependência aponta para dentro: `adapter → app → domain`. Verificação mecânica:
`go list -deps ./internal/domain` não pode conter `pgx`, `nats`, `redis` nem `net/http`.

## 2. `main.go`

Só isto, nesta ordem. Nenhuma regra de negócio.

```go
func main() {
    if err := run(); err != nil {
        slog.Error("fatal", "err", err)
        os.Exit(1)
    }
}

func run() error {
    cfg, err := config.Load()          // env → struct, validado; falha cedo
    if err != nil { return err }

    setupLogger(cfg)                   // slog JSON, nível do env
    shutdownOtel, err := setupOtel(ctx, cfg)
    // ...
    pool, err := postgres.Connect(ctx, cfg.DatabaseURL)
    nc, err := natsx.Connect(ctx, cfg.NatsURL)

    repo := postgres.NewRoomRepository(pool)
    pub  := nats.NewPublisher(nc)
    uc   := app.New(repo, pub, clock.System{})

    srv := &http.Server{Addr: cfg.Addr, Handler: httpadapter.NewRouter(uc, cfg)}

    g, ctx := errgroup.WithContext(ctx)
    g.Go(func() error { return serve(ctx, srv) })
    g.Go(func() error { return consumer.Run(ctx) })   // se consome evento
    return g.Wait()
}
```

Obrigatório: **shutdown gracioso** em `SIGTERM`/`SIGINT` com prazo de 15 s — para de
aceitar, drena, libera lease (se houver), fecha pool, sai.

## 3. Config

```go
type Config struct {
    Addr        string `env:"ADDR" envDefault:":8080"`
    DatabaseURL string `env:"DATABASE_URL,required"`
    NatsURL     string `env:"NATS_URL,required"`
    LogLevel    string `env:"LOG_LEVEL" envDefault:"info"`
    OtelEndpoint string `env:"OTEL_EXPORTER_OTLP_ENDPOINT"`
}
```

Só variável de ambiente, sem arquivo. Validado no boot: config ruim mata o processo
imediatamente, não no primeiro request. **Nenhum valor padrão para segredo** — se
falta, falha.

## 4. Middleware HTTP, nesta ordem

`RequestID` → `otelhttp` → `RealIP` → `Recoverer` → `Logger` → `Timeout` →
`Auth` (exceto `/healthz`, `/readyz`).

`Auth` lê o claim injetado pelo gateway e coloca o `playerId` no contexto. **Nunca**
aceite `X-User-Id` do cliente — ver [ADR-0007](../../../docs/adr/0007-jwt-no-gateway.md).

## 5. Endpoints obrigatórios

| Rota | Devolve |
| --- | --- |
| `GET /healthz` | 200 se o processo está vivo. Sem tocar dependência. |
| `GET /readyz` | 200 se banco e NATS respondem. É o que o orquestrador usa. |
| `GET /metrics` | Prometheus, se o serviço expõe métrica |

## 6. Banco

- `goose create <nome> sql` em `migrations/`. Toda migration tem `-- +goose Down`.
- Query em `queries/*.sql` com anotação do sqlc; `make gen` gera `adapter/postgres/gen/`.
- `adapter/postgres/repository.go` implementa a porta de `app/ports.go` traduzindo
  tipo gerado ↔ tipo de domínio. **O domínio nunca vê tipo gerado.**
- Migration roda como comando separado no deploy, não no start do serviço.

## 7. Dockerfile

Multi-stage, binário estático, imagem final `gcr.io/distroless/static` ou `scratch`,
usuário não-root, `CGO_ENABLED=0`. Nada de `go run`, nada de código-fonte na imagem
final — é a correção direta do que o legado faz (imagem `python:3.11` com
`pip install` no start).

## 8. Registrar no ambiente

1. Serviço em `deploy/compose/docker-compose.yml` com `depends_on` por healthcheck.
2. Rota no `gateway` (comece apontando para o legado; troque no corte).
3. Entrada no `Makefile` (`make test`, `make lint`, `make migrate s=<svc>`).
4. Filtro de caminho no CI.
5. Linha na tabela de progresso em [migração](../../../docs/migration/README.md).

## Critérios de aceite

- [ ] `go build ./...` e `go vet ./...` limpos
- [ ] `golangci-lint run` limpo
- [ ] `go test -race ./...` passa sem Docker
- [ ] `go list -deps ./internal/domain` sem import de infra
- [ ] `/healthz` e `/readyz` respondem
- [ ] serviço sobe pelo compose e derruba com `SIGTERM` em menos de 15 s
- [ ] config sem valor padrão para segredo
- [ ] `Dockerfile` multi-stage, imagem final sem shell nem fonte
