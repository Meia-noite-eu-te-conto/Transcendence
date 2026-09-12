---
name: k8s-validate
description: Inspeciona e valida workloads no cluster k3s do homelab com kubectl — descoberta, validação de manifest antes de aplicar, e diagnóstico de pod que não sobe. Use ao mexer em manifests/, ao verificar o estado do deploy, ou ao investigar CrashLoopBackOff, Pending, OOMKilled e afins.
---

# Validar no cluster

## Regra número um

**Ação de escrita só com confirmação explícita do usuário.** Monte o comando, mostre o
que ele faz, espere o "ok".

| Livre | Pede confirmação |
| --- | --- |
| `get`, `describe`, `logs`, `top`, `events` | `apply`, `create`, `replace`, `patch` |
| `explain`, `api-resources`, `version` | `delete`, `scale`, `rollout` |
| `diff`, `apply --dry-run=client` | `exec`, `port-forward`, `cp` |
| `auth can-i` | `drain`, `cordon`, `taint`, `label`, `annotate` |

O cluster é o homelab de produção do usuário e hospeda coisas sem relação com este
projeto: Grafana, Pi-hole, pgAdmin, um Postgres com PV `Retain` e `routine-api`. Um
`apply` no namespace errado afeta serviço alheio.

`kubectl delete pvc -n pong` é **destrutivo**: a StorageClass `local-path` tem reclaim
`Delete`, então apagar o PVC apaga os dados do Postgres.

## Acesso

```sh
export PATH="/run/host/usr/local/bin:/run/host/usr/bin:$PATH"
```

No sandbox Flatpak do VS Code o `kubectl` do host não está no `PATH` — ele vive em
`/run/host/usr/local/bin/kubectl`. **Exporte o `PATH` em toda invocação de Bash**, já
que o shell não guarda estado entre chamadas. Kubeconfig em `~/.kube/config`,
contexto `default`.

Se `kubectl: command not found`, o `PATH` não foi exportado — não é o cluster fora do ar.

### Ferramentas que precisam do host de verdade

`kubectl` funciona pelo `PATH` acima porque é binário Go estático. **`podman` não** —
ele depende de bibliotecas compartilhadas do host e falha com
`error while loading shared libraries: libsubid.so.6`. Para ele, use o mecanismo do
Flatpak:

```sh
flatpak-spawn --host podman build -t <tag> <contexto>
flatpak-spawn --host podman images
```

Duas consequências de o comando rodar no **host**, não no sandbox:

- caminhos precisam existir no host. O diretório de scratchpad do agente **não** existe
  lá; use caminhos sob `/home/dapaulin/`;
- porta publicada com `-p` não fica alcançável a partir do sandbox. Para testar HTTP
  num container, faça a requisição **de dentro dele**:
  `flatpak-spawn --host podman exec <c> wget -q -S -O /dev/null http://127.0.0.1/path`.

## O cluster, em uma tela

Fatos completos em [docs/deploy/01-cluster.md](../../../docs/deploy/01-cluster.md).
O mínimo para não errar manifest:

| | |
| --- | --- |
| k3s | v1.36.2, 2 nós: `nami` (control-plane), `luffy` (worker), 4 vCPU / ~3,7 GiB cada |
| Recurso escasso | **memória** — `nami` já opera a ~52% |
| Ingress | `ingressClassName: nginx` (ingress-nginx), controller em `192.168.15.180` |
| Hostname | `<app>.homelab` |
| StorageClass | `local-path` (default, `Delete`, `WaitForFirstConsumer`) |
| Imagens | `ghcr.io/davypaulino/<app>:<tag>` + `imagePullSecrets: github-registry` |
| Não existe | cert-manager, Prometheus, registry no cluster |
| Existe | `metrics-server` (`kubectl top`), Grafana em `observability` |

Cluster é coisa viva: **reconfirme antes de confiar** nesses números.

```sh
kubectl get nodes -o wide
kubectl top nodes
kubectl get storageclass,ingressclass
kubectl describe node nami | grep -A 8 "Allocated resources"
```

## Validar manifest antes de aplicar

Nesta ordem, e as três primeiras não tocam no cluster:

