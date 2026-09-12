# ADR-0005 — Angular standalone, signals e change detection zoneless

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
O front-end atual é JS puro com roteador próprio, 15 arquivos carregados por `<script>`
e estado em variáveis globais mais `localStorage`. A migração para Angular abre a
escolha de estilo: Angular "clássico" (NgModules, RxJS, zone.js) ou Angular moderno.

O detalhe que decide é o perfil de carga: WebSocket entregando snapshot a 30 Hz e
`requestAnimationFrame` desenhando a 60 fps, por partida.

## Decisão
Angular 20+ com standalone components, signals, `inject()` e
`provideZonelessChangeDetection()`. Sem `NgModule`. RxJS apenas para fluxo real
(WebSocket, debounce). O renderer WebGL fica **fora** do Angular, como classe
TypeScript comum dirigida por `requestAnimationFrame`.

## Consequências
**A favor.** zone.js remenda `WebSocket.onmessage` e `requestAnimationFrame`; com
zoneless, as ~90 notificações por segundo que não mudam nenhum template deixam de
disparar change detection global. O render passa a ser explícito e mensurável. Signals
dão atualização granular: o placar muda quando o placar muda, não quando um frame é
desenhado. Standalone + rota lazy elimina a camada de NgModule que só existia para
declarar dependência. E o bundle fica menor sem zone.js.

**Contra.** Território menos trilhado: biblioteca de terceiros que dependa de zone.js
não funciona — por isso Bootstrap entra só como CSS, e modal/dropdown viram componente
próprio ou `@angular/cdk`. Menos material de referência e menos respostas prontas
quando algo não renderiza. Exige disciplina: um estado fora de signal simplesmente não
atualiza a tela, e o sintoma (nada acontece) é mais difícil de diagnosticar que um erro.

**Rejeitado.** Angular clássico com zone.js: mais familiar, mas paga custo de change
detection exatamente no caminho crítico do produto. React ou Svelte: seriam escolhas
defensáveis (Svelte especialmente, por não ter runtime de change detection), mas o
requisito do projeto é Angular.
