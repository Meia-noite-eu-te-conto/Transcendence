# Argo CD

GitOps do `pong`: o Argo CD observa `manifests/` **neste repositório** e
sincroniza no namespace `pong`. Quem escreve lá é o CI, depois de passar no
teste de integração — nunca a mão.

```
submodule publica tag ─▶ imagem no ghcr.io
            │
pin do submodule sobe aqui (PR → main)
            │
    .github/workflows/integration.yml
       sobe o stack das imagens publicadas
       roda k6 atravessando os serviços
            │ passou?
            ▼
    commit em manifests/ (tags promovidas)
            │
     Argo CD detecta ─▶ PreSync: migrations ─▶ sync ─▶ cluster
```

## Por que não o Argo CD Image Updater

Ele observa o registry e promove assim que uma imagem nova aparece —
**pulando o teste de integração**, que é justamente o gate que se quer.
Aqui o git é a única fonte de verdade: só entra no cluster o que o CI
escreveu depois de testar.

## Instalação

O `install.yaml` oficial tem ~20 mil linhas; não vale versionar aqui. A
referência é pinada por versão, e só as **nossas customizações** ficam neste
diretório.

```sh
export PATH="/run/host/usr/local/bin:$PATH"   # kubectl, dentro do sandbox

# 1. namespace
kubectl apply -f manifests/argocd/00-namespace.yaml

# 2. Argo CD oficial, versão pinada (v3.5.2)
kubectl apply -n argocd \
  -f https://raw.githubusercontent.com/argoproj/argo-cd/v3.5.2/manifests/install.yaml

# 3. nossas customizações
kubectl apply -f manifests/argocd/10-cmd-params.yaml

# 4. requests/limits — o install.yaml vem SEM nenhum (tudo BestEffort).
#    Neste cluster, com 2 nós de ~3,7 GiB, isso não é aceitável.
bash manifests/argocd/apply-resource-limits.sh

# 5. reinicia para pegar server.insecure e os limites
kubectl -n argocd rollout restart deploy/argocd-server
kubectl -n argocd rollout status deploy/argocd-server --timeout=180s

# 6. certificado para argocd.homelab (mesmo procedimento do pong-tls;
#    o SAN do certificado já cobre *.homelab, então dá para reaproveitar)
kubectl get secret pong-tls -n pong -o json \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); d["metadata"]={"name":"argocd-tls","namespace":"argocd"}; print(json.dumps(d))' \
  | kubectl apply -f -

kubectl apply -f manifests/argocd/20-ingress.yaml

# 7. o Application que sincroniza o pong
kubectl apply -f manifests/argocd/30-application-pong.yaml
```

Depois disso, registre `argocd.homelab` no Pi-hole apontando para
`192.168.15.180` (o IP do ingress-nginx), como os outros hosts.

## Primeiro acesso

A senha inicial do usuário `admin` fica num secret gerado na instalação:

```sh
kubectl -n argocd get secret argocd-initial-admin-secret \
  -o jsonpath='{.data.password}' | base64 -d; echo
```

Troque a senha no primeiro login e **apague o secret** — ele existe só para o
bootstrap:

```sh
kubectl -n argocd delete secret argocd-initial-admin-secret
```

## Custo de memória

O `install.yaml` completo sobe 7 workloads. Com os limites do script:

| Workload | requests | limits |
| --- | --- | --- |
| `application-controller` | 256 Mi | 512 Mi |
| `repo-server` | 192 Mi | 384 Mi |
| `server` (UI/API) | 128 Mi | 256 Mi |
| `redis` | 64 Mi | 128 Mi |
| `applicationset-controller` | 96 Mi | 192 Mi |
| `notifications-controller` | 96 Mi | 192 Mi |
| `dex-server` | 48 Mi | 96 Mi |
| **total** | **~880 Mi** | ~1,7 GiB |

Contra ~4,1 GiB livres medidos, cabe — mas é o maior inquilino novo do
cluster. Se a memória apertar quando os serviços Go entrarem, os dois
primeiros candidatos a remover são `dex-server` (só serve SSO, e aqui o login
é local) e `notifications-controller` (não há notificação configurada):

```sh
kubectl -n argocd scale deploy/argocd-dex-server --replicas=0
kubectl -n argocd scale deploy/argocd-notifications-controller --replicas=0
```

## Decisões embutidas nos manifests

| Decisão | Onde | Por quê |
| --- | --- | --- |
| `server.insecure: true` | `10-cmd-params.yaml` | o Ingress termina TLS; sem isso há laço de redirecionamento e a UI não abre |
| `prune: false` | `30-application-pong.yaml` | prune automático apagaria PVC do Postgres (reclaim `Delete`) se alguém removesse um arquivo do git — perda de dado |
| `selfHeal: true` | idem | mudança feita à mão no cluster volta ao estado do git |
| `exclude: examples/**` | idem | `examples/secret.example.yaml` tem valores `TROCAR`; aplicá-lo sobrescreveria o secret real |
| `exclude: argocd/**` | idem | o Argo não gerencia a própria instalação — auto-gerência dificulta recuperar de erro |
| `CreateNamespace=false` | idem | o namespace e os secrets são criados à mão; secret nunca entra no git |
| Jobs como `PreSync` hook | `../20-migrations.yaml` | Job é imutável: sem hook, o segundo sync falha com "field is immutable". E migration precisa rodar antes do Deployment novo subir |

## Operação

```sh
kubectl -n argocd get application pong                 # estado de sync
kubectl -n argocd describe application pong            # diff e histórico
kubectl -n argocd logs deploy/argocd-application-controller --tail=50
```

Sync manual (o automático já cobre, mas útil para forçar):

```sh
kubectl -n argocd patch application pong --type merge \
  -p '{"operation":{"sync":{"revision":"main"}}}'
```
