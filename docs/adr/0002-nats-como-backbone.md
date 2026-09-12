# ADR-0002 — NATS JetStream como backbone de eventos; Redis rebaixado a cache

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
Hoje o Redis faz três trabalhos: channel layer do Channels (pub/sub efêmero para
fanout de WebSocket), fila de trabalho (listas com `RPUSH`/`LPOP`) e buffer de input
por jogador. A fila é o problema: uma lista Redis não tem ack, retry, dead-letter nem
visibilidade. Se o `game-worker` cai entre o `LPOP` e o `create_task`, a partida
desaparece sem rastro. E como não há entrega push, os dois consumidores fazem
`await asyncio.sleep(1)` antes de cada `LPOP`, colocando até 1 s de latência em cada
salto do fluxo de criação de partida e de avanço de chaveamento.

O C4 em `docs/1-container/` documenta RabbitMQ. O código nunca usou RabbitMQ.

O sistema precisa de **dois padrões de mensageria diferentes**: entrega durável com
ack para eventos de domínio, e pub/sub efêmero de baixa latência para snapshots de
jogo a 30 Hz por partida.

## Decisão
NATS para os dois. **JetStream** para eventos de domínio (streams duráveis,
consumidor com ack explícito, redelivery, DLQ, replay). **NATS core** para o fanout de
snapshots (`game.{id}.snapshot`), substituindo o channel layer.

Redis continua, mas só para o que Redis faz bem: lease de partida (`SET NX PX`),
presença, rate limit e cache. **Deixa de ser fila.**

## Consequências
**A favor.** Uma tecnologia de mensageria cobre os dois padrões — RabbitMQ resolveria
a fila mas não o fanout de 30 Hz, o que deixaria o channel layer do Redis em paralelo.
Ack explícito elimina a perda silenciosa de partida. Entrega push elimina o polling de
1 s. Consumidor durável dá replay, que é a base do teste de paridade e da reconstrução
do read model de `stats`. Servidor é um binário de ~15 MB, sem ZooKeeper, sem Erlang;
o cliente Go é de primeira classe e mantido pelo mesmo time do servidor.

**Contra.** Dependência nova para aprender, operar e depurar. Menos familiar ao time
que RabbitMQ. JetStream exige decidir política de retenção e de ack por stream — erro
aí causa reentrega infinita ou perda, e precisa de teste explícito. Ordenação é por
subject, não global: quem depende de ordem precisa colocar a chave no subject.

**Rejeitado.** RabbitMQ (o do C4 original): resolve a fila, não resolve o fanout;
duas tecnologias em vez de uma. Kafka: dimensionado para volume que este sistema não
tem, e sem pub/sub de baixa latência sem partição. Manter as listas Redis com Streams
em vez de listas: Redis Streams tem grupo de consumo e ack, e seria o caminho de menor
mudança — mas não resolve o fanout de snapshot melhor que já resolve, e deixaria uma
única peça de infraestrutura como ponto único de falha de tudo.
