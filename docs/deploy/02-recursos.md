# 02 — Estratégia de recursos

Orçamento de CPU, memória e disco por workload, e a regra de escala de cada um.
Números derivados do cluster real ([01-cluster.md](01-cluster.md)), não de chute.

## 1. O orçamento

| | Total | Em uso | Livre |
| --- | --- | --- | --- |
| CPU (requests) | 8000 m | 805 m | ~7200 m |
| **Memória (real)** | ~7,3 GiB | ~2,75 GiB | **~4,5 GiB** |
| Disco | disco local dos nós | — | conforme o nó |

**A memória é o limite.** CPU sobra. Qualquer decisão de dimensionamento neste projeto
se decide por RAM, e a meta é o stack inteiro caber em **~1,2 GiB de requests** — um
quarto do que está livre, deixando folga para o homelab crescer e para os serviços Go
conviverem com o legado durante a migração.

## 2. Legado no cluster (Onda 0-K)

| Workload | Réplicas | CPU req | CPU limit | Mem req | Mem limit | QoS |
| --- | --- | --- | --- | --- | --- | --- |
| `postgres` (1 instância, 2 bancos) | 1 | 100 m | 500 m | 256 Mi | 512 Mi | Burstable |
| `redis` | 1 | 50 m | 200 m | 64 Mi | 128 Mi | Burstable |
| `user-session` (API) | 1 | 100 m | 500 m | 192 Mi | 384 Mi | Burstable |
| `game-core` (API) | 1 | 100 m | 500 m | 192 Mi | 384 Mi | Burstable |
| `game-worker` (simulação) | **1** | 250 m | **1500 m** | 192 Mi | 384 Mi | Burstable |
| `session-worker` (orquestrador) | **1** | 50 m | 300 m | 128 Mi | 256 Mi | Burstable |
| `front-end` (nginx) | 2 | 10 m | 100 m | 16 Mi | 48 Mi | Burstable |
| **Total** | | **680 m** | 3,7 core | **1056 Mi** | 2,15 GiB | |

1,03 GiB de requests contra 4,5 GiB livres. Cabe com folga de sobra.

### Por que o `game-worker` tem limite de CPU alto

Ele roda um laço de simulação a 50 Hz por partida, em Python, com matemática de colisão
em cada tick. O limite de CPU no Kubernetes é **CFS quota**: ao estourar, o cgroup é
*throttled* — o processo simplesmente não recebe CPU até a próxima janela de 100 ms.
Num loop com requisito de tempo, isso não degrada suavemente, **piora exatamente o
defeito que o legado já tem**: o tick que desliza (o `sleep(0.02)` vem depois do
trabalho, então o passo real é 20 ms + processamento + throttle).

Por isso: `requests` generoso, para o escalonador reservar de verdade, e `limits` alto,
para nunca ser a causa do travamento. Se ele consumir mais que isso, o problema é o
código, não o limite — e a correção está na Onda 3 (tick fixo em Go).

A mesma lógica vale depois para o `game-engine` em Go, com uma diferença: lá existirá
métrica de p99 de duração do tick, então dá para ajustar com dado em vez de palpite.

### Memória do Django

192 MiB de request para um uvicorn com Django 5.1 + Channels é medida, não estimada:
o interpretador com o ORM e o channel layer carregados assenta entre 120 e 160 MiB, e
o limite de 384 MiB dá espaço para picos de serialização sem convidar o OOM killer.

Se um pod for morto por OOM, o sintoma aparece como `OOMKilled` em
`kubectl describe pod`. Aumente o **limite** e investigue; não aumente o request sem
motivo, porque request é reserva que ninguém mais pode usar.

## 3. Escala: o que pode e o que não pode

Esta é a parte que não é negociável, e é a razão de a Onda 0-K existir antes da
migração — ela expõe a restrição em vez de esconder.

| Workload | Escala? | Por quê |
| --- | --- | --- |
| `front-end` (nginx) | ✅ N réplicas | estático, sem estado |
| `user-session` (API) | ✅ N réplicas | o channel layer do Channels usa Redis, então qualquer pod atende qualquer WebSocket. **Não precisa de sessão fixa no Ingress** |
| `game-core` (API) | ✅ N réplicas | idem |
| `game-worker` | ❌ **exatamente 1** | guarda as partidas num `dict` em memória do processo **e** dá `LPOP` na lista `create-game-queue`. Duas réplicas consomem a mesma fila e simulam jogos diferentes, sem saber uma da outra. Nenhuma consegue atender o WebSocket dos jogadores da partida da outra |
| `session-worker` | ❌ **exatamente 1** | mesmo padrão na `game-sync-session-queue`: duas réplicas avançariam o chaveamento do torneio duas vezes, e os eventos não têm `eventId` para deduplicar |
| `postgres` | ❌ 1 | StatefulSet com PVC `RWO` |
| `redis` | ❌ 1 | idem, e é onde as filas vivem |

