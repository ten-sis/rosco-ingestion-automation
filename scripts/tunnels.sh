#!/usr/bin/env bash
#
# Opens, checks and closes every local tunnel the suite needs against a NONPROD cluster.
#
#   scripts/tunnels.sh up      [--context Dv3A] [--no-db]
#   scripts/tunnels.sh status
#   scripts/tunnels.sh down    [--keep-db]
#
# Four kubectl port-forwards (all four Services expose port 80 in the cluster):
#   be-crud      be-crud/be-crud-v5          localhost:3000  (MUST be 3000, see src/env.ts assertIntraServiceHost)
#   webhooks     integration/webhooks-api    localhost:8081  (WEBHOOK_PORT)
#   scorecards   snc/scorecard-v2-api        localhost:3001  (SCORECARDS_PORT)
#   digestion    ingestion/digestion         localhost:3002  (DIGESTION_PORT)
#
# The three configurable ports come from the shell environment first, then .env, then the
# defaults above. src/env.ts reads the same variables, so the suite calls the ports opened here.
#
# Each forward runs under a small supervisor that restarts it when kubectl exits. A
# `kubectl port-forward svc/...` is pinned to one pod, so it breaks whenever that pod goes away.
# On dv3 that happens often, because the private node group runs on spot instances that get
# reclaimed. Worse, kubectl does not always exit when its pod dies: it can keep listening and fail
# every connection for minutes. So the supervisor also sends an HTTP request through the forward
# every PROBE_INTERVAL_SECONDS and restarts kubectl after PROBE_FAILURES_BEFORE_RESTART in a row
# get no HTTP response at all. PIDs and logs live in .runs/tunnels/ (gitignored).
#
# Plus the read-only dv3 RDS tunnel on localhost:54334, a trimmed copy of
# _tools/engineering-tools/scripts/db-tunnel.sh --environment dv3 (RDS read replica only, no
# Redis/ES/Kibana, no read-write option). It needs nonprod AWS credentials for EC2 Instance
# Connect and ~/.ssh/id_rsa. Skipped when something already listens on 54334.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$ROOT_DIR/.runs/tunnels"

CONTEXT="${KUBE_CONTEXT:-Dv3A}"
WITH_DB=1
KEEP_DB=0

# KEY from the shell environment, else from a KEY=value line in .env (quotes stripped), else empty.
env_value() {
  local key="$1" value="${!1:-}"
  if [[ -z "$value" && -f "$ROOT_DIR/.env" ]]; then
    value="$(grep -E "^[[:space:]]*$key=" "$ROOT_DIR/.env" | tail -n 1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\'']$//' || true)"
  fi
  printf '%s' "$value"
}

# KEY's port, or DEFAULT when unset. Dies on anything that isn't a usable port.
port_setting() {
  local key="$1" default="$2" value
  value="$(env_value "$key")"
  [[ -z "$value" ]] && { printf '%s' "$default"; return; }
  [[ "$value" =~ ^[0-9]+$ ]] && (( value >= 1 && value <= 65535 )) || { printf '[tunnels] ERROR: %s="%s" is not a port number (1-65535).\n' "$key" "$value" >&2; exit 1; }
  (( value != 3000 )) || { printf '[tunnels] ERROR: %s=3000 collides with the backend-crud forward, which must own local port 3000.\n' "$key" >&2; exit 1; }
  printf '%s' "$value"
}

WEBHOOK_PORT="$(port_setting WEBHOOK_PORT 8081)"
SCORECARDS_PORT="$(port_setting SCORECARDS_PORT 3001)"
DIGESTION_PORT="$(port_setting DIGESTION_PORT 3002)"

# name|namespace|service|localPort|servicePort
FORWARDS=(
  "be-crud|be-crud|be-crud-v5|3000|80"
  "webhooks|integration|webhooks-api|$WEBHOOK_PORT|80"
  "scorecards|snc|scorecard-v2-api|$SCORECARDS_PORT|80"
  "digestion|ingestion|digestion|$DIGESTION_PORT|80"
)

