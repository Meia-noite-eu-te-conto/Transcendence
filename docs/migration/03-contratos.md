# 03 — Contratos

`contracts/` é a fonte da verdade. Handler Go e cliente TypeScript **derivam** do
contrato; nada é escrito à mão nas duas pontas. Mudança de interface começa aqui.

```
contracts/
  openapi/gateway.yaml     # o que o navegador vê (composição incluída)
  openapi/lobby.yaml       # API interna de lobby
  openapi/stats.yaml       # API interna de stats
  asyncapi/events.yaml     # eventos NATS
  proto/game/v1/frames.proto  # frames do WS de jogo
  enums.yaml               # enums canônicos, fonte de todas as tabelas abaixo
```

Geração: `make gen` roda `oapi-codegen` (Go), `openapi-typescript` (web),
`protoc-gen-go` e `protobuf-ts`.

## 1. Enums canônicos

Hoje existem três mapas de cor divergentes (§4.8 da análise). Passa a existir um.

### Slot e cor
O jogador ocupa um **slot**; a cor é **derivada** do slot. Não há campo de cor
persistido, não há mapa por serviço.

| slot | posição no campo | cor | RGB |
| --- | --- | --- | --- |
| 0 | esquerda | `GREEN` | `#2CFF05` |
| 1 | direita | `BLUE` | `#6395EE` |

