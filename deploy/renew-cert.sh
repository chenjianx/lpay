#!/usr/bin/env bash
set -euo pipefail

exec 9>/run/lpay-certbot-renew.lock
flock -n 9

docker run --rm --network host \
  --mount type=bind,src=/opt/lpay/letsencrypt,dst=/etc/letsencrypt \
  --mount type=bind,src=/opt/lpay/acme,dst=/srv/acme \
  --mount type=bind,src=/opt/lpay/letsencrypt-lib,dst=/var/lib/letsencrypt \
  --mount type=bind,src=/opt/lpay/letsencrypt-logs,dst=/var/log/letsencrypt \
  sha256:f70ad0adbb7e117f0fe42a63c553f28ea451edabc0148757b6efcd9735acaa20 \
  renew --quiet --preferred-profile shortlived --no-random-sleep-on-renew

docker exec lpay-edge caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile
