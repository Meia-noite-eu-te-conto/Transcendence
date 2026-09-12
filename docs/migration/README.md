# Migração: Django + JS → Go + Angular

Índice e **estado vivo** da migração. Este arquivo é o único lugar que registra
onde paramos — atualize a tabela da §3 ao concluir qualquer item.

| Documento | Conteúdo |
| --- | --- |
| [01-analise-atual.md](01-analise-atual.md) | o que existe hoje, o que está quebrado e por quê |
| [02-arquitetura-alvo.md](02-arquitetura-alvo.md) | serviços, infraestrutura, modelo de rede do jogo |
| [03-contratos.md](03-contratos.md) | REST, eventos NATS, frames de jogo, enums canônicos |
| [04-convencoes-go.md](04-convencoes-go.md) | layout, bibliotecas, erros, testes |
| [05-convencoes-angular.md](05-convencoes-angular.md) | estrutura, signals, zoneless, renderer WebGL |
| [06-roadmap.md](06-roadmap.md) | **ordem de execução**: tarefas, dependências, caminho crítico, decisões abertas |
| [../adr/](../adr/) | decisões e o motivo de cada uma |

## 1. Estratégia: strangler fig

Nada de big bang. O `gateway` Go entra na frente do sistema legado **antes** de
qualquer serviço ser portado, e passa tudo adiante. A partir daí cada endpoint é
migrado trocando uma rota no gateway, com rollback por configuração.

```
Onda 0:  navegador → gateway ──▶ Django (tudo)
Onda 1:  navegador → gateway ──┬▶ Django
                               └▶ stats (Go)
Onda 2:  navegador → gateway ──┬▶ Django (só jogo)
                               ├▶ lobby (Go)
                               └▶ stats (Go)
Onda 3:  navegador → gateway ──┬▶ lobby, stats, game (Go)   Django removido
Onda 4:  Angular servido no edge; SPA antiga removida
```

Duas propriedades tornam isso mais fácil do que parece:

- **Quase todo o estado é efêmero.** Sala, partida e jogador vivem minutos. Só
  `stats` (ranking e histórico) tem dado durável. Cortar `lobby` e `game` para Go
  não exige migração de dados — basta cortar quando não houver sala ativa.
- **O front-end já fala HTTP+WS com dois back-ends distintos.** Trocar quem
  responde é mudança de roteamento, não de cliente.

## 2. Ondas

### Onda 0 — Fundação *(nenhuma linha de domínio portada)*
Objetivo: tornar possível portar com segurança.

1. **Consolidar em monorepo.** Importar os 4 submodules preservando histórico
   (`git subtree add`), mover para `legacy/`, arquivar os repositórios originais.
   Ver [ADR-0003](../adr/0003-monorepo.md). Sem isso, cada mudança de contrato exige
   4 pull requests coordenados.
2. **Dockerfile de verdade** para os dois serviços Python — multi-stage, dependência
   travada, sem `pip install` no start, sem bind mount em `/goinfre`.
3. **`contracts/`**: OpenAPI dos endpoints existentes (levantado do código, não
   inventado), AsyncAPI dos 4 eventos atuais, `.proto` do snapshot.
4. **`gateway` em Go** como proxy puro + JWT de convidado. Front-end passa a mandar
   `Authorization` em vez de `X-User-Id`; Django aceita os dois durante a transição.
5. **CI no monorepo**: `go build`/`test`/`lint`, `ng test`, `pytest` do legado,
   validação dos contratos.
6. **Semear NATS e OpenTelemetry** no compose, ainda sem uso.

Saída: dá para portar um serviço sem coordenar quatro repositórios.

### Onda 1 — `stats` *(o primeiro serviço Go)*
Escolhido por ser **só leitura**: se estiver errado, ninguém perde partida.
Prova toolchain, layout, sqlc, goose, observabilidade e o teste de paridade.

