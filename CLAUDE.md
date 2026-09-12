# CLAUDE.md

@AGENTS.md

O arquivo acima é o guia canônico: domínio, invariantes, layout, convenções Go e
Angular, fluxo de trabalho. Leia antes de agir. O que segue aqui é só o que é
específico do Claude Code.

## Onde está o contexto

| Preciso saber... | Leia |
| --- | --- |
| o que existe hoje e o que está quebrado | [docs/migration/01-analise-atual.md](docs/migration/01-analise-atual.md) |
| para onde estamos indo | [docs/migration/02-arquitetura-alvo.md](docs/migration/02-arquitetura-alvo.md) |
| qual é a onda atual e o que está em jogo | [docs/migration/README.md](docs/migration/README.md) |
| o que fazer em seguida, em que ordem | [docs/migration/06-roadmap.md](docs/migration/06-roadmap.md) |
| formato de request, evento e frame de jogo | [docs/migration/03-contratos.md](docs/migration/03-contratos.md) |
| por que uma decisão foi tomada | [docs/adr/](docs/adr/) |

Quando a resposta a uma pergunta de arquitetura não estiver nesses arquivos, ela
ainda não foi decidida — traga a decisão à tona em vez de escolher em silêncio.

## Skills deste repositório

Invoque pelo nome quando a tarefa casar. Elas carregam o passo-a-passo e os
critérios de aceite de cada operação recorrente da migração.

| Skill | Quando |
| --- | --- |
| `go-service` | criar um serviço Go novo com o layout padrão |
| `port-endpoint` | portar um endpoint Django (view) para handler Go |
| `port-game-loop` | portar simulação/física do worker Python para Go |
| `angular-feature` | criar uma feature Angular (rota, componente, store, cliente) |
| `event-contract` | criar ou alterar um evento NATS sem quebrar consumidor |
| `parity-check` | provar que o código novo se comporta como o legado |

## Subagentes deste repositório

`.claude/agents/` define quatro papéis. **Só use subagente quando eu pedir** — o
padrão é você mesmo fazer o trabalho com suas ferramentas.

- `go-porter` — porta um pedaço de Django para Go
- `angular-porter` — porta uma tela de JS puro para Angular
- `parity-auditor` — compara comportamento legado × novo e reporta divergência
- `contract-guardian` — revisa mudança em `contracts/` procurando quebra de compatibilidade

## Como trabalhar aqui

- **Português nas conversas, commits e docs. Inglês em código, identificador,
  nome de arquivo e mensagem de log.** O repositório já é assim; mantenha.
- **Não reescreva o renderer WebGL.** `Game-Front-End/src/assets/js/game-front-end/`
  são ~1.900 linhas de WebGL2 funcionando, incluindo uma biblioteca de matrizes
  própria (`MVnew.js`). Na migração para Angular ele é **transcrito para TypeScript
  e encapsulado**, não reprojetado. Reescrever renderer não está no escopo de
  nenhuma onda.
- **A física é a parte perigosa.** Ao portar `games_worker/`, a referência é o
  comportamento observável, não a linha de código: o Python tem tick que desliza,
  RNG sem semente e leitura de banco dentro do loop. O Go corrige isso de propósito.
  Documente cada divergência intencional em vez de reproduzir o defeito.
- **Antes de afirmar que algo funciona, rode.** `make test`, `make lint`, ou o
  serviço de verdade. Se não deu para verificar, diga que não deu.
- Ao terminar uma etapa da migração, atualize a tabela de progresso em
  [docs/migration/README.md](docs/migration/README.md). É o único lugar que registra onde paramos.

## Armadilhas conhecidas

- `Game-Core`, `User-Session`, `Game-BFF` e `Game-Front-End` são **git submodules**.
  Editar dentro deles altera outro repositório. Enquanto a consolidação em monorepo
  (ADR-0003) não acontecer, confirme em qual repositório você está commitando.
- `Game-BFF` é uma casca vazia: `README.md` vazio, dois `Dockerfile` vazios. O papel
  de BFF descrito no C4 nunca foi implementado; o nginx faz o proxy hoje.
- Os serviços Python **não têm Dockerfile**. O compose usa a imagem `python:3.11` e
  roda `pip install` no start, com bind mount em `/goinfre/...`. Build não é
  reproduzível e o primeiro boot é lento. Não é bug seu se o ambiente demorar.
- `make` na raiz sobe o compose de desenvolvimento. `make mkdir` precisa rodar antes,
  senão os volumes falham.
