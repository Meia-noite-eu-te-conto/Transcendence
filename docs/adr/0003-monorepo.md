# ADR-0003 — Monorepo em vez de 4 repositórios com submodules

**Estado:** Aceito · **Data:** 2026-09-12

## Contexto
`Game-Core`, `User-Session`, `Game-BFF` e `Game-Front-End` são repositórios
independentes, ligados ao repositório raiz por `git submodules`. O README já lista
"verificar se o git submodules funcionou" como passo de setup.

A migração é, por natureza, uma sequência de mudanças que atravessam serviços: trocar
uma lista Redis por um subject NATS toca produtor e consumidor; mudar o mapa de cor
toca três repositórios; introduzir JWT toca gateway, dois back-ends e o front.

## Decisão
Consolidar em um monorepo. Importar cada submodule com `git subtree add` preservando
histórico, mover para `legacy/`, e arquivar os repositórios originais em modo leitura.

## Consequências
**A favor.** Uma mudança de contrato é um commit e um PR, revisável como unidade
atômica — em vez de quatro PRs coordenados à mão, com janela em que o sistema está
inconsistente. `contracts/` pode ser fonte da verdade de verdade, com geração de
código para Go e TypeScript no mesmo build. Um CI enxerga tudo e roda teste de
integração e de paridade de ponta a ponta. `go.work` permite refatorar `libs/go` e os
serviços juntos. Onboarding passa a ser `git clone`.

**Contra.** Perde-se isolamento de permissão por repositório (irrelevante para um time
pequeno). O CI precisa detectar o que mudou para não reconstruir tudo a cada commit —
resolvido com filtro por caminho. Histórico importado por subtree fica com commits de
merge que embaralham um pouco a leitura de `git log` da raiz. E a operação é de mão
única: voltar para submodules depois seria doloroso.

**Rejeitado.** Manter submodules: o custo de coordenação recai exatamente sobre a
atividade dominante dos próximos meses. Repositório único novo sem histórico: perder
o histórico dos quatro repositórios é perder o único registro de por que o código está
como está — e este projeto tem pouca documentação.
