# 03 — Subir o legado no Kubernetes

Passo a passo da **Onda 0-K**: o sistema Django atual rodando em `pong.homelab`.
Tarefas e critérios de pronto em [../migration/06-roadmap.md](../migration/06-roadmap.md).
Manifests em [`manifests/`](../../manifests/).

> **Toda ação de escrita no cluster pede confirmação.** Os comandos aqui documentam o
> procedimento; não são convite a aplicar sem avisar.

## Por que o legado primeiro, e não Go direto

Porque separa dois problemas que, juntos, ficam impossíveis de depurar. Subir o legado
prova a plataforma — imagem, secret, PVC, Ingress, WebSocket atravessando o
ingress-nginx, sonda, orçamento de memória — com um sistema cujo comportamento já é
conhecido. Depois disso, cada serviço Go é um Deployment novo substituindo um antigo, e
quando algo quebra a pergunta é "o que o Go faz diferente", não "é o Go ou é o k8s".

Além disso: `kubectl rollout undo` passa a ser o rollback de cada onda da migração.

## O bloqueio duro: não existe imagem

Este é o único trabalho de verdade da onda. O resto é YAML.

Os serviços Python **não têm `Dockerfile`**. O `docker-compose.yml` usa a imagem
`python:3.11` e roda `pip install -r requirements.txt` no `command`, com o código vindo
de um bind mount em `/goinfre/...`. Em Kubernetes isso não tem equivalente: não há bind
mount do código, e instalar dependência a cada start de pod é lento e não determinístico.

Os `Dockerfile` foram criados em `User-Session/`, `Game-Core/` e `Game-Front-End/`,
e **os três constroem** (verificado com podman 6.1.0):

| Imagem | Tamanho |
| --- | --- |
| `pong-front-end` | 50,2 MB |
| `pong-game-core` | 208 MB |
| `pong-user-session` | 236 MB |

Quatro pontos de desenho:

1. **Multi-stage.** `psycopg2` (não `-binary`) compila do fonte e precisa de `gcc` e
   `libpq-dev`. Ambos ficam no estágio de build; a imagem final leva só `libpq5`.
2. **Um serviço, uma imagem, dois workloads.** `pong-user-session` serve a API e o
   worker orquestrador; `pong-game-core` serve a API e o worker de simulação. Quem
   decide é o `command` do Deployment. Menos imagem para construir e versionar.
3. **Os estáticos vão dentro da imagem do front-end**, e o nginx do pod não termina TLS
   nem faz proxy — isso é do Ingress agora.
4. **Nome de imagem base qualificado** (`docker.io/library/python:3.11-slim`). O podman
   não resolve nome curto sem `containers-registries.conf`; o nome completo funciona nos
   dois runtimes.

Duas coisas que o build revelou e já estão corrigidas:

- **`build-essential`, não `gcc`.** Só `gcc` falha ao compilar `psycopg2` com
  `fatal error: stdlib.h: No such file or directory` — faltam os headers da libc.
- **`try_files $uri $uri/ =404`, não fallback para `/index.html`.** O roteador da SPA
  legada nunca muda a URL e busca os parciais por caminho real, então o fallback só
  mascararia asset ausente: um `.js` faltando voltaria 200 com HTML dentro, e o erro
  apareceria como falha de parse de JavaScript. A SPA Angular da Onda 4 usa rota real e
  vai precisar do fallback — lembre de mudar lá.

### Publicação: GitHub Actions

Cada repositório tem `.github/workflows/image.yml`. O workflow constrói, roda um
**smoke test** e só então publica — imagem que não passa no teste não chega ao registry.

| Verificação | Onde |
| --- | --- |
| roda como uid 10001 (non-root) | ambos os Python |
| `manage.py check` passa | ambos os Python |
| `django`, `psycopg2`, `channels`, `uvicorn` importam | ambos os Python |
| `index.html` e `assets/js/Enums.js` na imagem | front-end |
| serve 200 em `/`, `/healthz` e asset; **404** em caminho inexistente | front-end |

