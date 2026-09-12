# 01 — Análise do estado atual

Levantamento feito sobre o código que o repositório raiz **fixa** nos submodules em
`9252e6b`: Game-Core `b72d7ac`, User-Session `35d5602`, Game-Front-End `c3cfb97`.
~3.300 linhas de Python (fora migrations) e ~3.900 de JS/HTML.

> ## ⚠️ Revisada após o realinhamento com o `main` (2026-09-12)
>
> Esta análise foi escrita sobre commits que o raiz fixava, atrás do `main`. Os
> submodules foram realinhados e o que estava à frente foi verificado. Duas conclusões
> mudaram:
>
> **§4.6 está parcialmente errada.** O User-Session **já tem autenticação** no `main`:
> `djangorestframework_simplejwt` com HS256, `SIMPLE_JWT` configurado em `settings.py`,
> `session/auth_check.py` e `session/exception_handler.py`. Existe também um app
> `roomsv2/` com serializers, paginação e views — que cobre parte do que a Onda 2
> pretendia construir. **T0.9 e a Onda 2 precisam de revisão: é integração, não
> construção.** Ver a atualização no [ADR-0007](../adr/0007-jwt-no-gateway.md).
>
> **A física mudou, e essa mudança foi descartada.** Os 6 commits do Game-Core que
> estavam à frente (`feat: alter ball direction`, `feat: adjust game config and paddle
> positions`, entre outros) foram sobrescritos ao publicar o `main`. Eles estão
> preservados na branch `resgate/main-antes-do-overwrite` do Game-Core e precisam de
> decisão: reaplicar ou abandonar. **Não capture golden file (T3.1) antes de resolver
> isso** — a física de referência depende dessa escolha.
>
> O que continua válido: tudo sobre filas Redis, estado em memória do worker, tick que
> desliza, banco no loop de simulação, mapas de cor divergentes, build não reproduzível
> e ausência de teste.
>
> **Dois segredos novos a rotacionar**, achados na revisão: `User-Session/src/.env`
> commitado com `JWT_SIGNING_KEY`, e um `print()` no nível de módulo em `settings.py:64`
> que **escreve a chave de assinatura JWT no stdout** — em Kubernetes isso vai direto
> para `kubectl logs`.

## 1. Topologia real

Quatro repositórios Git ligados por submodules, orquestrados por um
`docker-compose.yml` na raiz que sobe **9 containers**:

```
                        ┌───────────────────────────┐
   navegador ──https──▶ │ nginx (game-front-end)    │  8080/8443
                        │ serve SPA + reverse proxy │
                        └──────┬──────────────┬─────┘
                               │              │
             /api/v1/user-session/     /api/v1/game-core/
                               │              │
                    ┌──────────▼───────┐  ┌───▼─────────────┐
                    │ user-session     │  │ game-core       │
                    │ Django+Channels  │  │ Django+Channels │
                    │ :8002            │  │ :8001           │
                    └───┬──────────┬───┘  └───┬─────────┬───┘
                        │          │          │         │
              db-user-session      │          │    db-game-core
               (postgres)          │          │     (postgres)
                                   │          │
                        ┌──────────▼──────────▼──────────┐
                        │            redis                │
                        │  1. channel layer (fanout WS)   │
                        │  2. filas (listas + lpop)       │
                        │  3. buffer de input por jogador │
                        └──────────┬──────────┬───────────┘
                                   │          │
                  game-sync-session-worker   game-worker
                  (orquestra torneio)        (simula partidas)
```

Mais `user-session-migrate` e `game-core-migrate`, containers one-shot de migration.

## 2. Responsabilidade de cada peça

### Game-Front-End — SPA em JS puro
- Roteador próprio (`EventHandlers.js:348`): `DOMRender()` faz `fetch` de um `.html`
  parcial e joga em `#root.innerHTML`; cada rota tem uma classe com `init()`/`destroy()`.
- Estado de navegação em `localStorage` (`currentPage`, `roomCode`, `gameId`, `userId`)
  e histórico espelhado em `sessionStorage`.
- 15 arquivos JS carregados por `<script>` no `index.html`, sem bundler, sem módulos.
  Tudo em escopo global (`gPong`, `gl`, `gObjects`, `gCamera`, `gShader`).
- Renderer WebGL2 próprio em `assets/js/game-front-end/` (~1.900 linhas), com
  biblioteca de álgebra linear própria (`MVnew.js`, 1.197 linhas).
- Três conexões WebSocket distintas: jogo (`game-core`), sala e torneio (`user-session`).

### User-Session — contexto de sessão/lobby
Django 5.1 + Channels. Apps: `rooms`, `players`, `games`, `worker`, `session`.
- **Salas:** CRUD, código de 8 chars, sala privada, contagem de jogadores, máquina de
  estados de 12 valores (`Room.STATUS_CHOICES`).
- **Torneio:** gera o chaveamento completo em `rooms/utils.py:createTournamentMatches`
  (`Match` com `stage`, `position`, `nextMatch`), sorteia `bracketsPosition`.
- **Início de partida:** `games/views.py` valida dono/lotação e publica `create_game`
  na lista Redis `create-game-queue`.
