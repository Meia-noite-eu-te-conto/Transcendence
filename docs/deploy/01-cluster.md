# 01 — O cluster

Levantado por inspeção em 2026-09-12. Reconfirme com a skill `k8s-validate` antes de
confiar nestes números — cluster é coisa viva.

## Acesso

```sh
export PATH="/run/host/usr/local/bin:/run/host/usr/bin:$PATH"
kubectl config current-context   # default
```

No sandbox Flatpak do VS Code o `kubectl` do host **não** está no `PATH`; ele vive em
`/run/host/usr/local/bin/kubectl`. `helm` está em `/run/host/usr/bin/helm`, mas não
usamos Helm aqui. Kubeconfig em `~/.kube/config`.

## Topologia

| Nó | Papel | IP | CPU | RAM | Em uso (no levantamento) |
| --- | --- | --- | --- | --- | --- |
| `nami` | control-plane | 192.168.15.9 | 4 | 3,63 GiB | 153 m · **1938 MiB (52%)** |
| `luffy` | worker | 192.168.15.7 | 4 | 3,72 GiB | 105 m · 870 MiB (22%) |

k3s v1.36.2, containerd 2.3.2, Debian 13, amd64. `metrics-server` funciona
(`kubectl top`).

**A memória é o recurso escasso, não a CPU.** São 8 vCPU contra ~7,3 GiB de RAM, e
`nami` já opera na metade. Todo dimensionamento neste projeto parte daí.

## Rede

- **ingress-nginx** (`ingressClassName: nginx`), controller como `LoadBalancer` em
  **192.168.15.180**. O Traefik que vem com o k3s não está em uso.
- **MetalLB**, pool `homelab-pool` = `192.168.15.180-199`, `autoAssign: true`.
  Em uso: `.180` (ingress) e `.190` (pihole-dns). Livres: `.181-.189`, `.191-.199`.
- Convenção de hostname: **`<app>.homelab`**. Já existem `annotate.homelab`,
  `pihole.homelab`, `grafana.homelab`, `routine.homelab`, `pgadmin.homelab`.
  Resolução via Pi-hole no próprio cluster.

**Não há cert-manager.** O único Ingress com TLS (`prod/routine-ingress`) usa um secret
manual chamado `certificado-tls`. Isso é [decisão D7](../migration/06-roadmap.md#decisões-abertas) —
e importa, porque o jogo usa `wss://`.

## Armazenamento

| StorageClass | Provisioner | Reclaim | Binding | Observação |
| --- | --- | --- | --- | --- |
| `local-path` (default) | `rancher.io/local-path` | `Delete` | `WaitForFirstConsumer` | disco local do nó |
| `local-storage` | manual | `Retain` | — | PV estático `homelab.volume`, 20 GiB |

Consequência de `local-path` + `WaitForFirstConsumer`: **o PVC amarra o pod ao nó** onde
o volume foi criado. Um pod com PVC não migra para o outro nó, e drenar esse nó
significa indisponibilidade. Aceitável num homelab; precisa estar escrito.

`Delete` como reclaim policy significa que apagar o PVC **apaga os dados**. Para o
Postgres do projeto, isso é um pé na porta — trate `kubectl delete pvc` no namespace
`pong` como operação destrutiva.

## O que já roda no cluster

| Namespace | Workload | Detalhe |
| --- | --- | --- |
| `storage` | `homelab-database-set` (StatefulSet) | postgres:16-alpine, svc headless `homelab-database:5432`, secret `homelab.database`, PV 20 GiB `Retain`, 100 m/256 MiB → 500 m/512 MiB |
| `storage` | `pgadmin` | `pgadmin.homelab` |
| `observability` | `grafana` | `grafana.homelab`, ClusterIP:80. **2950 restarts** — tem problema próprio, alheio a este projeto |
| `networking` | `pihole` | DNS em `192.168.15.190`, `pihole.homelab` |
| `prod` | `routine-api` | 2 réplicas, `routine.homelab` com TLS |
| `docs` | `annotate` | `annotate.homelab` |
| `ingress-nginx`, `metallb-system`, `kube-system` | infraestrutura | |

**Não há Prometheus nem Prometheus Operator** (sem CRD `ServiceMonitor`). Métrica hoje
é só `kubectl top`. O Grafana existe, mas sem datasource de métrica do cluster.

## Convenções a seguir

Extraídas dos apps que já rodam lá. Siga, não invente:

1. **Imagens em `ghcr.io/davypaulino/<app>:<tag>`** com
   `imagePullSecrets: [{name: github-registry}]`. **Não há registry no cluster** e não
   há `registries.yaml` no k3s — a imagem tem que estar publicada em algum lugar que o
   containerd alcance.
2. **Namespace por domínio.** Este projeto usa `pong`.
3. **Service `ClusterIP` headless** (`clusterIP: None`) na porta 80 para apps HTTP,
   com o Ingress apontando para ela.
4. **`readinessProbe` HTTP** em um path de saúde.
5. **YAML puro**, `kubectl apply -f`. Sem Helm, sem Kustomize.
6. Label `app: <nome>` como seletor.

## O que este projeto faz diferente, de propósito

- **`requests` e `limits` declarados.** Todo Deployment que já existe no cluster está
  com `resources: {}` — QoS `BestEffort`, ou seja, primeiro candidato ao OOM killer e
  nenhuma reserva no escalonador. Com `nami` a 52% de memória, isso é dívida esperando
  para cobrar. Ver [02-recursos.md](02-recursos.md).
- **`livenessProbe` além do `readinessProbe`.** Os apps atuais só têm readiness; um
  processo travado sem morrer fica servindo erro para sempre.
- **Tag de imagem versionada, nunca `latest`.** `imagePullPolicy: IfNotPresent` com
  `latest` é a receita para rodar imagem velha sem saber.
