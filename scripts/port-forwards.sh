#!/usr/bin/env bash
set -euo pipefail

services=(taskboard argocd grafana prometheus)
namespaces=(taskboard argocd monitoring monitoring)
targets=(web argocd-server grafana prometheus)
ports=(4080:8080 4081:443 4082:3000 4083:9090)
urls=(http://localhost:4080 https://localhost:4081 http://localhost:4082 http://localhost:4083/targets)

case "${1:-}" in
  start|stop|status) action=$1 ;;
  *)
    printf 'Usage: %s {start|stop|status}\n' "$0" >&2
    exit 2
    ;;
esac

if ! systemctl --user show-environment >/dev/null; then
  printf 'A running systemd user session is required.\n' >&2
  exit 1
fi

if [[ $action == start ]]; then
  kubectl_path=$(command -v kubectl)
  kubeconfig=${KUBECONFIG:-$HOME/.kube/config}
  "$kubectl_path" --context=lab get node lab >/dev/null
fi

result=0
for i in "${!services[@]}"; do
  unit="lab-forward-${services[i]}.service"
  state=$(systemctl --user show "$unit" --property=LoadState --value) || {
    [[ $state == not-found ]] || exit 1
  }
  if [[ $state == not-found && $action == status ]]; then
    printf '%-12s %-14s %s\n' "${services[i]}" stopped "${urls[i]}"
    result=1
    continue
  fi
  case "$action" in
    start)
      if [[ $state == not-found ]]; then
        systemd-run --user --unit="$unit" --collect           --working-directory="$PWD" --setenv="KUBECONFIG=$kubeconfig"           --property=Type=exec --property=Restart=always --property=RestartSec=5s           "$kubectl_path" --context=lab -n "${namespaces[i]}" port-forward           --address=localhost "svc/${targets[i]}" "${ports[i]}" || result=1
      else
        printf '%s already registered\n' "$unit"
      fi
      ;;
    stop)
      if [[ $state != not-found ]]; then
        systemctl --user stop "$unit" || result=1
      fi
      ;;
    status)
      active_state=$(systemctl --user show "$unit" --property=ActiveState --value)
      printf '%-12s %-14s %s\n' "${services[i]}" "$active_state" "${urls[i]}"
      if [[ $active_state != active ]]; then
        result=1
      fi
      ;;
  esac
done

exit "$result"
