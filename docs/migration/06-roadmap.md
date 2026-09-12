# 06 — Roadmap de execução

As [ondas](README.md) dizem **o que e por quê**. Este documento diz **em que ordem,
quem depende de quem, e quando uma tarefa está pronta**. Cada linha vira uma issue.

Tamanhos: **P** ≤ 1 dia · **M** 2–4 dias · **G** 1–2 semanas · **GG** > 2 semanas.
Assumem uma pessoa dedicada à tarefa. Calendário depende do tamanho do time — ver
[decisão D2](#decisões-abertas).

## Os próximos passos

Independente de qualquer decisão pendente, nesta ordem:

1. **T0.0 — realinhar os submodules com o `main`.** O repositório raiz aponta para
   commits defasados, e o que está à frente inclui autenticação, um app `roomsv2/` e
   mudanças na física. Boa parte do planejamento das ondas 2 e 3 foi feito sobre
   código antigo e precisa de revisão. **Faça antes de tudo.**
2. **T0.1 — rotacionar os segredos.** `.env` está commitado com senhas de Postgres, e
   `SECRET_KEY` está fixo em dois `settings.py`. Se o repositório é ou já foi público,
   trate como vazado. Não espera onda nenhuma.
3. **T0.3 — importar os submodules em monorepo.** É a mudança mais disruptiva do
   roadmap (todo mundo refaz o clone), então faça cedo, de uma vez, com o time avisado.
4. **T0.2 — Dockerfile de verdade.** É o bloqueio duro da Onda 0-K: **sem imagem não
   existe deploy em Kubernetes.** O arranjo atual (imagem `python:3.11` com
   `pip install` no `command` e bind mount em `/goinfre`) não tem equivalente em k8s.

## Caminho crítico

A prioridade declarada é **subir o legado no Kubernetes antes de migrar para Go**
([decisão D5](#decisões-resolvidas)). Isso põe a Onda 0-K na frente das ondas de
migração: o cluster passa a ser a plataforma provada, e cada serviço Go depois só
substitui um Deployment.

```
T0.1 ─▶ T0.3 ─▶ T0.2 ─▶ ONDA 0-K (legado no k3s) ─┐
                                                   │
                        T0.4 ─▶ T0.5               ├─▶ ONDA 1 ─▶ ONDA 2 ─▶ ONDA 3 ─▶ T4.11 ─▶ ONDA 5
                        T0.6 ─┬▶ T0.8 ─▶ T0.9 ─▶ T0.10 ┘
                              └▶ T4.1 ─▶ T4.2 ─▶ ...  (track Angular, em paralelo)
```

Depois da Onda 0-K, o gargalo volta a ser a **Onda 3** (física + engine). Tudo que
puder ser adiantado em paralelo deve ser: o track Angular não depende de serviço Go
nenhum além do contrato, e a captura de golden files (T3.1) pode começar durante a
Onda 1.

---

## Onda 0 — Fundação

Nenhuma linha de domínio portada. Objetivo: tornar possível portar com segurança.

| ID | Tarefa | Tam | Depende | Pronto quando |
| --- | --- | --- | --- | --- |
| **T0.0** | ✅ Realinhar os submodules com `origin/main` e refazer a análise | M | — | o raiz fixa Game-Core, User-Session e Game-Front-End **atrás** do `main` (6, 6 e 3 commits). À frente há `auth_check.py`, o app `roomsv2/`, campo `userid` em `Player` e mudanças na física. **Bloqueia T0.6, T0.9, T2.x e T3.x**, que foram planejados sobre código defasado. Ver a ressalva em [01-analise-atual.md](01-analise-atual.md) |
| **T0.1** | Rotacionar segredos; `.env` fora do versionamento | P | — | `git ls-files .env` vazio; `.env.local` no `.gitignore`; senhas e `SECRET_KEY` antigas não funcionam; `SECRET_KEY` lido do ambiente nos dois `settings.py` |
| **T0.2** | Dockerfile multi-stage para os dois serviços Python | M | T0.3 | `docker compose build` reproduzível; dependências travadas (pip-tools ou uv); sem `pip install` no `command`; sem bind em `/goinfre`; boot < 10 s |
| **T0.3** | Monorepo: `git subtree add` dos 4 submodules para `legacy/` | M | T0.1 | 4 projetos em `legacy/` com histórico preservado; `.gitmodules` removido; compose e Makefile apontando para os novos caminhos; repositórios originais arquivados em leitura |
| **T0.4** | `deploy/compose/` + Makefile do monorepo | P | T0.2 | `make up`, `make down`, `make logs s=`, `make test`, `make lint` funcionam; `depends_on` por healthcheck, não por ordem |
| **T0.5** | CI do monorepo com filtro por caminho | M | T0.4 | PR que toca só `web/` não roda Go; `go test -race`, `golangci-lint`, `tsc --noEmit`, teste do legado e validação de contrato no pipeline |
| **T0.6** | `contracts/openapi/`: levantar os ~20 endpoints existentes **a partir do código** | G | T0.3 | todo endpoint de `legacy/*/views.py` documentado com parâmetro, schema e **cada** código de status que o código produz; `make gen` gera tipos Go e TS |
| **T0.7** | `contracts/asyncapi/` + `contracts/enums.yaml` | M | T0.6 | os 4 eventos atuais documentados; envelope definido; mapa canônico de slot→cor substituindo os três divergentes |
| **T0.8** | `services/gateway` (skill `go-service`) como proxy puro | M | T0.6 | todo o tráfego passa pelo gateway; comportamento idêntico ao nginx; `/healthz` e `/readyz`; rollback = apontar o edge de volta |
| **T0.9** | ⚠️ **Revisar antes de executar.** Gateway emite e valida JWT; Django aceita `Authorization` **e** `X-User-Id` | M | T0.8 | O `User-Session` já tem SimpleJWT com HS256 e `auth_check.py` no `main`. Leia o que existe antes de escrever: a tarefa é integrar e mover para o gateway, não construir. Corrigir também o `print()` em `settings.py:64`, que escreve `JWT_SIGNING_KEY` no stdout |
| **T0.10** | SPA legada passa a mandar `Authorization` | P | T0.9 | nenhuma chamada da SPA usa `X-User-Id`; WS com token no subprotocolo |
| **T0.11** | NATS e OTel no compose, sem uso | P | T0.4 | NATS responde; collector recebe trace do gateway |

**Portão 0:** um repositório, build reproduzível, gateway na frente, contratos
escritos, CI verde. Só então comece a Onda 1.

---

## Onda 0-K — O legado no Kubernetes

**Primeiro objetivo prático:** o sistema atual, em Django, rodando no cluster k3s do
homelab. Nada de Go ainda. O valor é ter a plataforma de deploy provada **antes** de
começar a trocar as peças — depois disso, cada serviço Go é só um Deployment novo
substituindo um antigo, e o rollback é `kubectl rollout undo`.

Fatos do cluster, convenções e orçamento de recursos: [docs/deploy/](../deploy/).
Manifests em [`manifests/`](../../manifests/).

| ID | Tarefa | Tam | Depende | Pronto quando |
| --- | --- | --- | --- | --- |
| **TK.1** | `GET /healthz` nos dois serviços Django | P | T0.3 | responde 200 sem tocar banco; `/readyz` toca banco e Redis. Sem isso não há probe possível — o legado não tem endpoint de saúde |
| **TK.2** | Imagem do front-end com os estáticos **embutidos** | P | T0.2 | `src/` copiado para dentro da imagem; nenhum volume de código. Em k8s não existe o bind mount `/goinfre/front-end-dev` que o compose usa |
| **TK.3** | Publicar as 3 imagens em `ghcr.io/davypaulino/` | P | T0.2, TK.2 | tags versionadas (nunca `latest`); `imagePullSecrets: github-registry` no namespace do projeto |
| **TK.4** | Namespace, ConfigMap e Secret | P | T0.1 | namespace `pong`; secret criado a partir de `.env.local`, **nunca** commitado; `SECRET_KEY` do Django vindo do secret |
| **TK.5** | Postgres: um StatefulSet, dois bancos | M | TK.4 | PVC em `local-path`; bancos e usuários separados por serviço, cumprindo [ADR-0009](../adr/0009-banco-por-servico.md) no nível lógico. Duas instâncias separadas custam RAM que o cluster não tem de sobra |
| **TK.6** | Redis com PVC, **não** `emptyDir` | P | TK.4 | as filas de criação de partida e de sincronização vivem em listas Redis; `emptyDir` significa perder toda partida em andamento a cada restart do pod |
| **TK.7** | Migrations como `Job` | P | TK.5, TK.3 | `Job` com `ttlSecondsAfterFinished`; API só sobe depois, por `initContainer` que espera o banco |
| **TK.8** | Deployments de `user-session` e `game-core` + Services | M | TK.7, TK.1 | `readinessProbe` em `/readyz`, `livenessProbe` em `/healthz`; 1 réplica cada por ora (ver TK.9) |
| **TK.9** | 🚦 Workers com `replicas: 1` e `strategy: Recreate` | M | TK.8 | **restrição dura, não preferência.** `game-worker` guarda as partidas num `dict` em memória e dá `LPOP` na mesma lista Redis que o orquestrador: duas réplicas simulam jogos diferentes sem coordenação, e `RollingUpdate` roda duas por alguns segundos durante todo deploy |
| **TK.10** | Ingress `pong.homelab` com WebSocket e TLS | M | TK.8 | `proxy-read-timeout` e `proxy-send-timeout` elevados — o padrão de 60 s do ingress-nginx derruba WebSocket ocioso. **Não** precisa de sessão fixa: o channel layer do Channels usa Redis, então qualquer pod atende. TLS pelo secret `pong-tls` (D7): sem certificado válido para o host, o `wss://` falha **sem tela de erro** |
| **TK.11** | `requests` e `limits` em todo workload | P | TK.8, TK.9 | conforme o orçamento em [docs/deploy/02-recursos.md](../deploy/02-recursos.md). Os apps que já existem no cluster estão com `resources: {}` — este projeto não repete isso |
| **TK.12** | 🚦 Validação ponta a ponta no cluster | M | TK.10, TK.11 | criar sala, entrar com dois navegadores, iniciar, jogar até 5 pontos, ver o resultado no ranking. Mais: matar o pod do `game-worker` no meio de uma partida e **documentar** o que acontece (hoje: a partida morre) |
| **TK.13** | Dashboard no Grafana existente | P | TK.11 | CPU, memória e restart por workload; profundidade das listas Redis. Aproveita o Grafana em `observability` |
| **TK.14** | Teste de integração k6 no repositório raiz | M | TK.12 | `k6/integration.js` atravessa os três serviços pelas imagens publicadas, entrando pelo front-end. Os checks codificam os contratos que quebraram em v2.0.1–v2.0.4 |
| **TK.15** | Gate de promoção no CI do raiz | M | TK.14 | `integration.yml` deriva a tag da imagem do pin do submodule, testa, e só então escreve nos `manifests/`. Falha se o pin não tiver tag `vX.Y.Z` |
| **TK.16** | Argo CD sincronizando `manifests/` | M | TK.15 | GitOps: o git é a única entrada para o cluster. **Sem** Image Updater, que pularia o gate de teste |

**Portão 0-K:** jogo jogável em `pong.homelab`, com recursos declarados e limitações
conhecidas e escritas. É a linha de base contra a qual cada onda seguinte é comparada.

> **O que a Onda 0-K deliberadamente não resolve:** a perda de partidas ao reiniciar o
> worker, o polling de 1 s nas filas, e a impossibilidade de escalar o worker. Esses são
> problemas de arquitetura, não de deploy — morrem nas ondas 2 e 3. O objetivo aqui é
> ter o sistema no ar com esses defeitos **documentados**, não disfarçados.

---

## Onda 1 — `stats`, o primeiro serviço Go

Escolhido por ser só leitura: se estiver errado, ninguém perde partida. Valida
toolchain, layout, sqlc, goose, observabilidade e o harness de paridade.

| ID | Tarefa | Tam | Depende | Pronto quando |
| --- | --- | --- | --- | --- |
| **T1.1** | Scaffold `services/stats` (skill `go-service`) | P | Portão 0 | critérios de aceite da skill `go-service` |
| **T1.2** | Schema + migrations das tabelas de leitura | P | T1.1 | `goose up` e `down` funcionam; projeção desenhada para responder sem JOIN entre contextos |
| **T1.3** | Portar ranking (skill `port-endpoint`) | M | T1.2, T1.5 | paridade passa; desempate determinístico adicionado nos dois lados; `Sum()` vazio devolvendo 0, não `None` |
| **T1.4** | Portar histórico de torneio | M | T1.2, T1.5 | paridade passa; `pageSize` validado com teto de 100 |
| **T1.5** | Harness de paridade `test/parity/` (skill `parity-check`) | M | T1.1 | `make parity ENDPOINT=` roda casos contra legado e novo, normaliza volátil, classifica idêntico / esperado / **inesperado** |
| **T1.6** | Migração de dados `db-game-core` → `pg:stats` | M | T1.2 | script idempotente e re-executável; contagem e soma conferem; dump do original guardado antes |
| **T1.7** | Game-Core (Django) passa a publicar `game.finished` no NATS **além** da lista Redis | M | T0.7, T0.11 | evento com `eventId` UUIDv7 e `traceId`; a lista Redis continua funcionando; ninguém age no evento novo ainda |
| **T1.8** | Projetor de `game.finished` em `stats` | M | T1.7, T1.2 | consumidor durável com ack explícito, `MaxDeliver` e DLQ; dedupe por `eventId` na mesma transação; reentrega dupla não muda o resultado |
| **T1.9** | Corte das duas rotas no gateway | P | T1.3, T1.4, T1.6, T1.8 | tráfego no Go; Django de pé; rollback = trocar rota; erro e p99 observados |
| **T1.10** | Remover as views do Django | P | T1.9 + 1 semana estável | commit separado; `expected-diffs.md` comunicado ao front |

**Portão 1:** primeiro serviço Go servindo tráfego real. Toolchain provada.

> **Dependência que surpreende:** `stats` precisa de `game.finished` para se manter
> atualizado, mas esse evento só nasce na Onda 3. Por isso T1.7 faz o **Django**
> publicar no NATS durante as ondas 1 e 2 — publicação dupla, exatamente como a skill
> `event-contract` §8 descreve.

---

## Onda 2 — `lobby`

Maior volume de regra de negócio e maior risco de comportamento.

| ID | Tarefa | Tam | Depende | Pronto quando |
| --- | --- | --- | --- | --- |
| **T2.1** | Domínio `room`: máquina de estados de 5 valores | M | Portão 1 | teste de tabela cobrindo cada transição válida e inválida; os 12 inteiros do legado mapeados para os 5 novos, com o progresso de torneio movido para `Tournament.round` |
| **T2.2** | Domínio `tournament`: porte de `createTournamentMatches` | M | T2.1 | os 3 testes de chaveamento do Python portados e passando; árvore, `nextMatch` e sorteio de posição idênticos |
| **T2.3** | Scaffold + adapters (pg, http, nats) | M | T2.1 | `go list -deps ./internal/domain` sem import de infra |
| **T2.4** | Endpoints de leitura + paridade + corte | M | T2.3, T1.5 | `GET /rooms`, `/rooms/{code}`, `/rooms/{code}/tournament` com paridade passando |
| **T2.5** | Endpoints de escrita + autorização + paridade + corte | G | T2.4 | criar, entrar, sair, remover, fechar, travar; **autorização de dono e membro onde o legado não verificava**; identidade só do token |
| **T2.6** | `lobby.match.requested` no JetStream; Django publica nos dois | M | T2.3, T0.7 | Game-Core continua consumindo a lista Redis; só um dos dois age, o outro vai para log de comparação |
| **T2.7** | Orquestrador como consumidor durável idempotente | G | T2.6, T2.2 | paridade tipo 2 (skill `parity-check`): sequência real de um torneio de 4 reproduzida, estado final idêntico, **e idêntico também reentregando cada evento duas vezes** |
| **T2.8** | WS de sala atrás do gateway | M | T2.5 | `players.changed`, `match.ready`, `game.started`; `isConnected` **funcionando** (o `disconnect` do legado não dá `await` e passa `True`) |
| **T2.9** | Composição no gateway: sala em 1 requisição | P | T2.8 | a tela de sala faz 1 chamada em vez de 3; a de torneio 1 em vez de 2 |
| **T2.10** | Remover `legacy/User-Session` | P | T2.9 + 1 semana | commit separado; lista `create-game-queue` removida |

**Portão 2:** `User-Session` fora do ar. `X-User-Id` deixa de ser aceito em qualquer lugar.

---

## Onda 3 — `game`

O gargalo do roadmap. Sem o modo de 4 jogadores (D3), a física cobre só paddles
laterais. **T3.6 e T3.8 são portões técnicos**: sem eles, não se corta nada.

| ID | Tarefa | Tam | Depende | Pronto quando |
| --- | --- | --- | --- | --- |
| **T3.1** | Capturar golden files dos 6 cenários (skill `port-game-loop` §3) | M | **D9** | `services/game/testdata/golden/*.jsonl` com RNG semeado; os 6 cenários da skill, incluindo canto, gol sem toque e bot |
| **T3.2** | `internal/domain/pong`: bola, paddle, colisão 2 jogadores | G | T3.1 | `Step` puro, determinístico, sem I/O; golden de `2p-*` passando com tolerância `1e-6` |
| **T3.4** | Domínio: gol, placar, reset, fim de jogo | M | T3.2 | inclui o ramo que pontua **todos os outros** quando não houve último toque |
| **T3.5** | Domínio: bot | M | T3.2 | função pura, não goroutine com `sleep`; golden de `1p-bot` passando |
| **T3.6** | 🚦 **Portão: golden parity nos 6 cenários** | — | T3.2, T3.4, T3.5 | todos passando; cada divergência intencional documentada no código e no PR |
| **T3.7** | `cmd/game-engine`: JetStream + lease Redis + loop 60 Hz | G | T3.6 | tick fixo com compensação; métrica de p99 do tick; zero query no caminho de `Step`; lease adquirido, renovado e liberado no shutdown |
| **T3.8** | 🚦 **Portão: teste de retomada de partida órfã** | M | T3.7 | matar o engine no meio de uma partida e outra réplica retoma pelo lease expirado. Rodar com **uma** réplica até este teste passar |
| **T3.9** | `contracts/proto/game/v1/` + geração Go e TS | M | T0.7 | `Snapshot`, `InputFrame`, `GameEvent`; placar em `GameEvent`, não em todo snapshot |
| **T3.10** | `cmd/game-api`: WS, input com `seq`, validação de slot | G | T3.9, T3.8 | input duplicado descartado; `last_ack_seq` devolvido; **slot validado contra o token** |
| **T3.11** | Corte: single-player | P | T3.10, T4.9 | chave por tipo de sala no gateway |
| **T3.12** | Corte: 1v1 | P | T3.11 | |
| **T3.14** | Corte: torneio | P | T3.12 | |
| **T3.15** | Remover `legacy/Game-Core`, channel layer e listas de input | M | T3.14 + 1 semana | Redis só com lease, presença, rate limit e cache |

**Portão 3:** Django fora do repositório. Redis rebaixado.

---

## Track Angular — em paralelo desde a Onda 1

Não depende de serviço Go nenhum, só do contrato (T0.6). Comece assim que o Portão 0
fechar e rode ao lado das ondas 1–3.

| ID | Tarefa | Tam | Depende | Pronto quando |
| --- | --- | --- | --- | --- |
| **T4.1** | `ng new web`: zoneless, strict, eslint, vitest | P | T0.6 | `provideZonelessChangeDetection()`; `strictTemplates`; `tsc --noEmit` limpo |
| **T4.2** | `core/`: api gerado, auth, `WsClient` com reconexão e backoff | M | T4.1, T0.9 | reconexão com backoff e jitter; estado como signal; fila de envio enquanto desconectado |
| **T4.3** | `lib/mat4.ts`: transcrição de `MVnew.js` (1.197 linhas) | M | T4.1 | teste comparando a saída com a versão JS para entradas conhecidas. **Transcrição literal, sem mudar a matemática** |
| **T4.4** | `lib/renderer/`: classe `PongRenderer`, sem variável global | G | T4.3 | `gPong`, `gl`, `gObjects`, `gCamera`, `gShader`, `doOnce` viram campo de instância; `dispose()` libera recurso de GL |
| **T4.5** | Feature `ranking` | P | T4.2 | primeira feature: valida o cliente gerado ponta a ponta |
| **T4.6** | Feature `lobby` | M | T4.5 | |
| **T4.7** | Feature `room` | M | T4.6, T2.9 | `roomCode` como parâmetro de rota, não `localStorage` |
| **T4.8** | Feature `tournament` | M | T4.7 | |
| **T4.9** | Feature `game`: canvas, HUD, **interpolação 30 → 60 fps** | G | T4.4, T3.9 | `rAF` sem disparar change detection; interpolação entre os dois últimos snapshots; sem interpolação o movimento fica pior que o legado |
| **T4.10** | Servir em `/next`, comparação lado a lado | P | T4.9 | as duas SPAs acessíveis ao mesmo tempo; comparação frame a frame do jogo |
| **T4.11** | Virar o padrão | P | T4.10 | rollback = trocar rota no edge |
| **T4.12** | Remover `legacy/Game-Front-End` | P | T4.11 + 1 semana | |

---

## Onda 5 — Desmonte

| ID | Tarefa | Tam | Depende | Pronto quando |
| --- | --- | --- | --- | --- |
| **T5.1** | Remover `legacy/`, containers de migration, volumes `/goinfre` | P | T3.15, T4.12 | nenhuma referência a Django ou à SPA antiga no repositório |
| **T5.2** | Atualizar o C4 em `docs/0-context/` e `docs/1-container/` | P | T5.1 | o diagrama descreve o que existe, não a intenção de 2024 |
| **T5.3** | Popular `manifests/` (hoje vazio) com o deploy alvo | M | T5.1, D5 | conforme a decisão D5 |

---

## Decisões resolvidas

| # | Decisão | Resultado | Consequência |
| --- | --- | --- | --- |
| **D3** | Manter o modo de 4 jogadores? | **Cortado do produto** (2026-09-12) | `MATCH` aceita apenas 2 jogadores. Slot vira 0 ou 1; os valores 2 e 3 ficam reservados. A física do Go cobre só paddles laterais — T3.3 (paddles em dois eixos) sai do roadmap, e os golden files caem de 8 para 6 cenários. O código de 4 jogadores no legado **não é removido**: morre junto com o `Game-Core`. Mas `get_room_type_range` em `legacy/User-Session/src/rooms/utils.py` passa a devolver `[2]` para `MATCH`, e a opção sai do formulário de criar sala — senão o deploy no cluster entrega um modo que decidimos não suportar. |
| **D7** | TLS em `pong.homelab` | **Certificado autoassinado próprio, com SAN** (2026-09-12) | Secret `pong-tls`, gerado com `subjectAltName` = `pong.homelab` e `*.homelab`, 397 dias. O `certificado-tls` de `prod` foi descartado: é `CN=homelab` **sem SAN nenhum**, e navegador ignora CN como identidade desde 2017 — não valida para host algum. cert-manager ficou de fora por ora: resolveria melhor (renovação automática, uma CA local a confiar de uma vez) mas é peça nova para operar. Fica como melhoria se o número de hosts `.homelab` crescer. |
| **D10** | Versão das imagens | **`v2.0.0` nos três serviços** (2026-09-12) | Versão única para os três, acima de todo tag existente (o máximo era `v1.1.0`) e do `v1.3.0` do produto. Marca a virada de plataforma e o início da migração, e passa a tratar os três como um deployável só — que é o que são no cluster. Tags anotadas, ao contrário das antigas. |
| **D8** | Namespace das imagens e forma de publicar | **`ghcr.io/davypaulino/*` via GitHub Actions** (2026-09-12) | Namespace pessoal porque é o que o cluster já usa (`routine-api`) e o pull secret `github-registry` já funciona para ele. Publicação por workflow em cada repositório, com smoke test antes do push. Exige o secret de organização `GHCR_TOKEN` (PAT clássico, `write:packages`): o `GITHUB_TOKEN` automático só publica pacotes do dono do repositório, que é a org. |
| **D5** | Alvo de deploy: compose ou Kubernetes | **Kubernetes** (2026-09-12) | Cluster k3s do homelab, 2 nós. Manifests em YAML puro aplicados com `kubectl`, sem Helm nem Kustomize, seguindo o padrão dos apps que já rodam lá. Nasce a **Onda 0-K**, que vem antes das ondas de migração: o legado sobe no cluster primeiro, e depois cada serviço Go substitui um Deployment. `manifests/` deixa de ser pasta vazia. Detalhe em [docs/deploy/](../deploy/). |

## Decisões abertas

| # | Decisão | Bloqueia | Contexto |
| --- | --- | --- | --- |
| **D1** | Traefik ou manter ingress-nginx no edge | T0.4 | A [arquitetura alvo](02-arquitetura-alvo.md) sugeria Traefik, mas o cluster **já tem ingress-nginx** com MetalLB e cinco Ingress em uso. Trocar o controller por causa de um projeto não se paga. Recomendação: manter ingress-nginx e atualizar o ADR. |
| **D2** | Tamanho do time e dono de cada track | calendário inteiro | Os tamanhos assumem uma pessoa por tarefa. O track Angular e o track Go rodam em paralelo **se** houver duas frentes; com uma só pessoa, o Angular vai para o fim e o roadmap fica sequencial. |
| **D4** | Predição local do próprio paddle | depois de T4.9 | Etapa opcional do modelo de rede ([ADR-0004](../adr/0004-simulacao-autoritativa.md)). Melhora a resposta percebida; adiciona reconciliação. Decidir só depois de medir a latência real com interpolação. |
| **D9** | Reaplicar ou abandonar os 6 commits de física do Game-Core | T3.1 | Ao publicar o `main`, os commits `feat: alter ball direction`, `feat: adjust game config and paddle positions` e outros 4 foram sobrescritos. Estão preservados em `resgate/main-antes-do-overwrite`. **A física de referência do golden file depende dessa escolha** — decidir antes de T3.1. |
| **D6** | Reaproveitar o Postgres existente ou subir um próprio | TK.5 | O cluster já tem `storage/homelab-database-set`. Reaproveitar economiza ~256 MiB de request e um PVC, mas acopla o projeto a um banco compartilhado com outras coisas do homelab. Os manifests atuais sobem um Postgres próprio no namespace `pong`, com dois bancos — ver [docs/deploy/02-recursos.md](../deploy/02-recursos.md). |

## Como acompanhar

A tabela de progresso em [README.md §3](README.md) é o registro oficial. Este roadmap
dá a ordem e o critério; a tabela diz onde paramos. Atualize os dois ao concluir uma
tarefa — o roadmap ganha a data de conclusão, a tabela muda de `—` para feito.

Regra que vale em toda linha acima: **introduzir o substituto e remover o legado são
commits separados**, com pelo menos uma semana de observação entre eles. É o que torna
todo corte reversível por configuração.
