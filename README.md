# A Pong Game

## Como rodar

> [!WARNING] Atenção
> - Verificar se as pastas de volumes do docker compose para o banco de dados estão criadas.
> - Verificar o arquivo .env
> - Verificar se o git submodules funcionou
> - Aplicar migrations

```sh
make
```

Reiniciar containers
```sh
make att
```

## Documentação

| Onde | O quê |
| --- | --- |
| [CONTEXT.md](CONTEXT.md) | orientação de 5 minutos sobre o repositório (e um por projeto) |
| [AGENTS.md](AGENTS.md) | regras de engenharia: invariantes, layout, convenções Go e Angular |
| [CLAUDE.md](CLAUDE.md) | guia para o Claude Code (skills, subagentes, armadilhas) |
| [docs/migration/](docs/migration/) | análise do estado atual, arquitetura alvo, contratos e ondas |
| [docs/adr/](docs/adr/) | decisões de arquitetura e o motivo de cada uma |
| [docs/0-context/](docs/0-context/), [docs/1-container/](docs/1-container/) | C4 original — descreve a intenção, não o sistema atual |

> **Este projeto está em migração:** Django → Go e JS puro → Angular, por strangler fig.
> Antes de escrever código, leia [docs/migration/README.md](docs/migration/README.md)
> para saber qual é a onda atual, e [docs/migration/06-roadmap.md](docs/migration/06-roadmap.md)
> para a próxima tarefa. Nenhuma feature nova no legado.

## Objetivo

- [Sessões Escolhidas do Projeto](https://tcdmodules.vercel.app/v14.1?state=34341063)
- [Initial Figma](https://www.figma.com/design/0QqbBQfDFr7xsR6Z1BQ3iX/trancendence-poke?node-id=0-1&t=mro9uy9PyI9rkcJu-1)

## Material de Aprendizado

`Importante:`<br>
- [Sincronização multi-player](https://www.gabrielgambetta.com/)

`Cursos:`<br>
- [Freecodecamp HTML + CSS](https://www.freecodecamp.org/learn/responsive-web-design/)
- [Freecodecamp Javascript](https://www.freecodecamp.org/learn/javascript-algorithms-and-data-structures-v8/)
- [Freecodecamp Python]()
- [Freecodecamp Postgresql e Git](https://www.freecodecamp.org/learn/relational-database/)

`Road Maps:`<br>
- [Roadmap Server Side Game](https://roadmap.sh/server-side-game-developer)
- [Roadmap Client Side Game](https://roadmap.sh/game-developer)
- [Roadmap Postgresql](https://roadmap.sh/postgresql-dba)
- [Roadmap Javascript](https://roadmap.sh/javascript)
- [Roadmap Python](https://roadmap.sh/python)
- [Roadmap Code Review](https://roadmap.sh/code-review)
- [Roadmap Git and Github](https://roadmap.sh/git-github)
- [Roadmap Api Design](https://roadmap.sh/api-design)
- [Roadmap Docker](https://roadmap.sh/docker)
- [Roadmap Terraform](https://roadmap.sh/terraform)
- [Roadmap DevOps](https://roadmap.sh/devops)
- [Roadmap Ux Design](https://roadmap.sh/ux-design)
- [Roadmap Redis](https://roadmap.sh/redis)

## Referências

