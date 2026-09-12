---
name: port-endpoint
description: Porta um endpoint Django (view do User-Session ou Game-Core) para handler Go, com contrato OpenAPI, teste de paridade e corte de tráfego no gateway. Use ao migrar qualquer rota REST do legado.
---

# Portar um endpoint Django para Go

Nunca traduza linha por linha. O alvo é o **comportamento observável**, e o legado tem
comportamentos que não devem ser preservados.

## 1. Levantar o comportamento real

Antes de escrever Go, documente o que a view faz **de fato**:

```sh
# a view e suas dependências
sed -n '/class GameView/,/^class /p' legacy/User-Session/src/games/views.py
```

Registre numa tabela: entrada (path, query, header, corpo), validação na ordem em que
acontece, cada código de status e a condição exata, efeito colateral (banco, Redis,
channel layer), e forma exata da resposta.

**Atenção a estes padrões do legado**, todos presentes:
- validação com `if`s sequenciais, onde a **ordem** define qual erro aparece;
- `JsonResponse({}, status=204)` — 204 com corpo, o que é inválido em HTTP;
- `{"errorCode": "400"}` no corpo repetindo o status, sem informação;
- `except Exception` que loga e devolve lista vazia — falha virando resultado vazio;
- `pageSize` aceito como string, sem validação nem teto;
- status 201 para operação assíncrona que ainda não aconteceu.

## 2. Decidir o que preserva e o que corrige

Divida em duas listas e **confirme com o usuário antes de seguir**:

| Preservar | Corrigir de propósito |
| --- | --- |
| regra de negócio (quem pode, quando, limite) | envelope de erro → o padrão de [contratos §2](../../../docs/migration/03-contratos.md) |
| forma dos dados de sucesso | 204 com corpo → 204 sem corpo, ou 200 com corpo |
| semântica de paginação | `pageSize` validado, teto de 100 |
| | identidade do token, não de `X-User-Id` |
| | autorização de dono/membro onde falta |
| | 201 → 202 em operação assíncrona |
| | exceção propagada em vez de resultado vazio |

Cada correção entra no contrato e é comunicada ao front-end. Correção silenciosa
quebra o cliente.

## 3. Contrato primeiro

Edite `contracts/openapi/<svc>.yaml`: path, parâmetro com tipo e limite, schema de
request e response, todos os códigos de erro com seu `code`. Rode `make gen`.

Nome de recurso segue [contratos §2](../../../docs/migration/03-contratos.md): plural,
sem verbo no caminho (`DELETE /rooms/{code}`, não `/rooms/{code}/delete`).

## 4. Implementar de dentro para fora

1. **Domínio** — a regra, pura, com teste de tabela cobrindo cada condição da tabela
   do passo 1. Sem HTTP, sem banco.
2. **Caso de uso** em `app/` — orquestra domínio e portas, com fake nos testes.
3. **Handler** em `adapter/http/` — decodifica, chama, traduz erro por `writeError`.
   Sem `if` de negócio no handler.
4. **Repositório** — query em `queries/*.sql`, `make gen`, teste com testcontainers.

## 5. Paridade

Obrigatório antes do corte. Use a skill `parity-check`: mesmo conjunto de requests
contra Django e Go, comparação de status e corpo, com as divergências do passo 2
declaradas como esperadas. Inclua sempre: caminho felizes, cada erro, paginação nos
limites (página 0, além do fim, `pageSize` inválido), e entrada malformada.

## 6. Corte

1. Rota no gateway apontando para o Go, legado ainda de pé.
2. Observar erro e latência.
3. Marcar na tabela de progresso da [migração](../../../docs/migration/README.md).
4. Remover a view do Django **em commit separado**, depois de uma semana estável.

## Critérios de aceite

- [ ] contrato OpenAPI atualizado e código regenerado
- [ ] cada condição de erro do legado tem teste no Go
- [ ] teste de paridade passa, com divergências intencionais declaradas
- [ ] identidade vem do token, não de header do cliente
- [ ] autorização verificada (dono, membro, slot) onde o legado não verificava
- [ ] paginação validada com teto
- [ ] rota trocada no gateway, legado ainda respondendo
- [ ] tabela de progresso atualizada
