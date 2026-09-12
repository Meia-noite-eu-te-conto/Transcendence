# 02 — Arquitetura alvo

Go nos serviços, Angular no front-end, NATS como backbone de eventos. Cada escolha
aqui responde a um problema concreto da [análise atual](01-analise-atual.md).

## 1. Princípio de dimensionamento

O projeto tem um time pequeno e um domínio pequeno. **Microsserviço aqui é fronteira
de contexto, não unidade de deploy mínima.** Quatro serviços com fronteiras nítidas
valem mais que nove serviços anêmicos que precisam conversar para responder qualquer
coisa. O corte abaixo segue o que o código já separa naturalmente e que o Redis
compartilhado hoje esconde.

Onde faz sentido, um serviço tem **mais de um binário** no mesmo módulo Go
(`game-api` e `game-engine` compartilham o domínio da simulação). Isso dá escala
independente sem duplicar contrato interno.

## 2. Serviços

```
                                 ┌──────────────────┐
                    navegador ──▶│ edge (Traefik)   │ TLS, estáticos, roteamento
                                 └────┬─────────┬───┘
                                      │         │
                            ┌─────────▼───┐ ┌───▼───────────────┐
                            │ web         │ │ gateway (Go)      │
                            │ Angular+nginx│ │ auth, composição │
                            └─────────────┘ └──┬────────┬───────┘
                                               │        │
                       ┌───────────────────────┘        └──────────────┐
                       │                                              │
              ┌────────▼────────┐  ┌──────────────────┐      ┌────────▼────────┐
              │ lobby (Go)      │  │ game (Go)        │      │ stats (Go)      │
              │ salas, torneio, │  │ cmd/game-api ◀── WS     │ ranking,        │
              │ orquestração    │  │ cmd/game-engine  │      │ histórico       │
              └───┬─────────┬───┘  └───┬──────────┬───┘      └────────┬────────┘
                  │         │          │          │                   │
             pg:lobby       │      redis:lease    │              pg:stats
                            │      (dono/presença)│                   │
                            └──────┬─────────┬────┴───────────────────┘
                                   │  NATS JetStream  │
                                   │  eventos duráveis│
                                   │  + core pub/sub  │
                                   │  para snapshots  │
                                   └──────────────────┘
```

### `edge` — Traefik
TLS, certificado, servir o bundle Angular, rotear `/api/**` para o gateway.
Substitui o nginx atual. Traefik em vez de nginx porque a configuração é declarativa
por label e o mesmo arquivo serve compose e Kubernetes. Se o time preferir manter
nginx, a decisão é reversível e não afeta serviço nenhum.

### `gateway` (Go) — o BFF que o C4 sempre previu
Finalmente implementa `Game-BFF`. Responsabilidades, e **só** estas:
- Emitir e validar JWT. É o único ponto que aceita credencial do cliente.
  Injeta `X-Player-Id` e `X-Player-Claims` para dentro; a rede interna não é exposta.
- Rate limit por jogador e por IP (Redis).
- Roteamento e **composição**: a tela de sala hoje faz 3 chamadas; o gateway devolve
  uma. A de torneio, 2. Isso é o ganho real de ter BFF.
- Proxy de WebSocket da sala, com o token validado no handshake.
- **Não** tem banco próprio e **não** tem regra de domínio.

O WS de jogo **não** passa pelo gateway: vai direto do navegador para `game-api`.
Um salto extra a 30 Hz por partida não se justifica, e `game-api` valida o mesmo JWT.

### `lobby` (Go) — contexto Sessão
Absorve `User-Session` inteiro, incluindo o worker orquestrador.
- Salas: criar, listar com paginação/filtro, entrar, sair, remover, fechar.
- Máquina de estados da sala, explícita e testada (hoje são 12 inteiros num `IntegerField`).
- Torneio: montar chaveamento, travar inscrição, avançar rodada, promover vencedor.
- Partida: criar, publicar `match.requested`, consumir `game.*` e avançar o chaveamento.
- WS de sala: lista de jogadores, `match.ready`, `game.started`.
- Banco: `pg:lobby`. **Dados efêmeros** — uma sala vive minutos.

