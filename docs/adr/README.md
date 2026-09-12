# Decisões de arquitetura (ADR)

Um arquivo por decisão. Registra **o que foi decidido, por que, e o que se perdeu**.
ADR não se edita depois de aceito — se a decisão muda, escreve-se uma nova que
substitui a anterior (`Substitui: ADR-000X`).

| # | Decisão | Estado |
| --- | --- | --- |
| [0001](0001-go-sem-framework.md) | Go com `net/http` + chi, sem framework e sem ORM | Aceito |
| [0002](0002-nats-como-backbone.md) | NATS JetStream como backbone; Redis rebaixado | Aceito |
| [0003](0003-monorepo.md) | Monorepo em vez de 4 repositórios com submodules | Aceito |
| [0004](0004-simulacao-autoritativa.md) | Simulação autoritativa com tick fixo de 60 Hz | Aceito |
| [0005](0005-angular-zoneless.md) | Angular standalone, signals e zoneless | Aceito |
| [0006](0006-strangler-fig.md) | Migração por strangler fig atrás do gateway | Aceito |
| [0007](0007-jwt-no-gateway.md) | Identidade por JWT emitido no gateway | Aceito |
| [0008](0008-protobuf-no-jogo.md) | Protobuf nos frames de jogo, JSON no REST | Aceito |
| [0009](0009-banco-por-servico.md) | Um banco por serviço, integração por evento | Aceito |
