---
name: angular-feature
description: Cria uma feature Angular em web/src/app/features (rota lazy, componentes standalone, store com signals, cliente gerado do OpenAPI) seguindo o padrão zoneless do projeto. Use ao migrar qualquer tela do Game-Front-End.
---

# Criar uma feature Angular

Segue as [convenções Angular](../../../docs/migration/05-convencoes-angular.md).
Ordem recomendada de migração das telas: `ranking` → `lobby` → `room` → `tournament`
→ `game`. Comece por `ranking` porque é só leitura e valida o cliente gerado.

## 1. Estrutura

```
web/src/app/features/<nome>/
  <nome>.routes.ts          rota lazy + providers da feature
  <nome>.component.ts       componente de página
  <nome>.store.ts           estado em signals, providenciado na rota
  components/               componentes filhos, específicos desta feature
  <nome>.store.spec.ts
```

Registre em `app.routes.ts`:

```ts
{ path: 'rooms/:code', loadChildren: () => import('./features/room/room.routes') }
```

## 2. Antes de escrever: levantar a tela do legado

```sh
cat legacy/Game-Front-End/src/<tela>.html
grep -n "class Page<Tela>" -A 60 legacy/Game-Front-End/src/assets/js/EventHandlers.js
```

Registre: quais requisições a tela faz e em que ordem, quais mensagens de WebSocket
ela trata, o que ela guarda em `localStorage`, e o que acontece no `destroy()`.

Cuidado com estes padrões do legado:
- `localStorage` como estado de aplicação (`roomCode`, `gameId`, `currentPage`) →
  vira **parâmetro de rota**;
- clique tratado por um listener global em `document` com `data-*` → vira `(click)` no
  template;
- várias requisições para montar uma tela → **peça composição no gateway**;
- `alert()` como placeholder → componente de toast em `shared/ui`.

## 3. Store

```ts
@Injectable()   // providenciado na ROTA, não em 'root'
export class RoomStore {
  private readonly api = inject(RoomsService);        // gerado do OpenAPI
  private readonly auth = inject(AuthService);

  private readonly _room = signal<Room | undefined>(undefined);
  private readonly _error = signal<string | undefined>(undefined);

  readonly room = this._room.asReadonly();
  readonly isOwner = computed(() => this._room()?.ownerId === this.auth.playerId());
  readonly canStart = computed(() => {
    const r = this._room();
    return !!r && r.state === 'LOCKED' && r.players.length === r.maxPlayers;
  });

  async load(code: string): Promise<void> { /* ... */ }
}
```

- Signal de escrita privado; expõe `asReadonly()` e `computed()`.
- Derivado é `computed()`, nunca método chamado no template.
- Store de feature morre com a feature. Só `core/` tem singleton.

## 4. Componente

```ts
@Component({
  selector: 'app-room',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PlayerListComponent, SpinnerComponent],
  template: `
    @if (store.room(); as room) {
      <app-player-list [players]="room.players" (remove)="onRemove($event)" />
      <button [disabled]="!store.canStart()" (click)="start()">Iniciar</button>
    } @else {
      <app-spinner />
    }
  `,
})
export class RoomComponent {
  readonly store = inject(RoomStore);
  readonly code = input.required<string>();   // withComponentInputBinding
}
```

- `inject()`, não construtor. `input()`/`output()` como funções.
- `@if`/`@for`/`@switch`, nunca `*ngIf`/`*ngFor`.
- Sem `any`, sem `!` para calar o compilador.

## 5. WebSocket

Use `core/ws/`. Nunca instancie `WebSocket` numa feature.

```ts
private readonly socket = inject(RoomSocket);

constructor() {
  this.socket.messages.pipe(takeUntilDestroyed()).subscribe(msg => {
    switch (msg.type) {
      case 'players.changed':    this.reload(); break;
      case 'game.started':       this.router.navigate(['/games', msg.gameId]); break;
      case 'tournament.advanced': /* ... */ break;
    }
  });
}
```

`takeUntilDestroyed()` em toda assinatura. O legado abre socket em `init()` e fecha em
`destroy()` à mão; aqui o ciclo de vida é do Angular.

## 6. A feature `game` é diferente

Leia [convenções Angular §6](../../../docs/migration/05-convencoes-angular.md) antes.
Em resumo:

- O renderer WebGL é uma **classe TypeScript comum** em `lib/renderer/`, não um
  componente e não um serviço Angular.
- `GameComponent` cria o renderer em `afterNextRender`, entrega snapshots, chama
  `dispose()` via `DestroyRef`. Não toca em WebGL.
- O laço de `requestAnimationFrame` **não** dispara change detection.
- HUD (placar, nomes, status) atualiza por signal, em frequência de evento.
- **Interpolação entre os dois últimos snapshots** é obrigatória: chegam a 30 Hz e a
  tela desenha a 60 fps. Sem isso o movimento fica pior que no legado.

## 7. Estilo

Bootstrap 5 **só CSS**, sem o bundle JS (depende de zone.js). Modal e dropdown são
componentes de `shared/ui` ou `@angular/cdk`. Cor de jogador vem do slot, por token
derivado de `contracts/enums.yaml` — nunca um mapa local.

## Critérios de aceite

- [ ] rota lazy registrada; store providenciado na rota
- [ ] nenhum `fetch` nem URL montada à mão — só o cliente gerado
- [ ] nenhum estado de aplicação em `localStorage`; `roomCode`/`gameId` são rota
- [ ] `tsc --noEmit` e `ng lint` limpos; zero `any`
- [ ] toda assinatura com `takeUntilDestroyed()`
- [ ] teste de store (Vitest) e teste de componente por interação
- [ ] funciona em tela estreita (exceto a feature `game`)
- [ ] comparada lado a lado com a tela do legado antes do corte