1. `services/stats` com o layout padrão (skill `go-service`).
2. Portar `GameView` (ranking) e `TournamentHistoryView` (skill `port-endpoint`).
3. Migração de dados de `db-game-core` → `pg:stats` (o único dado que importa).
4. Consumidor de `game.finished` projetando para as tabelas de leitura.
5. **Paridade:** mesmo conjunto de requests contra Django e Go, respostas idênticas
   (skill `parity-check`). Corrigir a paginação de `TournamentHistoryView`, que hoje
   aceita `pageSize` como string sem validação.
6. Cortar a rota no gateway. Manter o Django respondendo por uma semana antes de remover.

### Onda 2 — `lobby`
O maior volume de regra de negócio, e o de maior risco de comportamento.

1. Domínio primeiro, sem infra: máquina de estados da sala, regras de entrada/saída,
   chaveamento de torneio. Teste de tabela cobrindo os 12 estados. O chaveamento tem
   teste em Python (`rooms/tests.py`) — porte os casos junto.
2. Adapters: Postgres (sqlc), HTTP (chi), WS de sala, NATS.
3. Substituir a lista `create-game-queue` por `match.requested` no JetStream,
   **e fazer o Django publicar nos dois** durante a transição.
4. Orquestrador como consumidor durável de `game.*`, com idempotência por `eventId`.
5. Corte por endpoint, não de uma vez: leitura (`GET /rooms`) primeiro, escrita depois.
6. Corrigir na travessia: sem `X-User-Id`, autorização de dono e membro, `isConnected`
   funcionando (§5 da análise), cor derivada do slot.

### Onda 3 — `game` *(a parte difícil)*
1. **`internal/domain/pong`**: física pura, determinística, sem I/O, sem goroutine.
   Bola, paddle, colisão, gol, bot. Tick como inteiro.
2. **Teste de golden file:** instrumentar o Python com RNG semeado, gravar N ticks de
   estado, e exigir que o Go reproduza dentro de epsilon (skill `port-game-loop`).
   Esta é a única prova aceitável de que a física foi portada.
3. `cmd/game-engine`: JetStream com ack, lease em Redis, loop 60 Hz, snapshot 30 Hz.
4. `cmd/game-api`: WS de jogo, input com `seq`, validação de slot.
5. **Corte gradual por modo de jogo**, do mais simples ao mais complexo:
   single-player → 1v1 → torneio. Chave por tipo de sala no gateway. O modo de 4
   jogadores não é portado (D3).
6. Teste de falha: matar o engine no meio de uma partida e verificar a retomada pelo lease.
7. Remover o channel layer do Redis e as listas de input.

### Onda 4 — `web` em Angular
Roda em paralelo desde a Onda 1 (não depende de back-end Go) e corta no fim.

1. `ng new web`, standalone + signals + zoneless, cliente gerado do OpenAPI.
2. Transcrever `game-front-end/*.js` para TypeScript: `MVnew.js` → `lib/mat4.ts`,
   objetos/shaders/texturas → `lib/renderer/`. Encapsular numa classe `PongRenderer`
   fora do Angular.
3. Features na ordem: `ranking` (só leitura, valida o cliente gerado) → `lobby` →
   `room` → `tournament` → `game`.
4. Servir em `/next` atrás do edge, comparar lado a lado, então virar o padrão.
5. Remover `legacy/Game-Front-End`.

### Onda 5 — Desmonte
Remover `legacy/`, os containers de migration do Django, os volumes `/goinfre`,
o `.env` commitado (rotacionando as senhas), e o `Game-BFF` vazio. Atualizar o C4 em
`docs/` para refletir o que passou a existir.

## 3. Progresso

Atualize ao concluir. `—` = não começou.
A ordem de execução, as dependências entre tarefas e o critério de pronto de cada
uma estão em [06-roadmap.md](06-roadmap.md).

