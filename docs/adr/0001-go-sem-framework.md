# ADR-0001 — Go com `net/http` + chi, sem framework e sem ORM

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
Os serviços são Django + Channels. A migração para Go abre a escolha entre replicar o
conforto do Django (framework completo: Gin/Fiber + GORM/Ent) ou ir de biblioteca.

Dois fatos do legado pesam na decisão. Primeiro, o Django ORM permitiu que uma query
fosse escrita dentro do loop de simulação de 50 Hz (`update_score`,
`check_players_connected`) — o custo é invisível quando persistir é uma linha.
Segundo, o Channels trouxe um modelo de concorrência (channel layer, consumer) que
mistura transporte e domínio: `GameSessionConsumer` valida jogador, consulta banco,
traduz input e faz `LTRIM` em Redis.

## Decisão
`net/http` com `go-chi/chi/v5` para roteamento e middleware. `pgx/v5` + `sqlc` para
banco, **sem ORM**. Nenhum framework web.

## Consequências
**A favor.** SQL é explícito e revisável: uma query no caminho errado aparece no diff.
`http.Handler` é interface da stdlib, então middleware e teste são triviais e
portáveis. Superfície de dependência pequena, o que importa num projeto com time
pequeno e vida longa. `sqlc` gera código tipado a partir do SQL — erro de coluna é
erro de compilação.

**Contra.** Mais boilerplate que Django: scan de DTO, validação e paginação são
escritos à mão (mitigado por `oapi-codegen`, que gera tipos e roteamento a partir do
OpenAPI). Sem admin, sem migrations automáticas a partir de modelo — `goose` é SQL
escrito à mão. Mudança de schema exige tocar em `.sql` e regenerar.

**Rejeitado.** Gin/Fiber: trazem roteador próprio incompatível com `http.Handler` sem
adaptador, em troca de ganho marginal. GORM: reintroduz exatamente o problema de
tornar I/O invisível. Ent: bom, mas o peso de geração e de conceito não se paga num
domínio de ~15 tabelas.
