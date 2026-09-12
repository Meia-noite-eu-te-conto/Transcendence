# Deploy

O alvo de deploy é o **cluster k3s do homelab** ([decisão D5](../migration/06-roadmap.md#decisões-resolvidas)).
Manifests em YAML puro, aplicados com `kubectl`, em [`manifests/`](../../manifests/).

| Documento | Conteúdo |
| --- | --- |
| [01-cluster.md](01-cluster.md) | fatos e convenções do cluster; o que já existe lá |
| [02-recursos.md](02-recursos.md) | orçamento de CPU, memória e disco; escala por workload |
| [03-legado-no-k8s.md](03-legado-no-k8s.md) | passo a passo para subir o Django no cluster |

Tarefas e critérios de pronto: **Onda 0-K** em [../migration/06-roadmap.md](../migration/06-roadmap.md).

## Regra de operação

**Ação de escrita no cluster só com confirmação explícita.** `apply`, `delete`,
`patch`, `scale`, `rollout`, `exec`, `port-forward` — todos pedem o "ok" antes.
Leitura (`get`, `describe`, `logs`, `top`, `diff`, `--dry-run=client`) é livre.

O cluster hospeda coisas em uso que não têm relação com este projeto (Grafana,
Pi-hole, pgAdmin, um Postgres com PV `Retain`, `routine-api`). Errar um `apply` de
namespace afeta serviço alheio.

Ver a skill `k8s-validate` para o fluxo de validação antes de aplicar.
