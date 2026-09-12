# manifests

Deploy do **legado** (Django + SPA em JS) no cluster k3s do homelab — Onda 0-K do
roadmap. YAML puro, aplicado com `kubectl`, sem Helm e sem Kustomize, seguindo o padrão
dos apps que já rodam no cluster.

Contexto: [docs/deploy/](../docs/deploy/) · Tarefas: [Onda 0-K](../docs/migration/06-roadmap.md)

> **Ação de escrita no cluster só com confirmação.** Os comandos `apply` abaixo estão
> aqui como documentação do procedimento, não como convite a rodar sem avisar.
> Ver a skill `k8s-validate`.

## Antes de aplicar: três pré-requisitos

Estes manifests **não funcionam** sem eles. Não é opcional, é bloqueio:

1. **As imagens precisam existir.** Os `Dockerfile` e os workflows de publicação já
   estão prontos nos três repositórios, e as imagens constroem. Falta publicar: crie o
   secret de organização `GHCR_TOKEN` (PAT clássico com `write:packages`) e empurre um
   tag `v0.1.0` em cada repositório. Isso produz
   `ghcr.io/davypaulino/pong-{user-session,game-core,front-end}:v0.1.0`.
2. **O secret de pull.** `github-registry` existe só no namespace `prod`; secret é
   namespaced. Copie para `pong` — o comando está em `02-secret.example.yaml`.
3. **`pong-secrets`.** Criado à mão a partir do `.env.local`, com senhas e `SECRET_KEY`
   **novas**. Ver `02-secret.example.yaml`.

Além disso, `SECRET_KEY` hoje está fixo no `settings.py` dos dois serviços — precisa
passar a ser lido do ambiente para o Secret ter efeito.

## Ordem de aplicação

O prefixo numérico é a ordem. Dentro de cada faixa, a ordem não importa.

| Arquivo | O que cria |
| --- | --- |
| `00-namespace.yaml` | namespace `pong` |
| `01-configmap.yaml` | config dos serviços + `nginx.conf` do front-end |
| `02-secret.example.yaml` | **template** — não aplique; crie o secret pelo comando de dentro |
| `10-postgres.yaml` | StatefulSet, PVC 5 Gi, script de init com os 2 bancos |
| `11-redis.yaml` | StatefulSet, PVC 1 Gi, `appendonly` |
| `20-migrations.yaml` | 2 `Job` de `manage.py migrate` |
| `30-user-session.yaml` | Deployment + Service :8002 |
| `31-game-core.yaml` | Deployment + Service :8001 |
| `40-workers.yaml` | `game-worker` e `session-worker` — **singletons** |
| `50-front-end.yaml` | Deployment (2 réplicas) + Service :80 |
| `60-ingress.yaml` | `pong.homelab`, roteamento por caminho |

```sh
export PATH="/run/host/usr/local/bin:$PATH"

# 1. validar sem tocar no cluster
kubectl apply -f manifests/ --dry-run=client

# 2. ver o que mudaria (precisa do namespace já existir)
kubectl diff -f manifests/

# 3. aplicar por faixa, conferindo entre uma e outra
kubectl apply -f manifests/00-namespace.yaml
#    ... criar pong-secrets e copiar github-registry aqui ...
kubectl apply -f manifests/01-configmap.yaml
kubectl apply -f manifests/10-postgres.yaml -f manifests/11-redis.yaml
kubectl -n pong rollout status statefulset/postgres
kubectl apply -f manifests/20-migrations.yaml
kubectl -n pong wait --for=condition=complete job/migrate-user-session --timeout=300s
kubectl apply -f manifests/30-user-session.yaml -f manifests/31-game-core.yaml
kubectl apply -f manifests/40-workers.yaml -f manifests/50-front-end.yaml
kubectl apply -f manifests/60-ingress.yaml
```

`02-secret.example.yaml` não entra em `kubectl apply -f manifests/` — mova-o para fora
ou aplique arquivo por arquivo. Aplicá-lo sobrescreve o secret real com `TROCAR`.

## O que este deploy deliberadamente não resolve

Estão aqui para ficarem **documentados**, não disfarçados. Morrem nas ondas 2 e 3:

- **Reiniciar `game-worker` mata as partidas em andamento.** Estado em memória do
  processo. Kubernetes reinicia pod por qualquer motivo — eviction, drenagem, OOM,
  deploy.
- **Os workers não escalam.** `replicas: 1` é restrição, não configuração. Ver o
  comentário no topo de `40-workers.yaml`.
- **Até 1 s de latência** na criação de partida e no avanço de chaveamento: os
  consumidores fazem `sleep(1)` antes de cada `LPOP`.
- **Perder o pod do Redis** perde as filas. `appendonly` reduz a janela; não elimina.
- **Não há autenticação.** Identidade é um UUID em `localStorage` mandado em
  `X-User-Id`. Expor `pong.homelab` fora da rede local expõe isso também.

## Próximos passos depois do Portão 0-K

1. Trocar as sondas TCP por HTTP em `/readyz` (TK.1) — TCP só prova que a porta abriu.
2. Dashboard no Grafana de `observability`: CPU, memória, restart e profundidade das
   filas Redis (TK.13).
3. Resolver D7 (TLS) — sem isso o `wss://` não sobe.
4. Começar a Onda 1: `services/stats` em Go substitui as rotas de ranking e histórico,
   e o deploy passa a ser um Deployment novo ao lado destes.