| Onda | Item | Estado |
| --- | --- | --- |
| 0 | **T0.0** realinhar submodules com `main` + refazer análise | ⚠️ bloqueia T0.6, T0.9, ondas 2 e 3 |
| 0 | Monorepo (submodules importados) | — |
| 0 | Dockerfile dos serviços Python | ✅ 2026-09-12 (build verificado) |
| 0 | `contracts/` (OpenAPI + AsyncAPI + proto) | — |
| 0 | `gateway` Go como proxy + JWT | — |
| 0 | CI do monorepo | — |
| 0 | NATS + OTel no compose | — |
| 0-K | `/healthz` e `/readyz` no Django | — |
| 0-K | imagem do front com estáticos embutidos | ✅ 2026-09-12 (build + serve verificados) |
| 0-K | workflow de build/push nos 3 repos | ✅ 2026-09-12 (YAML validado) |
| 0-K | imagens publicadas no ghcr.io | ⏳ falta o secret `GHCR_TOKEN` na org e um tag `v0.1.0` |
| 0-K | namespace, ConfigMap, Secret | — |
| 0-K | Postgres StatefulSet + PVC | — |
| 0-K | Redis com PVC | — |
| 0-K | Job de migrations | — |
| 0-K | Deployments das APIs + Services | — |
| 0-K | workers com replicas 1 + Recreate | — |
| 0-K | Ingress `pong.homelab` com WebSocket | — |
| 0-K | requests/limits em todo workload | — |
| 0-K | validação ponta a ponta no cluster | — |
| 0-K | dashboard no Grafana | — |
| 1 | `services/stats` (scaffold) | — |
| 1 | ranking portado + paridade | — |
| 1 | histórico de torneio portado + paridade | — |
| 1 | migração de dados para `pg:stats` | — |
| 1 | corte de tráfego | — |
| 2 | domínio de sala + testes | — |
| 2 | domínio de torneio + testes | — |
| 2 | adapters de `lobby` | — |
| 2 | `match.requested` no JetStream | — |
| 2 | orquestrador idempotente | — |
| 2 | corte de tráfego | — |
| 3 | `internal/domain/pong` + golden files | — |
| 3 | `game-engine` (lease + tick 60 Hz) | — |
| 3 | `game-api` (WS + input com seq) | — |
| 3 | corte: single-player | — |
| 3 | corte: 1v1 | — |
| 3 | corte: torneio | — |
| 4 | `web` scaffold Angular | — |
| 4 | renderer transcrito para TS | — |
| 4 | features (ranking→lobby→room→tournament→game) | — |
| 4 | corte do front-end | — |
| 5 | `legacy/` removido | — |
| 5 | segredos rotacionados | — |
| 5 | C4 atualizado | — |

## 4. Riscos

| Risco | Impacto | Mitigação |
| --- | --- | --- |
| Física do Go divergir do Python de formas sutis | jogo "sente" diferente, sem erro visível | golden file com RNG semeado antes de qualquer linha de engine (Onda 3.2) |
| Lease de partida com bug de concorrência | partida simulada duas vezes ou por ninguém | teste de falha explícito; uma única réplica até o teste passar |
| Migração parar no meio e virar arquitetura permanente de duas linguagens | pior dos dois mundos, manutenção dobrada | uma onda por vez, corte sempre concluído antes da próxima; nenhuma feature nova no legado |
| Renderer WebGL quebrar na transcrição | jogo não desenha | transcrever sem reprojetar; comparar frame a frame com a SPA antiga rodando ao lado |
| Perda do histórico de partidas na Onda 1 | dado irrecuperável | dump de `db-game-core` antes; corte só depois da paridade passar |
| Segredos commitados já vazados | acesso ao banco | rotacionar na Onda 0, não na 5, se o repositório for público |
| Angular zoneless sem suporte em biblioteca de terceiros | retrabalho no front | manter a lista de dependências curta; Bootstrap por CSS, sem o JS |
