# ADR-0006 — Migração por strangler fig atrás do gateway

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
Dois serviços Django e uma SPA precisam virar quatro serviços Go e uma SPA Angular.
O sistema é usado (é entrega de projeto acadêmico com avaliação), então parar de
funcionar por semanas não é opção. A alternativa óbvia — reescrever tudo em paralelo e
trocar de uma vez — tem o modo de falha conhecido: o novo nunca alcança o antigo,
porque o antigo continua andando.

Dois fatos ajudam. Quase todo o estado é **efêmero**: sala, partida e jogador vivem
minutos, e só `stats` tem dado durável. E o front-end já fala com dois back-ends
distintos, então trocar quem responde é mudança de roteamento.

## Decisão
Strangler fig. O `gateway` Go entra na frente do sistema legado **antes** de qualquer
serviço ser portado, e inicialmente só repassa. Depois, cada endpoint migra trocando
uma rota no gateway. Ordem das ondas: fundação → `stats` (só leitura) → `lobby` →
`game` → front-end Angular → desmonte. Ver [migração](../migration/README.md).

Duas regras de execução: **nenhuma feature nova no legado** durante a migração, e
**introduzir o substituto e remover o legado são commits separados**, para que o
rollback seja mudança de configuração.

## Consequências
**A favor.** O sistema funciona em todos os pontos intermediários. Rollback é trocar
uma rota, não reverter uma release. `stats` primeiro valida toolchain, layout, CI e
teste de paridade com risco quase zero — se estiver errado, ninguém perde partida.
Como o estado é efêmero, `lobby` e `game` cortam sem migração de dados: basta cortar
quando não houver sala ativa. E o front-end Angular pode ser construído desde a Onda 1,
em paralelo, porque não depende dos serviços Go.

**Contra.** Período longo (meses) com duas linguagens, dois runtimes e conhecimento
dividido — e o risco real de a migração parar no meio e isso virar permanente, que é o
pior dos dois mundos. Durante a transição há trabalho jogado fora: Django publicando
em Redis **e** em NATS, Django aceitando `X-User-Id` **e** `Authorization`, código de
compatibilidade que nasce para morrer. O gateway adiciona um salto de rede (mitigado
mantendo o WS de jogo fora dele). E exige disciplina para não portar por completude —
cada onda tem que terminar com o corte feito.

**Rejeitado.** Big bang: modo de falha conhecido. Migrar o front-end primeiro:
Angular consumindo API Django faria o cliente gerado nascer de contratos que vão mudar,
e jogaria trabalho fora duas vezes. Migrar `game` primeiro (a parte "divertida"): é a
de maior risco, e começar por ela significa aprender Go e o domínio de rede de jogo
ao mesmo tempo, sem toolchain validada.