Tags geradas: `v0.1.0` e `0.1.0` (de tag git `v0.1.0`), o SHA curto, e `main` no
branch padrão. **Nunca `latest`.** O `{{raw}}` preserva o `v` do tag git, que é a forma
usada nos manifests.

Pré-requisito único: o secret **`GHCR_TOKEN`** — PAT clássico com escopo
`write:packages`, criado em Settings → Secrets and variables → Actions **da
organização**, para os três repositórios compartilharem um só.

> Por que um PAT e não o `GITHUB_TOKEN` automático: ele só publica pacotes do **dono do
> repositório**, ou seja em `ghcr.io/meia-noite-eu-te-conto/*`. As imagens vão para
> `ghcr.io/davypaulino/*`, que é o namespace que o cluster já usa e para o qual o pull
> secret `github-registry` já funciona. O token fica só no GitHub — não passa por
> arquivo, por linha de comando nem por conversa.

Publicado em 2026-09-12 como **`v2.0.0`** nos três repositórios — a versão que marca a
virada de plataforma (imagem versionada em registry, deploy em Kubernetes) e o ponto de
partida da migração para Go.

Para a próxima versão, em cada repositório:

```sh
git tag -a v2.1.0 -m "..." && git push origin v2.1.0
```

Tag anotada, não leve: carrega autor, data e mensagem. As tags antigas dos repos
(`v1.0.0`, `v1.1.0`) são leves, de antes desta convenção.

### Build local, para depurar

```sh
podman build -t pong-user-session:dev ./User-Session
podman build -t pong-game-core:dev    ./Game-Core
podman build -t pong-front-end:dev    ./Game-Front-End

podman run --rm pong-game-core:dev python manage.py check
podman run --rm pong-user-session:dev id   # precisa ser uid 10001
```

`manage.py check` passa sem banco e pega erro de configuração do Django.

**Tag versionada, nunca `latest`.** Com `imagePullPolicy: IfNotPresent` — o padrão para
tag que não é `latest` — `latest` faz o nó rodar a imagem velha em cache sem avisar.

## Ordem de execução

### 1. Segredos (T0.1 e TK.4)

Faça isto antes de tudo, e trate como pré-requisito, não como etapa.

`.env` está commitado com as senhas do Postgres, e `SECRET_KEY` está **fixo** no
`settings.py` dos dois serviços. Se o repositório é ou já foi público, todos esses
valores estão vazados.

```sh
git rm --cached .env && echo ".env.local" >> .gitignore
# gere valores novos; os antigos são descartados
```

Para o Secret do Django ter efeito, `settings.py` precisa passar a ler
`SECRET_KEY` do ambiente — hoje o valor é literal no código. É uma linha em cada
serviço, e é o que torna o deploy configurável.

```sh
kubectl create secret generic pong-secrets -n pong \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=USER_SESSION_DB_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=GAME_CORE_DB_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=USER_SESSION_SECRET_KEY="$(openssl rand -base64 48)" \
  --from-literal=GAME_CORE_SECRET_KEY="$(openssl rand -base64 48)"
```

Secret é **namespaced**: `github-registry` existe só em `prod` e precisa ser copiado
para `pong`. O comando está em `manifests/02-secret.example.yaml`.

### 2. Saúde (TK.1)

O legado **não tem endpoint de saúde**. Sem isso, sonda HTTP é impossível, e os
manifests caem para `tcpSocket` — que prova apenas que a porta abriu, não que o Django
fala com o banco.

Adicione em cada serviço:

- `GET /healthz` → 200 fixo, sem tocar em nada. É o `livenessProbe`: responde se o
  processo está vivo.
- `GET /readyz` → toca Postgres e Redis. É o `readinessProbe`: responde se o pod pode
  receber tráfego.