```sh
# 1. sintaxe e schema (client-side)
kubectl apply -f manifests/ --dry-run=client

# 2. validação no servidor, sem persistir — pega admission e campo inválido
kubectl apply -f manifests/ --dry-run=server

# 3. o que mudaria em relação ao que está aplicado
kubectl diff -f manifests/

# 4. o orçamento cabe? some os requests e compare com o livre
kubectl describe node nami luffy | grep -A 8 "Allocated resources"
```

`manifests/02-secret.example.yaml` é template com `TROCAR` nos valores.
**Nunca** o inclua num `apply -f manifests/` — sobrescreve o secret real.

Checklist antes de propor o `apply`:
- [ ] `--dry-run=server` limpo
- [ ] `requests`/`limits` presentes em todo container (inclusive `initContainers`)
- [ ] tag de imagem versionada, nunca `latest`
- [ ] `imagePullSecrets` presente, e o secret existe **no namespace** (secret é namespaced)
- [ ] `storageClassName: local-path` nos PVC
- [ ] `ingressClassName: nginx`, e **sem** `rewrite-target` (o Django precisa do caminho completo)
- [ ] workload singleton com `replicas: 1` **e** `strategy: Recreate`
- [ ] soma dos requests cabe no que está livre

## Diagnosticar

Comece sempre pelo estado geral, depois estreite:

```sh
kubectl get pods -n pong -o wide
kubectl get events -n pong --sort-by=.lastTimestamp | tail -25
```

| Sintoma | Onde olhar | Causa comum neste cluster |
| --- | --- | --- |
| `Pending` | `kubectl describe pod` → Events | sem memória em nenhum nó; ou PVC com `WaitForFirstConsumer` esperando o pod, que espera o PVC (normal, resolve sozinho) |
| `ImagePullBackOff` | `describe pod` | imagem não publicada no ghcr.io, ou `github-registry` ausente **neste** namespace |
| `CrashLoopBackOff` | `kubectl logs -n pong <pod> --previous` | config faltando; banco ainda não pronto; `SECRET_KEY` não vindo do Secret |
| `OOMKilled` | `describe pod` → Last State | limite de memória baixo. Suba o **limit**, investigue; não suba o request sem motivo |
| `Running` mas não `Ready` | `describe pod` → probe | sonda apontando para path que não existe (o legado não tem `/healthz` até a TK.1) |
| 404 em tudo pelo Ingress | `kubectl describe ingress -n pong` | `rewrite-target: /` — o Django precisa do caminho completo |
| WebSocket cai em ~60 s | annotations do Ingress | `proxy-read-timeout` / `proxy-send-timeout` no padrão |
| Partidas somem | `kubectl get pods -n pong` (RESTARTS) | o `game-worker` reiniciou. **Comportamento esperado do legado**, não bug de deploy |

Logs úteis:

```sh
kubectl logs -n pong deploy/game-worker -f --tail=100
kubectl logs -n pong deploy/user-session --all-containers --since=10m
kubectl logs -n ingress-nginx deploy/ingress-nginx-controller --tail=50   # 404, upgrade de WS
```

## Verificar recurso real

```sh
kubectl top pods -n pong --containers
kubectl get events -n pong --field-selector reason=OOMKilling
```

Regra de ajuste: **request ≈ p50 do uso real; limit ≈ 2× o pico observado.**
Orçamento e justificativa em [docs/deploy/02-recursos.md](../../../docs/deploy/02-recursos.md).

## Verificar as filas do legado

O sinal mais útil sobre a saúde do jogo não é probe nenhuma — é a profundidade das
listas Redis. Fila crescendo significa worker parado ou travado.

Precisa de `exec`, então **peça confirmação**:

```sh
kubectl exec -n pong sts/redis -- redis-cli llen create-game-queue
kubectl exec -n pong sts/redis -- redis-cli llen game-sync-session-queue
```

## Ao terminar

Reporte: o comando que rodou, a saída relevante (não o dump inteiro), o que concluiu,
e — se propõe uma ação de escrita — o comando exato e o que ele muda. Se não conseguiu
verificar algo, diga que não conseguiu em vez de inferir.