### As duas consequências operacionais

**1. Os workers usam `strategy: Recreate`, não `RollingUpdate`.**
Com `RollingUpdate`, o Kubernetes sobe o pod novo *antes* de derrubar o velho — os dois
coexistem por alguns segundos e disputam a fila em **todo deploy**. `Recreate` derruba
primeiro. O custo é uma janela de indisponibilidade a cada atualização, o que é o preço
correto a pagar aqui.

**2. Reiniciar o `game-worker` mata todas as partidas em andamento.**
Não é bug do deploy: é o estado em memória do processo (§4.3 da
[análise](../migration/01-analise-atual.md)). Em k8s isso fica mais visível, porque o
pod é reiniciado por qualquer motivo — eviction, drenagem de nó, OOM, atualização de
imagem. Escreva isso no runbook e valide na TK.12, matando o pod no meio de uma
partida para ver o comportamento real.

**Nada disso se resolve com Kubernetes.** Se resolve com o lease de partida do
`game-engine` em Go ([ADR-0004](../adr/0004-simulacao-autoritativa.md)), na Onda 3.
Até lá, a restrição é `replicas: 1` e ponto.

### Sem HPA, por enquanto

Autoscaling horizontal não faz sentido agora: os dois workloads que não podem escalar
são justamente os que ficam sob carga, e as APIs quase não consomem CPU. Depois da
Onda 3, `game-api` e `gateway` são candidatos legítimos a HPA por CPU.

## 4. Armazenamento

| PVC | Tamanho | StorageClass | Perder isso significa |
| --- | --- | --- | --- |
| `postgres-data` | 5 Gi | `local-path` | perder salas, torneios, histórico e ranking |
| `redis-data` | 1 Gi | `local-path` | perder as partidas em criação e os eventos não consumidos |

5 GiB para o Postgres é exagero confortável: o volume real de dados é de salas
efêmeras e histórico de partidas — dezenas de MiB por muito tempo. Sobra vale mais que
redimensionar (`local-path` **não** suporta `allowVolumeExpansion`).

**Redis com PVC, não `emptyDir`.** As filas de criação de partida e de sincronização de
torneio vivem em listas Redis. `emptyDir` garante perda total a cada restart do pod.
Com PVC e `appendonly yes`, a perda cai para o que não foi ao disco. Não é durabilidade
de verdade — é reduzir a janela até o NATS entrar na Onda 2.

`local-path` tem reclaim `Delete`: **apagar o PVC apaga os dados.** `kubectl delete pvc`
no namespace `pong` é operação destrutiva, e está na lista de coisas que exigem
confirmação.

## 5. Serviços Go, quando chegarem

Um binário Go substituindo um processo Django cai de ~150 MiB para ~20-30 MiB de
memória residente. Projeção para o estado final:

| Workload | Réplicas | CPU req | Mem req | Mem limit |
| --- | --- | --- | --- | --- |
| `gateway` | 2 | 50 m | 32 Mi | 96 Mi |
| `lobby` | 2 | 50 m | 48 Mi | 128 Mi |
| `stats` | 1 | 25 m | 32 Mi | 96 Mi |
| `game-api` | 2 | 50 m | 48 Mi | 128 Mi |
| `game-engine` | **2+** | 250 m | 64 Mi | 192 Mi |
| `nats` | 1 | 50 m | 64 Mi | 128 Mi |
| `postgres` | 1 | 100 m | 256 Mi | 512 Mi |
| `redis` | 1 | 50 m | 64 Mi | 128 Mi |
| `web` (nginx) | 2 | 10 m | 16 Mi | 48 Mi |
| **Total** | | ~810 m | **~700 Mi** | ~1,6 GiB |

Menos memória que o legado, **com o dobro de réplicas e duas peças novas** (NATS,
gateway). E o `game-engine` passa a ter `replicas: 2+` de verdade, porque o lease
resolve a posse da partida — é o ganho concreto da Onda 3, expresso em manifest.

Durante a migração os dois convivem: some os dois totais (~1,7 GiB de requests) e
confirme contra o livre antes de cada onda. Cabe.

## 6. Como revisar estes números

Não confie na tabela indefinidamente. Depois de uma semana no ar:

```sh
kubectl top pods -n pong --containers      # consumo real
kubectl describe node nami | grep -A 8 "Allocated resources"
kubectl get events -n pong --field-selector reason=OOMKilling
```

Regra de ajuste: **request ≈ p50 do uso real; limit ≈ 2× o pico observado.** Request
muito acima do uso desperdiça reserva que ninguém pode usar; limit muito baixo troca
degradação por morte do processo.
