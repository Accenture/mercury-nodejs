#!/usr/bin/env bash
# A Keycloak development issuer for the oauth2 mode of the agent-question UI and the ask-person reply page.
#
#   KC_BOOTSTRAP_ADMIN_PASSWORD=... dev/keycloak.sh start   # run Keycloak with the realm of dev/realm.json imported
#   KEYCLOAK_TEST_PASSWORD=...      dev/keycloak.sh user    # add a person to sign in as (KEYCLOAK_TEST_USER, default operator)
#                                   dev/keycloak.sh env     # print the environment the backends take
#                                   dev/keycloak.sh stop    # remove the container
#
# The realm file holds no credential: the admin console password and the test person's password come from the
# environment of the shell that runs this script and are never written to the repository or printed. The realm
# `mercury` has one public client, `agent-question-ui` (Authorization Code with PKCE), whose access tokens carry the
# audience `agent-question`; both backends validate against the realm's issuer.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
IMAGE="${KEYCLOAK_IMAGE:-quay.io/keycloak/keycloak:26.8}"
NAME="${KEYCLOAK_CONTAINER:-mercury-keycloak}"
PORT="${KEYCLOAK_PORT:-8180}"
BASE="http://127.0.0.1:${PORT}"
REALM="mercury"
ISSUER="${BASE}/realms/${REALM}"
ADMIN_USER="${KC_BOOTSTRAP_ADMIN_USERNAME:-admin}"

need() { command -v "$1" >/dev/null 2>&1 || { echo "$1 is required" >&2; exit 1; }; }

admin_token() {
  : "${KC_BOOTSTRAP_ADMIN_PASSWORD:?set KC_BOOTSTRAP_ADMIN_PASSWORD - the admin console password this issuer was started with}"
  # the password travels on stdin to curl (--data-urlencode reads '@-' from stdin), never on a command line
  printf '%s' "${KC_BOOTSTRAP_ADMIN_PASSWORD}" | curl -sS --fail -X POST "${BASE}/realms/master/protocol/openid-connect/token" \
    -d grant_type=password -d client_id=admin-cli --data-urlencode "username=${ADMIN_USER}" --data-urlencode "password@-" \
    | python3 -c 'import json, sys; print(json.load(sys.stdin)["access_token"])'
}

case "${1:-}" in
  start)
    need docker; need curl
    : "${KC_BOOTSTRAP_ADMIN_PASSWORD:?set KC_BOOTSTRAP_ADMIN_PASSWORD - the admin console password of this development issuer (choose one; it is never stored here)}"
    if docker ps -a --format '{{.Names}}' | grep -qx "${NAME}"; then
      echo "Container ${NAME} exists - 'dev/keycloak.sh stop' first" >&2; exit 1
    fi
    docker run -d --name "${NAME}" -p "${PORT}:8080" \
      -e KC_BOOTSTRAP_ADMIN_USERNAME="${ADMIN_USER}" -e KC_BOOTSTRAP_ADMIN_PASSWORD \
      -v "${here}/realm.json:/opt/keycloak/data/import/realm.json:ro" \
      "${IMAGE}" start-dev --import-realm >/dev/null
    printf 'Waiting for %s' "${ISSUER}"
    for _ in $(seq 1 60); do
      if curl -sf "${ISSUER}/.well-known/openid-configuration" >/dev/null 2>&1; then echo " - ready"; "$0" env; exit 0; fi
      printf '.'; sleep 2
    done
    echo " - not ready after 120 s; docker logs ${NAME}" >&2; exit 1
    ;;
  user)
    need curl; need python3
    : "${KEYCLOAK_TEST_PASSWORD:?set KEYCLOAK_TEST_PASSWORD - the password of the person to add (never stored here)}"
    TEST_USER="${KEYCLOAK_TEST_USER:-operator}"
    TOKEN="$(admin_token)"
    # the body is built from the environment by python, so the password is on no command line
    python3 - <<'PY' | curl -sS --fail -o /dev/null -w "user ${TEST_USER} created (%{http_code})\n" -X POST "${BASE}/admin/realms/${REALM}/users" \
      -H "authorization: Bearer ${TOKEN}" -H 'content-type: application/json' --data @-
import json, os
print(json.dumps({
    "username": os.environ.get("KEYCLOAK_TEST_USER", "operator"),
    "enabled": True,
    "emailVerified": True,
    "email": f'{os.environ.get("KEYCLOAK_TEST_USER", "operator")}@example.test',
    "firstName": "Test", "lastName": "Operator",
    "credentials": [{"type": "password", "value": os.environ["KEYCLOAK_TEST_PASSWORD"], "temporary": False}]
}))
PY
    ;;
  env)
    cat <<ENV
# the agent-question backend (either pack)
export QUESTION_OIDC_ISSUER=${ISSUER}
export QUESTION_OIDC_AUDIENCE=agent-question
export QUESTION_OIDC_CLIENT_ID=agent-question-ui
# the ask-person reply page
export ASK_OIDC_ISSUER=${ISSUER}
export ASK_OIDC_AUDIENCE=agent-question
export ASK_OIDC_CLIENT_ID=agent-question-ui
# then start each with -Dquestion.auth=oauth2 / -Dask.reply.auth=oauth2; the admin console is ${BASE}/admin/ (user ${ADMIN_USER})
ENV
    ;;
  stop)
    need docker
    docker rm -f "${NAME}" >/dev/null && echo "removed ${NAME}"
    ;;
  *)
    sed -n '2,10p' "$0"; exit 2
    ;;
esac
