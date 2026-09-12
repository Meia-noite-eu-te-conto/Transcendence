# ADR-0007 — Identidade por JWT emitido no gateway

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
Hoje não há autenticação nenhuma. A identidade é um UUID guardado em `localStorage` e
enviado no header `X-User-Id`; o WebSocket de sala aceita `?userId=` na query string
sem verificar nada. Na prática: qualquer pessoa se passa por qualquer jogador, entra
em qualquer sala, remove jogador de sala alheia, e `UpdatePlayerScoreView` incrementa
placar de quem quiser. Além disso, `SECRET_KEY` está fixo no `settings.py` dos dois
serviços e o `.env` com senhas de Postgres está commitado.

O jogo é deliberadamente sem cadastro — entra-se com um apelido. Isso não é motivo
para não ter identidade verificável; é motivo para a identidade ser anônima.

## Decisão
O `gateway` é o **único** ponto que aceita credencial do cliente.
`POST /api/v1/auth/guest {nickname}` cria uma identidade anônima e devolve um access
token JWT de 15 minutos, mais um refresh token em cookie `HttpOnly`. O `playerId` é
**claim do token**, nunca corpo nem header vindo do cliente. O gateway valida e injeta
a identidade para dentro da rede; serviços internos confiam no claim.

No WebSocket o token vai no subprotocolo do handshake
(`Sec-WebSocket-Protocol: bearer.<jwt>`), não em query string.

Autorização fica no domínio: `lobby` verifica dono antes de fechar sala e membro antes
de remover jogador; `game-api` verifica que o slot pertence ao jogador antes de aplicar
input. HS256 com segredo por variável de ambiente.

## Consequências
**A favor.** Fecha a classe inteira de falha de personificação com uma peça só, e sem
adicionar cadastro — a experiência de "entrar com apelido" fica igual. Token de vida
curta limita o dano de um vazamento. Cookie `HttpOnly` no refresh tira o segredo de
longa duração do alcance de JavaScript. Query string fora do handshake evita que o
token apareça em log de acesso de qualquer proxy no caminho. E colocar a emissão no
gateway deixa login 42/OAuth como adição posterior sem tocar em serviço nenhum.

**Contra.** Verificação de token em todo request tem custo (pequeno, HS256 é barato).
Expiração de 15 min exige refresh funcionando bem, senão o jogador cai no meio de uma
partida — o cliente precisa renovar de forma proativa. HS256 com segredo compartilhado
significa que qualquer serviço que valide o token também poderia emiti-lo; aceitável
enquanto só o gateway valida credencial, e migrável para par assimétrico se aparecer
um segundo emissor. Durante a Onda 0 o Django aceita `X-User-Id` **e**
`Authorization`, o que mantém o buraco aberto até o fim da Onda 2.

**Ação imediata, independente da migração:** rotacionar as senhas de Postgres e as
`SECRET_KEY` commitadas. Se o repositório for ou já tiver sido público, trate-as como
vazadas. `.env` sai do versionamento e entra `.env.example`.