### `game` (Go) — contexto Jogo, dois binários
**`cmd/game-api`** — borda stateless:
- WS por jogador: recebe input, entrega snapshot. Valida JWT, resolve o slot do
  jogador na partida, rejeita input de slot que não é o dele.
- REST de leitura da partida em curso.
- Assina snapshots no NATS core e repassa; **não simula nada**.
- Escala horizontalmente sem coordenação.

**`cmd/game-engine`** — simulação autoritativa:
- Consome `match.requested` do JetStream (com ack — nada de `LPOP`).
- Adquire **lease** da partida em Redis (`SET NX PX`, renovado a cada tick lento).
  Sem lease, não simula. Resolve o §4.3 da análise: duas réplicas coexistem.
- Loop de tick fixo em 60 Hz com acumulador; broadcast de snapshot a 30 Hz.
- **Zero I/O de banco no loop.** Ponto, gol e fim de jogo saem como evento.
- Recupera partida órfã: lease expirado + estado no Redis → outra réplica retoma.

### `stats` (Go) — read model
- Ranking e histórico de torneio (hoje `GameView` e `TournamentHistoryView`).
- Alimentado **só por evento** (`game.finished`), projetando para tabelas de leitura.
- É o **único serviço com dado durável que importa**, e portanto o único que exige
  migração de dados de verdade.

## 3. Infraestrutura

| Peça | Papel | Por quê |
| --- | --- | --- |
| **NATS JetStream** | eventos de domínio, duráveis, com ack, retry e replay | Resolve §4.1 e §4.2: fila de verdade, entrega push (sem polling de 1 s), consumidor durável com redelivery. Um binário, sem ZooKeeper, cliente Go de primeira classe. |
| **NATS core** | fanout de snapshot de jogo | Mesma dependência cobre o pub/sub efêmero a 30 Hz que hoje é o channel layer. Uma tecnologia de mensageria em vez de duas. |
| **Redis** | lease de partida, presença, rate limit, cache | Continua, mas **rebaixado**: deixa de ser fila. Fica só no que Redis faz bem — chave com TTL. |
| **Postgres** | um banco por serviço (`lobby`, `stats`) | Mantém o que já existe. `game` não tem banco. |
| **OpenTelemetry** | trace do request até o evento | Sem isso, depurar "a partida não começou" atravessa 4 processos no escuro. |

### Por que NATS e não RabbitMQ ou Kafka
RabbitMQ resolveria a fila (e é o que o C4 dizia), mas não serve para o fanout de
snapshot — sobraria o channel layer do Redis em paralelo. Kafka é grande demais para
o volume e não tem pub/sub de baixa latência sem partição. NATS entrega **os dois
padrões que este sistema precisa** em um processo de ~15 MB. Registrado em
[ADR-0002](../adr/0002-nats-como-backbone.md).

## 4. O modelo de rede do jogo

O `README.md` do projeto já aponta para a série do Gabriel Gambetta. A arquitetura
alvo implementa aquele modelo de fato:

1. **Servidor autoritativo com tick fixo.** 60 Hz, passo determinístico.
   O tick é um contador inteiro, não um `delta` de wall-clock.
2. **Input com número de sequência.** O cliente envia `{seq, tick, direction}`.
   O servidor aplica em ordem, descarta duplicado e reconhece o último `seq` aplicado.
   Resolve §4.5 — perda e duplicação deixam de ser silenciosas.
3. **Snapshot com tick e ack.** O servidor manda `{tick, lastAckSeq, ball, paddles, score}`
   a 30 Hz.
4. **Interpolação no cliente.** Com 30 Hz de snapshot e 60 fps de tela, o cliente
   interpola entre os dois últimos snapshots. É o que dá suavidade sem mentir sobre o estado.
5. **Predição local só do próprio paddle** (opcional, última etapa). Aplica o input
   localmente na hora e reconcilia quando o snapshot com `lastAckSeq` chega. Bola e
   adversário nunca são preditos.

