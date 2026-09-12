# CONTEXT.md — Transcendence (raiz)

Orientação de 5 minutos sobre o repositório inteiro. Cada projeto tem o seu próprio
`CONTEXT.md` com o detalhe local:

| Projeto | Contexto | O que é |
| --- | --- | --- |
| `Game-Front-End` | [CONTEXT](Game-Front-End/CONTEXT.md) | SPA em JS puro + renderer WebGL2 + nginx |
| `User-Session` | [CONTEXT](User-Session/CONTEXT.md) | Django — salas, jogadores, torneio, orquestração |
| `Game-Core` | [CONTEXT](Game-Core/CONTEXT.md) | Django — simulação do jogo, WS, ranking |
| `Game-BFF` | [CONTEXT](Game-BFF/CONTEXT.md) | casca vazia; papel de BFF nunca implementado |

Guias transversais: [AGENTS.md](AGENTS.md) (regras de engenharia),
[CLAUDE.md](CLAUDE.md), [docs/migration/](docs/migration/) (análise, alvo, ondas),
[docs/adr/](docs/adr/) (decisões).

## O que é

Jogo de Pong multiplayer com simulação autoritativa no servidor. Projeto
`ft_transcendence` da 42.

Três modos no produto: single-player contra bot, 1v1, e torneio de chaveamento
eliminatório (4 inscritos, 2 por partida). O legado também implementa **4 jogadores
simultâneos** com paddles nos quatro lados — esse modo foi **cortado** e não será
portado ([decisão D3](docs/migration/06-roadmap.md#decisões-resolvidas)).

## Como está organizado

Repositório raiz com **4 git submodules**. Editar dentro de uma pasta de projeto
altera outro repositório — confirme onde está commitando.

```
Transcendence/              ← este repositório: compose, Makefile, docs
├── Game-Front-End/         ← submodule
├── User-Session/           ← submodule
├── Game-Core/              ← submodule
├── Game-BFF/               ← submodule (vazio)
├── docker-compose.yml      ← 9 containers
├── docker-compose-prod.yml
├── Makefile
└── docs/{0-context,1-container}/   ← C4 original (descreve o que se pretendia, não o que existe)
```

## Como rodar

```sh
make mkdir     # cria os volumes em /goinfre — obrigatório antes do primeiro up
make           # docker compose up --build
make re        # fclean + build
```

Abre em `https://localhost:8443` (certificado autoassinado gerado no build do nginx).

Avisos: o compose usa a imagem `python:3.11` e roda `pip install` no start dos dois
serviços Django — o primeiro boot é lento e não é reproduzível. Os volumes apontam
para `/goinfre/...`, caminho específico das máquinas da 42; fora de lá, edite o
compose. O `.env` está commitado com senhas — trate como comprometido.

## Como as peças conversam

```
navegador ──https──▶ nginx ──┬─▶ user-session :8002   (salas, torneio)
                             └─▶ game-core    :8001   (jogo, ranking)

user-session ──RPUSH create-game-queue──────────▶ game-worker (simula)
game-worker  ──RPUSH game-sync-session-queue────▶ game-sync-session-worker (avança torneio)

redis: channel layer (fanout WS) + filas (listas) + buffer de input por jogador
```

O fluxo completo de criar até terminar uma partida está em
[docs/migration/01-analise-atual.md §3](docs/migration/01-analise-atual.md).

## Estado do projeto

**Em migração.** Django → Go, JS puro → Angular, listas Redis → NATS JetStream, por
strangler fig. Código novo é Go/Angular; os quatro projetos acima são legado em vias
de remoção. **Nenhuma feature nova no legado.**

Onda atual e progresso: [docs/migration/README.md](docs/migration/README.md).
Próximos passos com dependências: [docs/migration/06-roadmap.md](docs/migration/06-roadmap.md).

## As três coisas que mais surpreendem quem chega

1. **Redis é fila, pub/sub e buffer ao mesmo tempo** — e como fila é uma lista com
   `LPOP` num laço de 1 segundo, sem ack. Partida perdida não deixa rastro.
2. **Não existe autenticação.** A identidade é um UUID em `localStorage` mandado no
   header `X-User-Id`, e o WebSocket de sala aceita `?userId=` sem verificar.
3. **`Game-BFF` é uma pasta com arquivos vazios.** O C4 em `docs/` descreve um BFF que
   nunca foi escrito; o nginx faz o proxy.
