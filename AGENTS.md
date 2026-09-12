# AGENTS.md — Transcendence (Pong Multiplayer)

Guia canônico de engenharia deste repositório. Vale para qualquer agente ou pessoa
que trabalhe aqui. `CLAUDE.md` aponta para este arquivo e só adiciona o que é
específico do Claude Code.

## 1. O que é este projeto

Jogo de Pong multiplayer com **simulação autoritativa no servidor**. Três modos:
single-player contra bot, 1v1, e torneio de chaveamento eliminatório (4 inscritos,
2 por partida). O modo de **4 jogadores simultâneos foi cortado** do produto — ver
[decisão D3](docs/migration/06-roadmap.md#decisões-resolvidas). O cliente só envia input e
desenha o estado que recebe — nunca simula física.

**Estado atual:** 2 serviços Django + Channels, 1 SPA em JS puro com renderer
WebGL2 próprio, Redis fazendo três papéis, 4 repositórios Git ligados por
submodules. Detalhes e problemas: [docs/migration/01-analise-atual.md](docs/migration/01-analise-atual.md).

**Estado alvo:** serviços em **Go**, front-end em **Angular**, NATS JetStream como
backbone de eventos. Detalhes: [docs/migration/02-arquitetura-alvo.md](docs/migration/02-arquitetura-alvo.md).

Estamos **no meio de uma migração por strangler fig**. Código novo é Go/Angular;
código Django/JS é legado em vias de remoção. Nunca adicione feature nova no legado
— ver [docs/migration/README.md](docs/migration/README.md) para a onda atual.

## 2. Invariantes do domínio

Estas regras valem em qualquer linguagem. Quebrar uma delas é bug, não escolha.

1. **O servidor é autoritativo.** Posição de bola, paddle e placar só existem como
   resultado da simulação no servidor. O cliente envia intenção (`direction`), não posição.
2. **A simulação tem tick fixo.** 60 Hz (16.667 ms). O tempo do jogo avança em
   passos inteiros de tick, nunca em `delta` de wall-clock. Broadcast pode ser mais
   lento que o tick (30 Hz) — o cliente interpola.
3. **Nada de I/O bloqueante no loop de simulação.** Sem query de banco, sem chamada
   HTTP, sem `await` em rede dentro do tick. Placar e resultado são publicados como
   evento e persistidos fora do loop.
4. **Cada partida tem um único dono.** Exatamente um processo simula uma partida em
   um dado momento, garantido por lease em Redis com TTL. Sem dono, sem simulação.
5. **Eventos são idempotentes.** Todo evento carrega `eventId` (UUIDv7) e o consumidor
   deduplica. Reprocessar `game.finished` não pode pontuar duas vezes.
6. **Um banco por serviço.** Nenhum serviço lê tabela de outro. Integração é por
   evento ou por API.
7. **Identidade vem de token verificado.** Nunca de header `X-User-Id` cru, nunca de
   query string `?userId=`. O gateway valida o JWT e injeta a identidade;
   serviços internos confiam no claim, não no header do cliente.
8. **Slot define cor.** O jogador ocupa um `slot` (0 ou 1) e a cor é derivada do slot
   por uma tabela única em `contracts/`. Não existe mapa de cor por serviço.
9. **Toda partida tem exatamente 2 paddles.** Não há modo de 4 jogadores. Código novo
   não deve carregar generalização para N jogadores "por garantia".

## 3. Layout do repositório (alvo)

```
contracts/          # fonte da verdade das interfaces — mude aqui primeiro
  openapi/          # REST  (gateway, lobby, stats)
  asyncapi/         # eventos NATS
  proto/            # frames binários do WebSocket de jogo
services/
  gateway/          # Go — BFF: auth, roteamento, composição
  lobby/            # Go — salas, jogadores, torneios, orquestração de partida
  game/             # Go — cmd/game-api (WS edge) + cmd/game-engine (simulação)
  stats/            # Go — ranking e histórico (read model)
libs/go/            # Go — código compartilhado de infraestrutura
web/                # Angular
deploy/             # compose, k8s, config de edge
docs/               # adr/, migration/, c4/
legacy/             # Django + JS antigos, removidos ao fim de cada onda
```

Regra: `contracts/` muda antes do código. Handler e cliente derivam do contrato.

## 4. Convenções Go

Detalhe completo em [docs/migration/04-convencoes-go.md](docs/migration/04-convencoes-go.md). Resumo do que não se negocia:

- **Layout por serviço:** `cmd/<bin>/main.go` (só wiring), `internal/domain` (regra
  pura, zero import de infra), `internal/app` (casos de uso), `internal/adapter/{http,nats,postgres,redis}`.
  A dependência aponta sempre para dentro: adapter → app → domain.
- **Sem ORM.** `pgx/v5` + `sqlc`. Migrations com `goose`, versionadas em
  `services/<svc>/migrations`.
- **`context.Context` é o primeiro parâmetro** de tudo que faz I/O, e é respeitado.
- **Erros:** sentinelas no domínio (`var ErrRoomFull = errors.New(...)`), embrulho com
  `%w`, tradução para HTTP só na borda. `panic` só em erro de programação no boot.
- **Log é `log/slog`**, estruturado, com `traceId` do contexto. Sem `fmt.Println`,
  sem logar segredo, sem log dentro do tick de simulação.
- **Concorrência:** goroutine sempre com dono e encerramento definido por `context`.
  Nenhuma goroutine sem caminho de saída. Canal com dono claro de fechamento.
- **Teste:** `go test ./...` roda sem Docker. Domínio tem teste de tabela; adapter de
  banco usa `testcontainers-go` e fica atrás da tag `integration`.
- `golangci-lint run` limpo antes de commit.

## 5. Convenções Angular

Detalhe completo em [docs/migration/05-convencoes-angular.md](docs/migration/05-convencoes-angular.md). Resumo:

- Angular moderno: **standalone components, signals, `inject()`**. Sem `NgModule`,
  sem `constructor` para injeção, sem `any`.
- **Change detection zoneless** (`provideZonelessChangeDetection()`). O jogo roda a
  60 fps sobre WebSocket e `requestAnimationFrame`; zone.js remendando esses dois é
  custo direto de frame.
- **O renderer WebGL não é Angular.** É uma classe TypeScript própria, dirigida por
  `requestAnimationFrame`, que recebe snapshots e desenha. O componente só cria o
  canvas e passa a referência. Nenhuma variável global de jogo.
- Estrutura: `core/` (auth, ws, api gerado, interceptors), `shared/` (UI burra),
  `features/<nome>/` (lobby, room, tournament, game, ranking) com rota lazy.
- **Cliente HTTP é gerado do OpenAPI.** Ninguém escreve `fetch` ou monta URL à mão.
- `strict: true` e `strictTemplates: true`. Teste com Vitest + Testing Library.

## 6. Fluxo de trabalho

1. Leia a onda atual em [docs/migration/README.md](docs/migration/README.md). Trabalho fora da onda precisa de justificativa explícita.
2. Mudou interface? Edite `contracts/` primeiro, regenere, só então implemente.
3. Porte com **paridade verificável**: todo endpoint ou regra portada ganha um teste
   que compara o comportamento com o legado antes do corte. Ver a skill `parity-check`.
4. Nunca apague o legado na mesma mudança que introduz o substituto. Corte de tráfego
   e remoção são passos separados, para permitir rollback por configuração.
5. Commits seguem [CONTRIBUTING.md](CONTRIBUTING.md) (`<tag>: <#issue> <título>`).
   Mensagens em português, código e identificadores em inglês.

## 7. Comandos

```sh
make up            # sobe o ambiente de desenvolvimento
make down          # derruba
make logs s=lobby  # logs de um serviço
make test          # go test ./... em todos os serviços + testes do web
make lint          # golangci-lint + eslint
make gen           # regenera sqlc, openapi, proto
make migrate s=lobby
```

Durante a migração o ambiente legado ainda sobe por `docker-compose.yml` na raiz.

## 8. Limites

- Não commite segredo. `.env` está no repositório com credenciais — trate como
  comprometido, não como exemplo. Novo segredo vai para `.env.local` (ignorado) e o
  repositório carrega apenas `.env.example`.
- Não mude `contracts/` de forma incompatível sem versionar (`/v2`, novo subject).
- Não introduza dependência nova de infraestrutura (outra fila, outro banco) sem ADR.
- Caminhos `/goinfre/...` no compose são do ambiente da 42. Não assuma que existem.