**Determinismo é requisito.** RNG com semente por partida (`seed` no evento
`match.requested`), aritmética em `float64` com ordem de operações fixa. Sem isso não
existe teste de paridade nem replay.

### Frame binário
O snapshot atual é JSON dentro de JSON (§5 da análise) a 50 Hz. O alvo é **Protobuf**
em `contracts/proto/game/v1/`: ~40 bytes por frame contra ~400, e o tipo passa a ser
compartilhado entre Go e TypeScript por geração de código. REST continua JSON.

## 5. Autenticação

Hoje: nenhuma (§4.6). Alvo, mantendo o jogo sem cadastro:
- `POST /api/v1/auth/guest {nickname}` → o gateway cria identidade anônima e devolve
  JWT de vida curta (15 min) + refresh em cookie `HttpOnly`.
- `playerId` é claim do token, nunca corpo ou header vindo do cliente.
- O WS carrega o token no subprotocolo do handshake, não em query string
  (query string vaza em log de proxy).
- Autorização no domínio: `lobby` verifica que o `playerId` do token é o dono da sala
  antes de fechá-la, é membro antes de sair, e o `game-api` verifica que o slot
  pertence ao jogador antes de aplicar input.
- Segredo por variável de ambiente, HS256 no início. Assimétrico só se aparecer um
  segundo emissor.

Login 42/OAuth cabe depois sem mudar nada além do gateway.

## 6. Mapa legado → alvo

| Hoje | Alvo | Observação |
| --- | --- | --- |
| `nginx` (proxy + estáticos) | `edge` + `gateway` | TLS e estáticos no edge; auth e composição no gateway |
| `Game-BFF` (vazio) | `gateway` | o papel do C4 finalmente implementado |
| `User-Session` `rooms`,`players` | `lobby` | |
| `User-Session` `games` (criar partida) | `lobby` → publica `match.requested` | |
| `User-Session` `worker` (orquestrador) | `lobby` (consumidor JetStream) | mesmo serviço, sem processo separado |
| `User-Session` `session/consumers` | `lobby` WS (via `gateway`) | |
| `Game-Core` `games_app/consumers` | `game-api` | |
| `Game-Core` `games_worker` | `game-engine` | com lease e tick fixo |
| `Game-Core` `views` (ranking, histórico) | `stats` | migração de dados necessária |
| Redis lista `create-game-queue` | NATS `match.requested` | com ack |
| Redis lista `game-sync-session-queue` | NATS `game.created/started/finished` | com `eventId` |
| Redis lista por jogador (input) | canal de input em memória no engine | input chega pelo WS e não passa por Redis |
| channel layer Redis | NATS core `game.{id}.snapshot` | |
| `Game-Front-End` (JS puro) | `web` (Angular) | renderer WebGL transcrito para TS |

## 7. O que não muda

- **A física.** O comportamento observável de `check_player_collision`,
  `ball_reset`, `check_game_conditions` e do bot é a especificação. Divergência é bug,
  salvo as intencionais documentadas na skill `port-game-loop`.
- **O chaveamento.** `createTournamentMatches` vira domínio Go quase literalmente.
- **O renderer.** Transcrição, não reprojeto.
- **A fronteira Lobby × Jogo.** Já estava certa.

## 8. Custos assumidos

Registrar honestamente o que esta arquitetura cobra:
- **Uma dependência nova** (NATS) a aprender, operar e depurar.
- **Protobuf** adiciona um passo de geração no build de Go e de TS.
- **Lease de partida** é código de coordenação distribuída — a parte mais sujeita a
  bug subtil de todo o desenho. Precisa de teste de falha explícito (matar o engine
  no meio de uma partida e verificar a retomada).
- **Angular zoneless** é o caminho certo para 60 fps, mas é território menos trilhado:
  bibliotecas de terceiros que dependem de zone.js podem não funcionar.
- **Migração de `stats`** é a única com dado real em jogo e exige janela de corte.
