---
name: parity-check
description: Prova que um serviço Go se comporta como o Django que ele substitui, comparando respostas HTTP, efeitos de evento ou estado de simulação, com divergências intencionais declaradas. Use antes de cortar tráfego em qualquer onda da migração.
---

# Provar paridade antes do corte

Nenhum corte de tráfego acontece sem paridade demonstrada. "Testei na mão e pareceu
igual" não conta — o objetivo é pegar a divergência que ninguém pensaria em testar.

Três tipos, conforme o que está sendo portado.

## Tipo 1 — Paridade de HTTP (endpoints)

Para `stats` e `lobby`.

### Montar o ambiente
Suba legado e novo em paralelo, apontando para bancos com **o mesmo conteúdo**
(restaure um dump no banco novo, ou popule os dois com o mesmo seed determinístico).

### Escrever os casos
`test/parity/cases/<endpoint>.yaml`:

```yaml
- name: ranking primeira pagina
  request: { method: GET, path: /api/v1/stats/ranking?page=1&pageSize=10 }
  expect: identical

- name: ranking pageSize acima do teto
  request: { method: GET, path: /api/v1/stats/ranking?page=1&pageSize=9999 }
  expect: differs
  reason: legado aceita sem teto; novo limita a 100 (contratos §2)

- name: sala inexistente
  request: { method: GET, path: /api/v1/rooms/nao-existe }
  expect: differs
  reason: legado devolve 404 com {"errorCode":"404"}; novo usa o envelope padrão
```

Cobertura mínima: caminho felizes, **cada** código de erro que o legado produz,
paginação nos limites (página 0, página além do fim, `pageSize` inválido, negativo,
string), entrada malformada, campo ausente, e campo com tipo errado.

### Rodar
```sh
make parity ENDPOINT=stats/ranking
```

O runner dispara cada caso contra os dois, normaliza o que é legitimamente volátil
(timestamp, uuid gerado, ordem de chave JSON) e faz diff do resto. Saída: tabela de
idêntico / divergente-esperado / **divergente-inesperado**.

**Divergência inesperada bloqueia o corte.** Ou é bug no Go, ou é uma correção
intencional que ninguém declarou — as duas precisam de decisão, não de tolerância.

### Onde a divergência costuma estar escondida
- **Ordem de resultado** sem `ORDER BY` determinístico. O legado usa
  `.order_by('-total_wins','-total_points')`, que empata de forma arbitrária; adicione
  desempate por id nos dois lados.
- **Arredondamento e tipo numérico**: `Sum()` do Django devolve `None` para conjunto
  vazio, não `0`.
- **Cálculo de paginação** na última página e com total exatamente múltiplo de `pageSize`.
- **Conjunto vazio**: o legado às vezes devolve `204` com corpo, às vezes `200` com
  lista vazia, no mesmo serviço.
- **Fuso**: `USE_TZ = True` no Django; confirme que o Go serializa em UTC com o mesmo
  formato.

## Tipo 2 — Paridade de evento (orquestração)

Para o orquestrador de torneio.

1. Grave uma sequência real de eventos do legado (as mensagens de
   `game-sync-session-queue` de um torneio completo de 4 jogadores).
2. Reproduza a sequência contra o consumidor Go, do mesmo estado inicial de banco.
3. Compare o **estado final**: partidas, `nextMatch`, `winner`, `bracketsPosition`,
   slot de cada jogador, estado da sala.
4. Repita reentregando cada evento duas vezes. O estado final tem que ser idêntico —
   é isso que prova a idempotência que o legado não tem.

## Tipo 3 — Paridade de simulação (física)

Golden file. Coberto pela skill `port-game-loop` §3, que é a autoridade. Não
reimplemente aqui.

## Declarar divergências

Toda divergência intencional vive em `test/parity/expected-diffs.md`, com: endpoint ou
cenário, o que o legado faz, o que o novo faz, **por que**, e o impacto no cliente.
Este arquivo é o que o front-end lê para saber o que muda.

Divergência que afeta o cliente precisa ser comunicada antes do corte, não descoberta
depois.

## Depois do corte

Paridade não termina no corte. Por uma semana:
- taxa de erro e latência p99 do endpoint novo, comparadas ao histórico;
- o legado fica de pé, com rollback por mudança de rota no gateway;
- só então o código legado é removido, **em commit separado**.

## Critérios de aceite

- [ ] casos cobrindo caminho felizes, todos os erros e todos os limites de paginação
- [ ] zero divergência inesperada
- [ ] cada divergência intencional em `expected-diffs.md` com motivo e impacto
- [ ] divergência que afeta cliente comunicada antes do corte
- [ ] para orquestração: reentrega dupla não muda o estado final
- [ ] para simulação: golden file dos 8 cenários passando
- [ ] legado de pé com rollback por configuração durante a observação
