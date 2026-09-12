---
name: event-contract
description: Cria ou altera um evento NATS (subject, envelope, schema, stream, consumidor durável) sem quebrar consumidor existente. Use ao substituir uma lista Redis do legado por JetStream ou ao mudar o payload de um evento.
---

# Criar ou alterar um evento

Referência: [contratos §3](../../../docs/migration/03-contratos.md) e
[ADR-0002](../../../docs/adr/0002-nats-como-backbone.md).

## 1. Onde mexer

`contracts/asyncapi/events.yaml` primeiro. Sempre. Depois `make gen`, depois o código.

## 2. Nomear o subject

```
<contexto>.<agregado>.<evento>      durável, JetStream    lobby.match.requested
game.<gameId>.snapshot              efêmero, NATS core    alta frequência
game.<gameId>.input                 efêmero, NATS core
```

- Evento no **passado**: `requested`, `created`, `started`, `finished`, `aborted`.
  Nunca imperativo (`create_game` do legado é comando, não evento).
- A chave de ordenação vai no subject. Ordem é garantida por subject, não global — se
  a ordem por partida importa, o `gameId` precisa estar no subject.
- Efêmero e durável não se misturam no mesmo stream.

## 3. Envelope obrigatório

```json
{
  "eventId":   "018f...",
  "type":      "game.finished",
  "version":   1,
  "occurredAt":"2026-09-12T10:00:00Z",
  "traceId":   "0af7651916cd43dd...",
  "data":      { }
}
```

- `eventId` é UUIDv7 e é a **chave de idempotência**. Nenhum evento sai sem ele.
  (Os quatro eventos do legado não têm id — é a causa raiz de placar duplicado ao
  reprocessar `game-over`.)
- `traceId` vem do contexto de quem publica e continua no consumidor. É o que permite
  seguir "criei a sala" até "a partida acabou" num só trace.

## 4. Desenhar o `data`

Regra: **o consumidor não deve precisar de outra chamada** para agir. É por isso que
`game.finished` carrega o placar completo com `rank` — `lobby` avança o chaveamento e
`stats` projeta o ranking, nenhum dos dois consulta o outro.

Evento gordo é aceitável; chamada de volta entre serviços não é. Ver
[ADR-0009](../../../docs/adr/0009-banco-por-servico.md).

## 5. Publicar

```go
func (p *Publisher) Publish(ctx context.Context, subject string, data any) error {
    env := Envelope{
        EventID:    uuid.Must(uuid.NewV7()).String(),
        Type:       subject,
        Version:    1,
        OccurredAt: p.clock.Now().UTC(),
        TraceID:    trace.SpanContextFromContext(ctx).TraceID().String(),
        Data:       data,
    }
    // ...
}
```

Publique **depois** de commitar a transação que o evento descreve, nunca dentro dela —
senão um rollback deixa um evento mentindo. Se a entrega falhar após o commit, o
consumidor precisa tolerar a ausência; prefira um outbox se a perda for inaceitável.

## 6. Consumidor durável

```go
cons, err := js.CreateOrUpdateConsumer(ctx, "GAME", jetstream.ConsumerConfig{
    Durable:       "lobby-orchestrator",
    FilterSubject: "game.game.*",
    AckPolicy:     jetstream.AckExplicitPolicy,
    AckWait:       30 * time.Second,
    MaxDeliver:    3,
})
```

Obrigatório em todo consumidor:

1. **Ack explícito.** `Ack()` só depois do efeito estar durável. Erro → `Nak()` com
   backoff. Isso é o que o `LPOP` do legado não tem.
2. **Deduplicação por `eventId`.** Tabela `processed_events (event_id PK, processed_at)`
   com o insert **na mesma transação** do efeito. `eventId` já visto → `Ack()` e sai.
3. **`MaxDeliver` + DLQ.** Mensagem envenenada não pode girar para sempre. Depois de 3
   tentativas, vai para `dlq.<subject>` e alerta.
4. **Respeitar `ctx`.** Encerrar no shutdown sem perder ack em voo.
5. **Métrica de lag.** Consumidor parado é falha silenciosa.

## 7. Alterar um evento existente

| Mudança | Como |
| --- | --- |
| campo novo opcional | livre, `version` não muda |
| campo novo obrigatório | é quebra: publique com padrão por uma versão, então promova |
| renomear campo | adicione o novo, publique os dois, migre consumidores, remova o antigo |
| remover campo | só depois de nenhum consumidor ler — verifique, não presuma |
| mudar tipo ou semântica | `version: 2`; consumidor aceita 1 e 2 até a migração terminar |
| valor novo em enum | adicione no fim; consumidor trata desconhecido como "ignorar", não erro |

Sequência para quebra, sempre nesta ordem: **consumidor aceita os dois → produtor
publica o novo → consumidor para de aceitar o antigo.** Inverter causa indisponibilidade.

## 8. Substituir uma lista Redis do legado

Durante a migração, **publique nos dois** por uma onda:

1. Django continua dando `RPUSH` na lista.
2. Django (ou o serviço Go novo) também publica no JetStream.
3. O consumidor Go assina o JetStream; o worker Python continua no `LPOP`.
4. Só um dos dois **age** — o outro vai para log de comparação.
5. Vire a chave, observe, então remova o `RPUSH` e a lista.

## Critérios de aceite

- [ ] `contracts/asyncapi/events.yaml` atualizado e código regenerado
- [ ] subject no padrão, com evento no passado
- [ ] `eventId` UUIDv7 em todo evento publicado
- [ ] `traceId` propagado do contexto
- [ ] publicação depois do commit, nunca dentro da transação
- [ ] consumidor com ack explícito, `MaxDeliver` e DLQ
- [ ] deduplicação por `eventId` na mesma transação do efeito
- [ ] teste: reentregar o mesmo evento duas vezes não muda o resultado
- [ ] teste: evento malformado vai para DLQ e não bloqueia o stream
- [ ] métrica de lag do consumidor exposta
