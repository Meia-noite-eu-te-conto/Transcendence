# ADR-0008 — Protobuf nos frames de jogo, JSON no REST

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
O snapshot de jogo hoje é JSON serializado **duas vezes**: `GameSession.notify_clients`
faz `json.dumps(response_data)` e o consumer envia
`json.dumps({"type": ..., "game_state": json.dumps(response)})`. Isso a 50 Hz por
jogador, com um snapshot que carrega nomes de campo (`"numberOfPlayers"`,
`"fieldAttributes"`, `"lastPlayerHit"`) e reenvia o tamanho do campo em todo frame.
Cada frame fica na ordem de 400 bytes para transportar ~10 números.

Além do tamanho, há o problema de tipo: o formato do snapshot existe implicitamente em
`game_session.py` e é reinterpretado à mão em `Render.js`. Uma renomeação de campo não
dá erro em lugar nenhum — dá uma cena errada.

## Decisão
**Protobuf** para os frames do WebSocket de jogo, definidos em
`contracts/proto/game/v1/frames.proto` e gerados para Go e TypeScript.
**JSON** para todo o REST e para o WebSocket de sala.

Duas decisões de conteúdo junto: o placar sai do snapshot e vira `GameEvent` (muda
raro, não faz sentido a 30 Hz); as dimensões do campo são enviadas só quando mudam.

## Consequências
**A favor.** ~40 bytes por frame em vez de ~400, e a 30 Hz em vez de 50 Hz — uma ordem
de grandeza de banda e de CPU de serialização. O formato passa a ser tipado e
compartilhado: o mesmo `.proto` gera a struct Go e a interface TypeScript, então
renomear campo quebra o build em vez de quebrar a tela. Campo com número reservado dá
compatibilidade para frente de graça.

**Contra.** Um passo de geração a mais no build de Go e de TS, e `protoc` como
ferramenta de desenvolvimento. Frame binário não se lê no DevTools do navegador — para
depurar é preciso um decodificador, então vale um modo de debug que também publique
JSON. Mantém-se dois formatos no sistema (JSON no REST, proto no jogo), o que é uma
inconsistência aparente que precisa ser explicada. E números de campo Protobuf são
para sempre: reutilizar um número corrompe dados de cliente antigo de forma silenciosa.

**Rejeitado.** JSON em tudo, só corrigindo a dupla serialização: mais simples e
resolveria metade do problema de banda, mas deixa o formato sem tipo compartilhado,
que é o defeito mais caro. MessagePack: compacta sem exigir schema, mas é justamente
o schema que se quer. `flatbuffers`: ganho de zero-copy irrelevante nesta escala, em
troca de ergonomia pior.
