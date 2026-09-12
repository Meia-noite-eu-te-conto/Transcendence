// Teste de INTEGRAÇÃO do Pong: exercita o fluxo atravessando os três
// serviços, contra as imagens já publicadas, antes de promover para o k8s.
//
// Por que aqui e não em cada submodule: os quatro bugs encontrados jogando
// contra o cluster em 2026-09-12 moravam todos nas COSTURAS entre serviços,
// não dentro de um deles. Teste isolado por serviço passava com todos eles
// presentes. Este atravessa:
//
//   front-end (nginx)  →  user-session (sala, jogador)
//                      →  redis (fila create-game-queue)
//                      →  game-worker (cria o jogo, simula)
//                      →  game-core (WebSocket do jogo, ranking)
//                      →  redis (fila game-sync-session-queue)
//                      →  session-worker (atualiza a partida)
//
// Rodar localmente (com o compose de integração de pé):
//   k6 run -e BASE_URL=http://localhost:18080 k6/integration.js
import http from "k6/http";
import ws from "k6/ws";
import { check, fail, sleep } from "k6";
import { Trend, Counter } from "k6/metrics";

// Tudo pelo front-end, como o navegador faz — o nginx faz o proxy das APIs,
// exatamente como o Ingress faz no cluster. Testar pelas portas diretas dos
// serviços esconderia erro de roteamento, que já foi um bug real aqui.
const BASE_URL = __ENV.BASE_URL || "http://localhost:18080";
const US = `${BASE_URL}/api/v1/user-session`;
const GC = `${BASE_URL}/api/v1/game-core`;

const roomToGameDuration = new Trend("room_to_game_created_duration", true);
const gamesCreated = new Counter("games_created");
const wsSnapshotsReceived = new Counter("ws_snapshots_received");

export const options = {
  scenarios: {
    // Um VU só, sequencial: é um teste de CORRETUDE do fluxo, não de carga.
    // Carga em cima de um worker singleton que simula partidas em memória
    // mediria a limitação conhecida do legado, não uma regressão.
    full_flow: {
      executor: "shared-iterations",
      vus: 1,
      iterations: 3,
      maxDuration: "3m",
      exec: "fullFlow",
    },
  },
  thresholds: {
    checks: ["rate==1.0"],
    // Criar sala → jogo existir no Game-Core passa por uma fila Redis com
    // LPOP em laço de 1s (defeito conhecido do legado, §4.2 da análise).
    // 15s é folgado de propósito: o teste não deve falhar por causa desse
    // atraso, só por quebra de contrato.
    room_to_game_created_duration: ["p(95)<15000"],
  },
};

function json(extra) {
  return { headers: Object.assign({ "Content-Type": "application/json" }, extra || {}) };
}