Separar os dois importa: se o `livenessProbe` tocasse o banco, uma indisponibilidade do
Postgres reiniciaria todos os pods da API em laço, transformando uma falha de
dependência numa falha de cascata.

Depois disso, troque as sondas nos manifests pelas versões HTTP que estão comentadas.

### 3. Aplicar

Faixa por faixa, conferindo entre uma e outra. O procedimento completo está no
[README dos manifests](../../manifests/README.md).

```sh
kubectl apply -f manifests/ --dry-run=server     # valida tudo antes
```

Ordem: namespace → secrets (à mão) → configmap → postgres e redis → jobs de migration →
APIs → workers e front-end → ingress.

### 4. Validar (TK.12)

Não é "os pods estão Running". É **jogar**:

1. `pong.homelab` abre a home.
2. Criar sala 1v1; entrar com um segundo navegador.
3. Iniciar a partida — o `game-worker` precisa consumir a fila e avisar os dois.
4. Jogar até 5 pontos; o resultado aparece no ranking.
5. Criar torneio com 4 inscritos e avançar uma rodada.

Depois, o teste que interessa:

```sh
kubectl delete pod -n pong -l app=game-worker    # pede confirmação
```

Mate o worker **no meio de uma partida** e observe. A partida morre — o estado está num
`dict` em memória do processo. **Documente o comportamento observado no runbook.** O
objetivo da onda é ter o sistema no ar com esse defeito conhecido e escrito, não
disfarçado.

## Armadilhas deste cluster

Cada uma já custou tempo de alguém:

| Armadilha | Sintoma | O que fazer |
| --- | --- | --- |
| `rewrite-target: /` no Ingress (o `routine-ingress` usa) | 404 em toda chamada de API | não use. O Django precisa do caminho completo (`/api/v1/user-session/rooms/`) |
| Timeout padrão do ingress-nginx | WebSocket cai em ~60 s de ociosidade | `proxy-read-timeout` e `proxy-send-timeout` altos — já nos manifests |
| `github-registry` só existe em `prod` | `ImagePullBackOff` | secret é namespaced; copie para `pong` |
| `local-path` + `WaitForFirstConsumer` | PVC `Pending` até o pod agendar | normal, resolve sozinho. Mas o PVC **amarra o pod ao nó** — drenar aquele nó é indisponibilidade |
| `local-path` com reclaim `Delete` | dados do Postgres desaparecem | `kubectl delete pvc -n pong` é destrutivo |
| Aplicar `02-secret.example.yaml` | senhas viram `TROCAR`, pods em `CrashLoopBackOff` | nunca inclua num `apply -f manifests/` |
| `RollingUpdate` nos workers | duas réplicas disputam a fila em todo deploy | `strategy: Recreate`, `replicas: 1` |
| `maxmemory-policy allkeys-lru` no Redis | partidas desaparecem sob pressão de memória | `noeviction` — evict aqui apaga fila de partida |
| Sessão fixa no Ingress "para WebSocket" | complexidade sem motivo | não precisa: o channel layer do Channels usa Redis, qualquer pod atende |

## O que fica pendente depois do Portão 0-K

Nenhum destes se resolve com Kubernetes:

- **TLS** ([decisão D7](../migration/06-roadmap.md#decisões-abertas)). O jogo usa
  `wss://`, então não é opcional. Não há cert-manager no cluster.
- **Sem autenticação.** Identidade é um UUID em `localStorage` enviado em `X-User-Id`.
  Expor `pong.homelab` fora da rede local expõe isso também. Resolve na Onda 0 (T0.9).
- **Partida morre com o worker.** Resolve o lease do `game-engine`, Onda 3.
- **Até 1 s de latência** por salto de fluxo. Resolve o NATS, Onda 2.
- **Worker não escala.** Resolve o lease, Onda 3.
- **Sem métrica.** Não há Prometheus; só `kubectl top`. O dashboard da TK.13 no Grafana
  existente é o mínimo viável.