# dv3 values copied from db-tunnel.sh's `dv3)` case. Read-only replica only.
DB_LOCAL_PORT=54334
DB_HOST=dv3-pg-cluster-ro.private.dv3.cloud.tenna.com
DB_PORT=5432
DB_BASTION=bastion-datastore.public.dv3.cloud.tenna.com
DB_BASTION_INSTANCE=i-01091996245b7a97f
DB_BASTION_AZ=us-east-1a
DB_REGION=us-east-1
SSH_SECRET_KEY="${SSH_SECRET_KEY:-$HOME/.ssh/id_rsa}"
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-$HOME/.ssh/id_rsa.pub}"
AWS_PROFILE_NAME="${AWS_PROFILE:-default}"

READY_TIMEOUT_SECONDS=20
RESTART_DELAY_SECONDS=2
PROBE_INTERVAL_SECONDS=5
PROBE_FAILURES_BEFORE_RESTART=2

log() { printf '[tunnels] %s\n' "$*"; }
die() { printf '[tunnels] ERROR: %s\n' "$*" >&2; exit 1; }

is_listening() { nc -z 127.0.0.1 "$1" >/dev/null 2>&1; }

assert_nonprod_context() {
  local lowered
  lowered="$(printf '%s' "$CONTEXT" | tr '[:upper:]' '[:lower:]')"
  case "$lowered" in
    *prd*|*prod*) die "refusing kube context \"$CONTEXT\": it looks like production." ;;
  esac
  kubectl config get-contexts -o name | grep -qx "$CONTEXT" \
    || die "kube context \"$CONTEXT\" does not exist (kubectl config get-contexts)."
}