- **Orquestração:** `worker/listeners/orchestrator_listerner.py` consome
  `game-sync-session-queue`, avança o chaveamento, promove vencedor e reatribui cor.
- **WS:** `RoomConsumer` (lista de jogadores, `sync.match`, `game.started`) e
  `PlayerScoreConsumer` (placar).

### Game-Core — contexto de jogo
Django 5.1 + Channels. Apps: `games_app` (API/WS), `games_worker` (simulação).
- **WS de jogo:** `GameSessionConsumer` recebe tecla, traduz para `direction` ±1 e
  empurra numa lista Redis por jogador; reenvia snapshot e placar ao cliente.
- **Simulação:** `games_worker/game_core/game_session.py` — loop a ~50 Hz
  (`asyncio.sleep(0.02)`), colisão bola/parede/paddle para 2 e 4 jogadores, reset de
  bola, bot para single-player, detecção de gol e fim de jogo.
- **Leitura:** `ranking/` (agregação de `Score`) e `tournament-history/`.

### Game-BFF — não existe
`README.md` vazio, `src/Dockerfile` e `db/Dockerfile` vazios, `Makefile` vazio.
O C4 em `docs/1-container/` descreve um BFF que nunca foi escrito; o nginx assumiu o
papel de proxy e o front-end fala direto com os dois serviços.

## 3. Fluxos ponta a ponta

### Criar e iniciar uma partida
```
POST /api/v1/user-session/rooms/new-room/          → cria Room + Player dono
PUT  /api/v1/user-session/rooms/{code}/add-player/ → entra, recebe X-User-Id
POST /api/v1/user-session/games/{code}/new-game/   → cria Match, RPUSH create-game-queue
  game-worker: LPOP create-game-queue (a cada 1s)
             → cria GameModel/PlayerModel/ScoreModel no db-game-core
             → RPUSH game-sync-session-queue {type: game-created}
             → asyncio.create_task(GameSession.startGame())
  GameSession: espera todos conectarem (até 120s), RPUSH {game-started},
               group_send room_{code[:8]}_{matchId} → front-end navega para /game.html
  cliente: wss /api/v1/game-core/games/{gameId}/{userId}/
  loop 50 Hz: snapshot → channel layer → todos os clientes
  fim: RPUSH {game-over, winner, players[]} → orquestrador avança o chaveamento
```

### Input do jogador
```
keydown → WS {direction:"w"} → GameSessionConsumer
  → RPUSH game_session_{gameId}_{userId}
  → GameSession.process_player_move: LPOP a cada 5 ms, aplica ±player_speed
```

## 4. Problemas estruturais

Ordenados por impacto na migração. Cada um define um requisito da arquitetura alvo.

### 4.1 Redis acumula três papéis incompatíveis
Channel layer (pub/sub efêmero), fila de trabalho (lista + `LPOP`) e buffer de input.
Como fila, uma lista Redis não tem ack, retry, dead-letter nem visibilidade: se o
`game-worker` cair entre o `LPOP` e o `create_task`, a partida desaparece sem rastro.
O C4 documenta RabbitMQ; o código usa lista Redis. **A documentação e o código nunca
bateram.**

### 4.2 Polling de 1 segundo na criação de partida
`game_maker_listener.py:listen` e `orchestrator_listerner.py:listen` fazem
`await asyncio.sleep(1)` antes de cada `LPOP`. Isso coloca até 1 s de latência em cada
salto do fluxo: criar jogo, avançar chaveamento, registrar resultado. Um torneio de 4
jogadores paga esse custo várias vezes.

### 4.3 Estado das partidas só existe na memória do worker
`GameMakerListener.game_sessions` é um `dict` em processo. Consequências: reiniciar o
worker mata todas as partidas em andamento; não há como rodar duas réplicas (as duas
consumiriam a mesma fila e simulariam jogos diferentes sem coordenação); não há
recuperação, healthcheck de partida nem migração de sessão.

### 4.4 Banco dentro do loop de simulação
`update_score` grava `ScoreModel` a cada ponto, `check_players_connected` consulta
jogadores **a cada segundo** em laço, `game_loop` lê `GameModel` no início e
`send_message_game_start` consulta em laço de 2 s. Postgres no caminho crítico de um
loop de 50 Hz é um acoplamento que impede subir a taxa de tick e torna a latência
dependente da carga do banco.

### 4.5 Caminho de input frágil
O consumer dá `RPUSH` na lista do jogador; o worker dá `LPOP` a cada 5 ms; e o
**consumer** dá `LTRIM(-3,-1)` na mesma lista dentro de `game_update`
(`GameSessionConsumer.py:129`) para limitar o buffer. Três processos escrevendo na
mesma estrutura sem protocolo. Sem número de sequência, input perdido é silencioso e
input duplicado é aplicado duas vezes.

