# ADR-0009 — Um banco por serviço, integração por evento

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
Já existem dois Postgres separados (`db-user-session` e `db-game-core`), o que está
certo. O problema é o modelo: o mesmo jogador existe nos dois bancos —
`Player`/`MatchPlayer` em um, `PlayerModel`/`ScoreModel` no outro — sincronizado pela
fila Redis. E nenhum dos eventos de sincronização (`game-created`, `game-started`,
`game-over`) carrega identificador: reprocessar `game-over` pontua de novo e reavança
o chaveamento.

A migração poderia "simplificar" unificando num banco só, já que o domínio é pequeno.

## Decisão
Manter um banco por serviço e nenhum acesso cruzado a tabela alheia. `lobby` tem
`pg:lobby`, `stats` tem `pg:stats`, e **`game` não tem banco** — o estado da partida
vive em memória no engine com snapshot em Redis, e o que importa sai como evento.

Integração é por evento, com **envelope obrigatório** contendo `eventId` (UUIDv7) e
deduplicação no consumidor. `game.finished` carrega o placar completo com `rank`, para
que nem `lobby` nem `stats` precisem consultar o outro.

## Consequências
**A favor.** A fronteira de contexto passa a ser real e não convencional: não há como
um serviço acoplar-se ao schema do outro por descuido, então `lobby` e `stats` evoluem
o próprio schema sem coordenação. `stats` como read model alimentado por evento pode
ser reconstruído do zero por replay do JetStream, o que também é a estratégia de
migração de dados da Onda 1. `game` sem banco é o que torna possível a regra de "zero
I/O no tick" — não há tentação a resistir.

**Contra.** Consistência é eventual, e isso aparece na tela: o placar do ranking pode
ficar alguns segundos atrás do fim da partida. Não há JOIN entre contextos — relatório
que cruze sala e estatística precisa de composição na aplicação ou de um evento que
carregue os dois lados, e é por isso que `game.finished` é gordo de propósito.
Deduplicação por `eventId` é código de infraestrutura em todo consumidor, com uma
tabela de ids processados para manter. E dado duplicado entre serviços (o apelido do
jogador vive em `lobby` e em `stats`) exige aceitar que são cópias com propósitos
diferentes, não a mesma verdade em dois lugares.

**Rejeitado.** Banco único compartilhado: mais simples hoje, e é a decisão que
transforma microsserviços em monólito distribuído — o pior arranjo possível, com o
custo da rede e sem o benefício do isolamento. Dar a `game` um banco "só para
persistir o placar": reabre a porta para query dentro do loop, que é exatamente o
defeito do legado.