start_forward() {
  local name="$1" ns="$2" svc="$3" lport="$4" rport="$5"
  local pidfile="$STATE_DIR/$name.pid" logfile="$STATE_DIR/$name.log"

  if [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null; then
    log "$name already supervised (pid $(cat "$pidfile"))."
    return
  fi
  if is_listening "$lport"; then
    die "port $lport is already taken by something this script does not own: $(lsof -nP -iTCP:"$lport" -sTCP:LISTEN | tail -n +2 | awk '{print $1" pid "$2}' | head -1)"
  fi

  # Supervisor: this same script, re-run as `_supervise` (see `supervise` below).
  nohup "$ROOT_DIR/scripts/tunnels.sh" _supervise "$CONTEXT" "$ns" "$svc" "$lport" "$rport" >"$logfile" 2>&1 &
  echo $! >"$pidfile"
  log "$name: $ns/svc/$svc -> localhost:$lport (supervisor pid $!, log .runs/tunnels/$name.log)"
}

# Runs one port-forward until killed: starts kubectl, probes the forward over HTTP, and restarts
# kubectl when it exits or stops answering. Any HTTP status counts as healthy (the probe only proves
# a live pod is behind the forward). "000" means no HTTP response, which is what a forward still
# pinned to a dead pod returns.
supervise() {
  local context="$1" ns="$2" svc="$3" lport="$4" rport="$5" kpid="" fails=0 code="" rc=0
  trap 'kill "$kpid" 2>/dev/null; exit 0' TERM INT
  while true; do
    echo "$(date -u +%FT%TZ) starting port-forward $ns/svc/$svc $lport:$rport"
    kubectl --context "$context" port-forward -n "$ns" "svc/$svc" "$lport:$rport" --address 127.0.0.1 &
    kpid=$!
    fails=0
    while kill -0 "$kpid" 2>/dev/null; do
      sleep "$PROBE_INTERVAL_SECONDS"
      kill -0 "$kpid" 2>/dev/null || break
      code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' "http://127.0.0.1:$lport/" || true)"
      if [[ "$code" == "000" ]]; then fails=$((fails + 1)); else fails=0; fi
      if (( fails >= PROBE_FAILURES_BEFORE_RESTART )); then
        echo "$(date -u +%FT%TZ) forward on $lport gave no HTTP response $fails times in a row, restarting kubectl"
        kill "$kpid" 2>/dev/null || true
      fi
    done
    rc=0
    wait "$kpid" 2>/dev/null || rc=$?
    echo "$(date -u +%FT%TZ) port-forward exited with $rc, restarting in ${RESTART_DELAY_SECONDS}s"
    sleep "$RESTART_DELAY_SECONDS"
  done
}

start_db_tunnel() {
  if is_listening "$DB_LOCAL_PORT"; then
    log "db: localhost:$DB_LOCAL_PORT already listening, leaving it alone."
    return
  fi
  [[ -f "$SSH_SECRET_KEY" && -f "$SSH_PUBLIC_KEY" ]] || die "db: SSH key pair not found ($SSH_SECRET_KEY)."
  command -v aws >/dev/null || die "db: aws CLI not found."

  log "db: pushing SSH key to bastion via EC2 Instance Connect (profile $AWS_PROFILE_NAME)."
  aws ec2-instance-connect send-ssh-public-key \
    --instance-id "$DB_BASTION_INSTANCE" --availability-zone "$DB_BASTION_AZ" \
    --instance-os-user ec2-user --ssh-public-key "file://$SSH_PUBLIC_KEY" \
    --region "$DB_REGION" --profile "$AWS_PROFILE_NAME" --no-cli-pager >/dev/null \
    || die "db: EC2 Instance Connect failed. Nonprod AWS credentials are needed for the dv3 bastion."

  ssh -i "$SSH_SECRET_KEY" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -L "$DB_LOCAL_PORT:$DB_HOST:$DB_PORT" -N -f "ec2-user@$DB_BASTION"
  log "db: read-only dv3 RDS -> localhost:$DB_LOCAL_PORT"
}

wait_ready() {
  local deadline=$((SECONDS + READY_TIMEOUT_SECONDS)) entry name lport pending
  while :; do
    pending=""
    for entry in "${FORWARDS[@]}"; do
      IFS='|' read -r name _ _ lport _ <<<"$entry"
      is_listening "$lport" || pending="$pending $name:$lport"
    done
    [[ -z "$pending" ]] && return 0
    if (( SECONDS >= deadline )); then
      log "not listening after ${READY_TIMEOUT_SECONDS}s:$pending (see .runs/tunnels/*.log)"
      return 1
    fi
    sleep 1
  done
}

cmd_up() {
  command -v kubectl >/dev/null || die "kubectl not found."
  assert_nonprod_context
  mkdir -p "$STATE_DIR"
  echo "$CONTEXT" >"$STATE_DIR/context"
  log "kube context: $CONTEXT"
  local entry
  for entry in "${FORWARDS[@]}"; do
    IFS='|' read -r name ns svc lport rport <<<"$entry"
    start_forward "$name" "$ns" "$svc" "$lport" "$rport"
  done
  (( WITH_DB )) && start_db_tunnel
  wait_ready
  cmd_status
}

cmd_status() {
  local entry name lport ok=0 ctx="(unknown)"
  [[ -f "$STATE_DIR/context" ]] && ctx="$(cat "$STATE_DIR/context")"
  log "context: $ctx"
  for entry in "${FORWARDS[@]}"; do
    IFS='|' read -r name _ _ lport _ <<<"$entry"
    if is_listening "$lport"; then log "  UP    $name localhost:$lport"; else log "  DOWN  $name localhost:$lport"; ok=1; fi
  done
  if is_listening "$DB_LOCAL_PORT"; then log "  UP    db localhost:$DB_LOCAL_PORT"; else log "  DOWN  db localhost:$DB_LOCAL_PORT (optional)"; fi
  return $ok
}

cmd_down() {
  local entry name pidfile pid
  for entry in "${FORWARDS[@]}"; do
    IFS='|' read -r name _ _ _ _ <<<"$entry"
    pidfile="$STATE_DIR/$name.pid"
    [[ -f "$pidfile" ]] || continue
    pid="$(cat "$pidfile")"
    # Kill the supervisor first so it cannot restart kubectl, then its kubectl child.
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
    pkill -P "$pid" 2>/dev/null || true
    rm -f "$pidfile"
    log "$name stopped."
  done
  if (( ! KEEP_DB )); then
    pkill -f "ssh .*-L $DB_LOCAL_PORT:$DB_HOST" 2>/dev/null && log "db tunnel stopped." || true
  fi
}

ACTION="${1:-}"
[[ $# -gt 0 ]] && shift
[[ "$ACTION" == "_supervise" ]] && { supervise "$@"; exit 0; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --context) CONTEXT="$2"; shift 2 ;;
    --no-db) WITH_DB=0; shift ;;
    --keep-db) KEEP_DB=1; shift ;;
    *) die "unknown option $1" ;;
  esac
done

case "$ACTION" in
  up) cmd_up ;;
  status) cmd_status ;;
  down) cmd_down ;;
  *) echo "usage: $0 up [--context Dv3A] [--no-db] | status | down [--keep-db]" >&2; exit 2 ;;
esac