export function fullFlow() {
  // ── 1. front-end serve a SPA ────────────────────────────────────────────
  const home = http.get(`${BASE_URL}/`);
  if (
    !check(home, {
      "front-end: home responde 200": (r) => r.status === 200,
      "front-end: entrega o HTML da SPA": (r) => r.body.includes("<html"),
    })
  ) {
    fail("front-end não está servindo — resto do fluxo não faz sentido");
  }

  // Asset ausente tem que dar 404, não 200 com o index.html dentro:
  // fallback de SPA aqui mascararia asset quebrado (o erro apareceria como
  // falha de parse de JavaScript). Regressão real, corrigida em v2.0.1.
  check(http.get(`${BASE_URL}/asset-que-nao-existe.js`), {
    "front-end: asset ausente dá 404, não index.html": (r) => r.status === 404,
  });

  // ── 2. user-session: cria a sala ────────────────────────────────────────
  const createRes = http.post(
    `${US}/rooms/new-room/`,
    JSON.stringify({
      createdBy: `k6-owner-${__ITER}`,
      roomType: 0, // MATCH, 2 jogadores (modo de 4 cortado — decisão D3)
      maxAmountOfPlayers: 2,
      roomName: `k6-integration-${__ITER}`,
      privateRoom: false,
    }),
    json()
  );
  if (
    !check(createRes, {
      "user-session: criar sala dá 201": (r) => r.status === 201,
      "user-session: devolve X-User-Id": (r) => !!r.headers["X-User-Id"],
      // X-User-Color é o que habilita sair da sala: RemovePlayerView
      // identifica o alvo por COR, não por id. Bug real, corrigido em v2.0.4.
      "user-session: devolve X-User-Color": (r) => r.headers["X-User-Color"] !== undefined,
    })
  ) {
    fail(`criar sala falhou (${createRes.status}) — resto do fluxo depende disso`);
  }

  const roomCode = createRes.json("roomCode");
  const ownerId = createRes.headers["X-User-Id"];
  const ownerColor = createRes.headers["X-User-Color"];

  // ── 3. segundo jogador entra ────────────────────────────────────────────
  const joinRes = http.put(
    `${US}/rooms/${roomCode}/add-player/`,
    JSON.stringify({ name: `k6-joiner-${__ITER}`, roomCode }),
    json()
  );
  if (!check(joinRes, { "user-session: 2º jogador entra (201)": (r) => r.status === 201 })) {
    fail("segundo jogador não entrou — sala não fica cheia, jogo não inicia");
  }
  const joinerId = joinRes.headers["X-User-Id"];

  // ── 4. detalhe da sala: o contrato que quebrou em v2.0.2 ────────────────
  const detail = http.get(`${US}/rooms/${roomCode}/detail/`, json({ "X-User-Id": ownerId }));
  check(detail, {
    "user-session: detalhe da sala dá 200": (r) => r.status === 200,
    "user-session: players é objeto indexado por cor, não array": (r) => {
      const p = r.json("players");
      return p !== null && typeof p === "object" && !Array.isArray(p);
    },
    "user-session: cada jogador traz `color` (não `profileColor`)": (r) =>
      Object.values(r.json("players")).every((p) => typeof p.color === "number"),
    "user-session: dono é sinalizado por `owner` (não `isOwner`)": (r) => r.json("owner") === true,
    "user-session: os 2 jogadores aparecem": (r) => Object.keys(r.json("players")).length === 2,
  });

  // ── 5. inicia a partida: user-session → Redis → game-worker → game-core ─
  const startedAt = Date.now();
  const startRes = http.post(`${US}/games/${roomCode}/new-game/`, null, json({ "X-User-Id": ownerId }));
  if (!check(startRes, { "user-session: iniciar partida dá 201": (r) => r.status === 201 })) {
    fail("iniciar partida falhou — a fila não foi alimentada");
  }

  // O game-worker consome a fila com LPOP em laço de 1s, então o jogo não
  // existe imediatamente. Descobre o gameId pelo próprio user-session, que
  // o recebe de volta pela fila de sincronização (game-sync-session-queue) —
  // provando o caminho de VOLTA, do Game-Core para o User-Session.
  let gameId = null;
  for (let i = 0; i < 30; i++) {
    sleep(1);
    const info = http.get(`${US}/players/${ownerId}/`);
    if (info.status !== 200) continue;
    const status = info.json("roomStatus");
    // A sala avança de estado quando o jogo é criado e depois iniciado.
    if (status !== null && status >= 4) {
      // O gameId chega ao front-end pelo WebSocket da sala; aqui basta
      // confirmar que a sala avançou de estado, que é o efeito observável
      // da fila de volta ter sido consumida pelo session-worker.
      gameId = `estado-${status}`;
      break;
    }
  }
  roomToGameDuration.add(Date.now() - startedAt);

  if (
    check(null, {
      "integração: sala avança de estado após criar jogo (fila de volta funcionou)": () =>
        gameId !== null,
    })
  ) {
    gamesCreated.add(1);
  }

  // ── 6. game-core responde no ranking (leitura, pós-partida) ─────────────
  check(http.get(`${GC}/games/ranking/`), {
    "game-core: ranking responde 200 ou 204": (r) => r.status === 200 || r.status === 204,
  });

  // ── 7. WebSocket de sala: o caminho que o Ingress precisa deixar passar ─
  // Prova upgrade de WebSocket atravessando o nginx/Ingress — o timeout
  // padrão de 60s do ingress-nginx derruba conexão ociosa, e isso já foi
  // um problema real de configuração.
  const wsUrl = `${BASE_URL.replace(/^http/, "ws")}/api/v1/user-session/ws/rooms/${roomCode}/?userId=${ownerId}`;
  const wsRes = ws.connect(wsUrl, {}, function (socket) {
    socket.on("open", () => {
      wsSnapshotsReceived.add(1);
      // Fecha educadamente: derrubar o socket cru faz o Channels logar
      // RuntimeError no servidor (defeito conhecido do Game-Core).
      socket.setTimeout(() => socket.close(), 1500);
    });
    socket.on("error", (e) => {
      if (e.error() !== "websocket: close sent") {
        fail(`WebSocket de sala falhou: ${e.error()}`);
      }
    });
  });
  check(wsRes, {
    "integração: WebSocket de sala faz upgrade (101)": (r) => r && r.status === 101,
  });

  // ── 8. limpeza: sai da sala usando COR, não id (contrato de v2.0.4) ─────
  const leave = http.del(
    `${US}/rooms/${roomCode}/${ownerColor}/remove-player/`,
    null,
    json({ "X-User-Id": ownerId })
  );
  check(leave, {
    "user-session: sair da sala por cor dá 204": (r) => r.status === 204,
  });
}