### 4.6 Nenhuma autenticação
A identidade é um UUID em `localStorage` enviado em `X-User-Id`
(`Generics.js:23` — `getCookie()` na verdade lê `localStorage`). O WS de sala aceita
`?userId=` sem verificação (`consumers.py:18`). Qualquer pessoa pode se passar por
qualquer jogador, entrar em qualquer sala, remover jogador de sala alheia e reportar
placar (`UpdatePlayerScoreView` incrementa placar sem verificar nada).
`SECRET_KEY` está fixo no `settings.py` dos dois serviços e `.env` com senhas de
Postgres está commitado.

### 4.7 Modelo de jogador duplicado em dois bancos
`User-Session` tem `Player`/`MatchPlayer`; `Game-Core` tem `PlayerModel`/`ScoreModel`.
O mesmo jogador existe nos dois, sincronizado pela fila. Nenhum dos eventos
(`game-created`, `game-started`, `game-over`) tem `eventId` ou chave de
idempotência — reprocessar `game-over` pontua de novo e reavança o chaveamento.

### 4.8 Três mapas de cor divergentes
| Origem | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| `Game-Core/games_worker/utils/game_config.py` | BLUE | RED | *(ausente)* | GREEN |
| `User-Session/players/models.py` | RED | BLUE | GREEN | YELLOW |
| `Game-Front-End/assets/js/Enums.js` | verde | azul | amarelo | rosa |

`playerColor` no Game-Core herda de `enumerate` (um iterador embutido), não de `Enum`,
e pula o valor 2 — `GREEN = 3, YELLOW = 4`. O `GameSessionConsumer` indexa
`directions_by_color` com as strings `"0".."3"` contra um `CharField`. É a origem mais
provável de bug de controle invertido em jogo de 4.

### 4.9 Build não reproduzível
Os serviços Python não têm `Dockerfile`. O compose usa `python:3.11` e executa
`pip install -r requirements.txt` no comando de start, com bind mount em
`/goinfre/...` (caminho específico da 42). Não há lockfile, não há imagem versionada,
e o código roda a partir de um volume que precisa ser criado à mão (`make mkdir`).

### 4.10 Cobertura de teste quase nula
`games/tests.py` e `players/tests.py` são o stub do Django. `rooms/tests.py` tem 449
linhas, das quais ~350 estão comentadas; sobram 3 testes de chaveamento e 2 de status
de sala, e um deles (`RoomStatusViewTest`) cria `Room(status='2')` — string num
`IntegerField`. Nenhum teste em `Game-Core`. Nenhum teste no front-end. O único CI
(`User-Session/.github/workflows/django.yml`) roda `manage.py test` em um repositório.

## 5. Defeitos pontuais encontrados na leitura

Vale corrigir no legado só se bloquear a onda atual; caso contrário, a correção nasce
no código Go.

| Local | Defeito |
| --- | --- |
| `User-Session/src/session/consumers.py:56` | `self.repository.update_player_connected_status(...)` sem `await` — a corrotina nunca executa, e passa `True` em vez de `False` no disconnect. Jogador fica marcado como conectado para sempre. |
| `User-Session/src/worker/listeners/orchestrator_listerner.py:69` | `f"... {e}"` com `match is None`: `e` não está ligado nesse escopo → `NameError` mascara o erro real. |
| `Game-Core/src/games_worker/game_core/game_session.py:63` | `task = lista.append(...)` devolve `None`, e o `None` é anexado à lista de tarefas. `wait_for_tasks` recebe lixo. |
| `Game-Core/src/games_worker/utils/game_config.py:24` | `ball_speed_x/y` são atributos de classe avaliados **na importação**: toda partida do processo começa com a mesma direção de bola. |
| `Game-Core/src/games_app/consumers/GameSessionConsumer.py:19` | `redis.Redis(host='redis')` fixo, ignorando `REDIS_HOST` que o resto do código lê do ambiente. |
| `Game-Front-End/src/assets/js/game-front-end/Render.js:20` | `gPong.fieldWidth = fieldAttributes["height"]` e só depois sobrescreve com `width` se forem 2 jogadores — campo de 4 jogadores usa altura como largura. |
| `Game-Core/src/games_app/consumers/GameSessionConsumer.py:114` | snapshot passa por `json.dumps` duas vezes (`json.dumps({... "game_state": json.dumps(response)})`), inflando cada frame a 50 Hz. |
| `User-Session/src/games/views.py:16` | `redis.Redis(host='redis')` fixo, mesmo caso. |

## 6. O que a migração aproveita

Nem tudo precisa ser reescrito, e reconhecer isso encurta o caminho:

- **A física funciona.** `check_player_collision` cobre paddle lateral e superior,
  colisão de canto por distância euclidiana e reflexão. É a especificação a portar.
- **O chaveamento funciona.** `createTournamentMatches` monta a árvore completa com
  `nextMatch`, e tem teste. Vira lógica de domínio pura em Go quase sem tradução.
- **O renderer WebGL funciona.** Transcrever para TypeScript e encapsular; não reprojetar.
- **A separação de contextos está correta.** Lobby/sessão × jogo é a fronteira certa;
  a arquitetura alvo mantém esse corte e só acerta a integração entre eles.
- **O C4 em `docs/`** descreve a intenção original. A arquitetura alvo é, em boa
  medida, aquele desenho finalmente implementado.
