# 05 — Convenções Angular

Substituto de `Game-Front-End`. O ponto sensível deste front-end não é formulário:
é desenhar 60 fps em WebGL enquanto recebe WebSocket a 30 Hz. As convenções são
orientadas a isso.

## 1. Stack

Angular 20+, standalone, signals, **zoneless**. TypeScript `strict`.
Build com Vite/esbuild (padrão do Angular CLI atual). Teste com Vitest.

```ts
// main.ts
bootstrapApplication(AppComponent, {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withInterceptors([authInterceptor, traceInterceptor])),
  ],
});
```

**Por que zoneless.** zone.js remenda `WebSocket.onmessage` e `requestAnimationFrame`.
Com snapshot a 30 Hz e render a 60 fps, isso dispara change detection global ~90 vezes
por segundo por causa de eventos que não mudam nenhum template. Zoneless elimina esse
custo e torna o render explícito. Consequência aceita: biblioteca que dependa de
zone.js não funciona — mantenha a lista de dependências curta.
Registrado em [ADR-0005](../adr/0005-angular-zoneless.md).

## 2. Estrutura

```
web/src/app/
  core/
    auth/        auth.service.ts  auth.interceptor.ts  auth.guard.ts
    api/         gerado do OpenAPI — NÃO editar à mão
    ws/          ws-client.ts (reconexão, backoff), room-socket.ts, game-socket.ts
    config/      environment tokens
  shared/
    ui/          componentes burros: botão, modal, paginação, avatar
  features/
    lobby/       lista de salas, criar sala
    room/        sala de partida, lista de jogadores
    tournament/  chaveamento, histórico
    game/        canvas + HUD
    ranking/
  lib/
    mat4.ts      transcrição de MVnew.js
    renderer/    transcrição de Objects/Shaders/Textures/Render/InitAndUpdateObjects
  app.routes.ts
```

- Uma feature = uma pasta = uma rota lazy (`loadComponent`).
- `shared/ui` não conhece domínio: recebe input, emite output. Sem serviço injetado.
- `core/api` é **gerado**. Ninguém escreve `fetch`, ninguém monta URL com template string.
  O legado tem `RoutesInfo.js` e `APIEndPoints` duplicando os mesmos prefixos em dois
  formatos; isso desaparece.

## 3. Componentes

```ts
@Component({
  selector: 'app-room',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (room(); as r) {
      <app-player-list [players]="r.players" (remove)="onRemove($event)" />
    } @else {
      <app-spinner />
    }
  `,
})
export class RoomComponent {
  private readonly store = inject(RoomStore);
  readonly room = this.store.room;     // Signal<Room | undefined>
}
```

- `inject()`, não injeção por construtor.
- `OnPush` sempre (com zoneless é o comportamento efetivo, mas deixe explícito).
- Sintaxe de controle de fluxo nova (`@if`, `@for`, `@switch`). Sem `*ngIf`/`*ngFor`.
- `input()` e `output()` como funções, não decoradores.
- `viewChild()` como signal para pegar o canvas.
- Template sem lógica: nada de expressão com efeito colateral ou chamada de método
  que calcula. Derivado é `computed()`.
- **Sem `any`.** Sem `!` para calar o compilador — trate o `undefined`.

## 4. Estado

Signals como padrão; RxJS só onde é fluxo de verdade (WebSocket, debounce de busca).

```ts
@Injectable()  // providenciado na rota da feature, não em 'root'
export class RoomStore {
  private readonly api = inject(RoomsService);
  private readonly _room = signal<Room | undefined>(undefined);

