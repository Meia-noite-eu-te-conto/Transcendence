#!/usr/bin/env bash
# O install.yaml oficial do Argo CD vem SEM requests/limits — todos os pods
# ficam BestEffort, primeiros candidatos ao OOM killer. Neste cluster isso
# importa: são 2 nós de ~3,7 GiB e o nami já opera perto de 57%.
#
# Os valores abaixo são conservadores para um cluster que gerencia UM
# Application. Se o Argo começar a ficar lento com mais apps, o
# application-controller é o primeiro a precisar de mais memória.
#
# Rodar depois do install.yaml oficial:
#   bash manifests/argocd/apply-resource-limits.sh
set -euo pipefail

patch_deploy() {
  local name="$1" cpu_req="$2" mem_req="$3" cpu_lim="$4" mem_lim="$5"
  kubectl -n argocd patch deployment "$name" --type=json -p "$(cat <<JSON
[{"op":"add","path":"/spec/template/spec/containers/0/resources","value":{
  "requests":{"cpu":"${cpu_req}","memory":"${mem_req}"},
  "limits":{"cpu":"${cpu_lim}","memory":"${mem_lim}"}}}]
JSON
)"
}

patch_sts() {
  local name="$1" cpu_req="$2" mem_req="$3" cpu_lim="$4" mem_lim="$5"
  kubectl -n argocd patch statefulset "$name" --type=json -p "$(cat <<JSON
[{"op":"add","path":"/spec/template/spec/containers/0/resources","value":{
  "requests":{"cpu":"${cpu_req}","memory":"${mem_req}"},
  "limits":{"cpu":"${cpu_lim}","memory":"${mem_lim}"}}}]
JSON
)"
}

# O controller é o que mais consome: mantém o cache do estado do cluster.
patch_sts    argocd-application-controller 100m 256Mi 500m 512Mi
# repo-server clona e renderiza manifests; picos no clone.
patch_deploy argocd-repo-server           100m 192Mi 500m 384Mi
patch_deploy argocd-server                 50m 128Mi 300m 256Mi
patch_deploy argocd-redis                  25m  64Mi 200m 128Mi
patch_deploy argocd-dex-server             10m  48Mi 100m  96Mi
patch_deploy argocd-applicationset-controller 25m 96Mi 200m 192Mi
patch_deploy argocd-notifications-controller  25m 96Mi 200m 192Mi

echo
echo "requests somados: ~880Mi de RAM, ~335m de CPU"
kubectl -n argocd get deploy,statefulset -o custom-columns=\
'NOME:.metadata.name,REQ-MEM:.spec.template.spec.containers[0].resources.requests.memory'