Só dois slots: o modo de 4 jogadores foi cortado do produto
([decisão D3](06-roadmap.md#decisões-resolvidas)). Ambos os slots movem em Y (`w`/`s`);
o eixo é derivado do slot pelo servidor, não escolhido pelo cliente. Os valores 2 e 3
ficam **reservados** — não reutilize para outra coisa.

### `RoomType`
| valor | nome | jogadores |
| --- | --- | --- |
| 0 | `MATCH` | 2 |
| 1 | `TOURNAMENT` | 4 inscritos, 2 por partida |
| 2 | `SINGLE_PLAYER` | 1 + bot |

`MATCH` aceita **apenas 2** jogadores. O legado aceitava 2 ou 4 em
`get_room_type_range`; o modo de 4 foi cortado.

### `RoomState`
Hoje são 12 inteiros com dois intervalos (0–7 e 10–13) misturando sala e torneio.
Passa a ser string, e o progresso de torneio sai de `RoomState` para `Tournament.round`:

| valor | significado |
| --- | --- |
| `OPEN` | aceitando jogadores |
| `LOCKED` | cheia ou inscrição travada, chaveamento montado |
| `PLAYING` | há partida em andamento |
| `FINISHED` | encerrada |
| `ABANDONED` | fechada pelo dono ou por inatividade |

### `MatchState`
`PENDING` → `READY` → `RUNNING` → `FINISHED` | `ABORTED`

## 2. REST

Convenções: JSON, `snake_case` **não** — `camelCase`, como o front-end já usa.
Paginação sempre `?page=&pageSize=` com `pageSize` máximo de 100 e validação estrita
(o legado aceita string sem validar). Erro sempre no mesmo envelope:

```json
{ "error": { "code": "ROOM_FULL", "message": "sala cheia", "traceId": "0af7..." } }
```

`code` é estável e programável; `message` é humano e pode mudar. Nada de
`{"errorCode": "400"}` (o legado devolve o status HTTP no corpo, o que não informa nada).

### Auth (gateway)
```
POST   /api/v1/auth/guest        {nickname}  → {accessToken, playerId}  + refresh em cookie HttpOnly
POST   /api/v1/auth/refresh                  → {accessToken}
```

### Lobby
```
GET    /api/v1/rooms?page&pageSize&q         → lista paginada (só salas públicas e abertas)
POST   /api/v1/rooms                         → cria; dono é o playerId do token
GET    /api/v1/rooms/{code}                  → detalhe (gateway compõe com jogadores e torneio)
DELETE /api/v1/rooms/{code}                  → fecha; só o dono
POST   /api/v1/rooms/{code}/players          → entra
DELETE /api/v1/rooms/{code}/players/{id}     → sai (o próprio) ou remove (o dono)
POST   /api/v1/rooms/{code}/lock             → trava inscrição e monta o chaveamento
POST   /api/v1/rooms/{code}/matches          → pede partida; só o dono; 202 Accepted
GET    /api/v1/rooms/{code}/tournament       → chaveamento
```

Mudanças em relação ao legado, de propósito:
- Sem `/new-room/`, `/add-player/`, `/remove-player/`, `/delete` — o método HTTP já
  diz o verbo. Recurso no plural, sem verbo no caminho.
- `POST /matches` devolve **202**, não 201: a partida é criada de forma assíncrona pelo
  engine. O legado devolve 201 para algo que ainda não existe.
- Identidade sempre do token. `X-User-Id` deixa de ser aceito ao fim da Onda 2.

### Stats
```
GET /api/v1/stats/ranking?page&pageSize                    → ranking de jogadores
GET /api/v1/stats/tournaments/{roomCode}/matches?page&...   → histórico
```

## 3. Eventos NATS

### Convenção de subject
```
<contexto>.<agregado>.<evento>          eventos de domínio, JetStream, duráveis
game.<gameId>.snapshot                  efêmero, NATS core, alta frequência
game.<gameId>.input                     efêmero, NATS core
```

### Envelope
Todo evento durável carrega o mesmo envelope. **`eventId` é obrigatório** e o
consumidor deduplica por ele (§4.7 da análise: hoje nenhum evento tem id).

```json
{
  "eventId":   "018f...",            // UUIDv7, chave de idempotência
  "type":      "game.finished",
  "version":   1,
  "occurredAt":"2026-09-12T10:00:00Z",
  "traceId":   "0af7651916cd43dd...",
  "data":      { }
}
```

### Streams

| Subject | Publica | Consome | `data` |
| --- | --- | --- | --- |
| `lobby.match.requested` | lobby | game-engine | `matchId, roomId, roomCode, roomType, round, seed, players[{playerId, nickname, slot}]` |
| `game.game.created` | game-engine | lobby | `gameId, matchId` |
| `game.game.started` | game-engine | lobby | `gameId, matchId, startedAtTick` |
| `game.game.finished` | game-engine | lobby, stats | `gameId, matchId, winnerId, durationTicks, players[{playerId, slot, score, rank}]` |
| `game.game.aborted` | game-engine | lobby | `gameId, matchId, reason` |
| `lobby.tournament.advanced` | lobby | — | `roomCode, round, matches[]` |
| `lobby.tournament.finished` | lobby | stats | `roomCode, winnerId, standings[]` |

Notas de desenho:
- `seed` em `match.requested` é o que torna a simulação reproduzível. Sem ele não há
  golden file nem replay.
- `game.finished` carrega o placar **completo**, com `rank`. `lobby` usa para avançar
  o chaveamento e `stats` para projetar — nenhum dos dois consulta o outro.
- `game.aborted` não existe hoje: quando todos desconectam, o legado espera 180 s e
  simplesmente sai do loop, deixando a sala presa em `CREATING_GAME`.

### Consumidores duráveis
| Consumidor | Stream | Política |
| --- | --- | --- |
| `game-engine` | `LOBBY` filtrado em `lobby.match.requested` | explicit ack, `maxDeliver 3`, ack wait 30 s, DLQ |
| `lobby-orchestrator` | `GAME` filtrado em `game.game.*` | explicit ack, dedupe por `eventId` |
| `stats-projector` | `GAME`+`LOBBY` filtrado em `*.finished` | explicit ack, dedupe por `eventId` |

Ack explícito é o ponto: substitui o `LPOP` sem rede de segurança de hoje.

## 4. Frames de jogo (Protobuf)

`contracts/proto/game/v1/frames.proto`. Snapshot atual é JSON dentro de JSON a 50 Hz
(§5 da análise); aqui vai a ~40 bytes.

```protobuf
syntax = "proto3";
package game.v1;

// cliente → servidor
message InputFrame {
  uint32 seq       = 1;  // monotônico por conexão; servidor descarta <= último aplicado
  uint32 client_tick = 2;
  sint32 direction = 3;  // -1, 0, +1 no eixo do slot
}

// servidor → cliente, 30 Hz
message Snapshot {
  uint32 tick         = 1;
  uint32 last_ack_seq = 2;  // último input deste cliente que o servidor aplicou
  GameState state     = 3;
}

message GameState {
  Ball ball               = 1;
  repeated Paddle paddles = 2;  // sempre 2 elementos
  repeated uint32 scores  = 3;  // indexado por slot (0..1)
  Status status           = 4;
  sint32 last_hit_slot    = 5;  // -1 se nenhum
  Field field             = 6;  // enviado só quando muda
}

message Ball   { float x = 1; float y = 2; float radius = 3; }
message Paddle { uint32 slot = 1; float x = 2; float y = 3; float width = 4; float height = 5; }
message Field  { float width = 1; float height = 2; }

enum Status { WAITING = 0; PLAYING = 1; PAUSED = 2; FINISHED = 3; }

// servidor → cliente, eventual
message GameEvent {
  oneof event {
    ScoreChanged score_changed = 1;
    GameFinished finished      = 2;
  }
}
message ScoreChanged { uint32 slot = 1; uint32 score = 2; }
message GameFinished { string winner_id = 1; repeated Standing standings = 2; }
message Standing     { string player_id = 1; uint32 slot = 2; uint32 score = 3; uint32 rank = 4; }
```

Ponto importante: **placar vem em `GameEvent`, não em todo snapshot.** Placar muda
raramente; mandar a 30 Hz é desperdício. O `GameState.scores` existe só para
sincronizar quem acaba de conectar.

## 5. WebSocket

| Rota | Serviço | Protocolo |
| --- | --- | --- |
| `wss://host/api/v1/rooms/{code}/ws` | gateway → lobby | JSON |
| `wss://host/api/v1/games/{gameId}/ws` | game-api (direto) | Protobuf binário |

Handshake: token no subprotocolo (`Sec-WebSocket-Protocol: bearer.<jwt>`), nunca em
query string. O legado usa `?userId=` (§4.6) — query string aparece em log de acesso
de qualquer proxy no caminho.

Mensagens do WS de sala (JSON, mesmo envelope de evento sem `eventId`):
`players.changed`, `match.ready`, `game.started`, `room.closed`, `tournament.advanced`.

## 6. Compatibilidade

- **Aditivo é livre**: campo novo opcional, evento novo, endpoint novo.
- **Quebra exige versão**: `/api/v2/...` para REST, `version: 2` no envelope com o
  consumidor aceitando as duas até a migração terminar, `package game.v2` para proto.
- **Nunca reutilize número de campo Protobuf.** Campo removido vira `reserved`.
- Enum ganha valor no fim. Consumidor trata valor desconhecido como "ignorar", não
  como erro — senão adicionar um modo de jogo quebra clientes antigos.

Revisão de mudança em `contracts/`: subagente `contract-guardian`.