  readonly room = this._room.asReadonly();
  readonly isOwner = computed(() => this._room()?.ownerId === this.auth.playerId());
  readonly canStart = computed(() => {
    const r = this._room();
    return !!r && r.state === 'LOCKED' && r.players.length === r.maxPlayers;
  });
}
```

- Sinal de escrita é privado; expõe `asReadonly()` e `computed()`.
- Store de feature é providenciado **na rota** — morre com a feature, não vira singleton.
- **Nada de `localStorage` como estado de aplicação.** O legado guarda `currentPage`,
  `roomCode`, `gameId` e `userId` lá e lê de volta espalhado pelo código
  (`getCookie()` que na verdade lê `localStorage` é o sintoma). Rota é a fonte da
  verdade de navegação; `roomCode` e `gameId` são **parâmetros de rota**.
  `localStorage` guarda só o refresh token e preferência de UI.
- Roteador do Angular, não roteador próprio. O legado reimplementa
  `pushState`/`popstate` e espelha o histórico em `sessionStorage`
  (`EventHandlers.js:348`) — 90 linhas que o framework já faz.

## 5. WebSocket

Duas conexões, dois formatos, uma abstração de reconexão.

```ts
// core/ws/ws-client.ts — genérico: reconexão com backoff exponencial + jitter,
// estado como signal, fila de envio enquanto desconectado.
export class WsClient<TIn, TOut> {
  readonly state = signal<'connecting' | 'open' | 'closed'>('closed');
  readonly messages: Observable<TIn>;
  send(msg: TOut): void;
}
```

- Token no subprotocolo do handshake, nunca em query string.
- `game-socket.ts` codifica/decodifica Protobuf (tipos gerados de `contracts/proto`).
- `room-socket.ts` é JSON.
- **Reconexão é obrigatória.** O legado só loga `onerror` e mostra um ícone vermelho;
  quem perde a conexão no meio da partida fica olhando tela parada.
- Toda assinatura encerra com `takeUntilDestroyed()`.

## 6. O jogo

Esta é a regra mais importante da migração do front-end.

**O renderer não é Angular.** É uma classe TypeScript comum:

```ts
// lib/renderer/pong-renderer.ts
export class PongRenderer {
  constructor(canvas: HTMLCanvasElement) { /* compila shader, cria buffer */ }
  applySnapshot(s: Snapshot): void { /* guarda os dois últimos para interpolar */ }
  start(): void  { /* requestAnimationFrame */ }
  stop(): void   { /* cancela e libera recurso de GL */ }
  dispose(): void
}
```

- Nenhum estado global. `Game-Front-End` usa `gPong`, `gl`, `gObjects`, `gCamera`,
  `gShader`, `gCtx`, `gPositions`, `doOnce` como variáveis globais — todos viram campo
  de instância.
- O componente `GameComponent` cria o renderer no `afterNextRender`, entrega os
  snapshots e chama `dispose()` no `DestroyRef`. Ele **não** toca em WebGL.
- O laço de `requestAnimationFrame` **não** dispara change detection. HUD (placar,
  nome, status) atualiza por signal, em frequência de evento, não de frame.
- **Interpolação no cliente:** snapshots chegam a 30 Hz e a tela desenha a 60 fps.
  O renderer guarda os dois últimos snapshots e interpola por `tick`. Sem isso o jogo
  fica visivelmente travado — hoje o legado desenha um frame por mensagem recebida.

### Transcrição de `MVnew.js`
1.197 linhas de álgebra linear (`mat4`, `vec3`, `flatten`, `lookAt`, `perspective`).
Transcreva para `lib/mat4.ts` com tipo (`Mat4 = Float32Array & {length: 16}`), **sem
mudar a matemática**, e cubra com teste comparando saída contra a versão JS para
entradas conhecidas. É o tipo de código onde um sinal trocado não dá erro — dá uma
cena errada.

## 7. Estilo

- Bootstrap 5 **só CSS**, sem o bundle JS (depende de zone.js e de manipulação direta
  de DOM). Modal e dropdown viram componente em `shared/ui` ou `@angular/cdk`.
- CSS por componente (escopo padrão do Angular). Token de cor em um único arquivo,
  derivado de `contracts/enums.yaml` — a cor do jogador vem do slot, não de um mapa
  duplicado no front (§4.8 da análise).
- Mobile não é requisito do jogo, mas lobby, ranking e torneio devem funcionar em
  tela estreita.

## 8. Testes

| Tipo | Ferramenta | Alvo |
| --- | --- | --- |
| Unidade | Vitest | store, `computed`, `mat4.ts`, decodificação de frame |
| Componente | Vitest + Testing Library | interação, não implementação |
| E2E | Playwright | criar sala → entrar → iniciar → jogar até o placar mudar |

- `mat4.ts` e o decodificador de snapshot têm cobertura próxima de total: são puros e
  quebram de forma silenciosa.
- Renderer não tem teste unitário; é coberto pelo E2E com screenshot de referência.
- `ng lint` e `tsc --noEmit` limpos antes de commit.
