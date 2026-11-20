#!/bin/bash
# Keeps the Oracle voice server on the newest code. Run every hour by
# /usr/local/bin/voicebook-update, which first pulls this repository into /opt/voicebook,
# so changes to this file apply by themselves.
#   voicebook-update.sh            rebuild only if the server's own code changed
#   voicebook-update.sh --force    rebuild now
set -e
cd /opt/voicebook
mkdir -p /var/lib/voicebook
LOCK=/var/lib/voicebook/update.lock
exec 9>"$LOCK"
flock -n 9 || { echo "an update is already running"; exit 0; }

# Web ports stay open in both firewall layers (Oracle's Ubuntu images block them).
for ipt in iptables iptables-legacy iptables-nft; do
  command -v $ipt >/dev/null || continue
  for port in 443 80; do $ipt -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || $ipt -I INPUT 1 -p tcp --dport $port -j ACCEPT || true; done
done

# Bring the containers back if they stopped for any reason.
docker start caddy >/dev/null 2>&1 || true
docker ps -a -q -f name=^voicebook$ | grep -q . && docker start voicebook >/dev/null 2>&1 || true

NEW=$(git rev-parse HEAD)
OLD=$(cat /var/lib/voicebook/built 2>/dev/null || echo none)
RUNNING=$(docker ps -q -f name=^voicebook$)
if [ "${1:-}" != "--force" ] && [ -n "$RUNNING" ]; then
  [ "$OLD" = "$NEW" ] && exit 0
  # Most changes are to the app's screens (served by GitHub Pages), not to the voice
  # server: only rebuild when files the server uses have changed.
  if [ "$OLD" != none ] && git cat-file -e "$OLD^{commit}" 2>/dev/null; then
    if ! git diff --name-only "$OLD" "$NEW" | grep -qE '^(app/api/|lib/studio/|lib/llm|lib/prompts|lib/types|lib/access|lib/supabase|Dockerfile|package(-lock)?\.json|next\.config|scripts/|middleware|proxy)'; then
      echo "$NEW" > /var/lib/voicebook/built
      echo "no server changes in $OLD..$NEW"
      exit 0
    fi
  fi
fi

echo "$(date -u +%FT%TZ) building $NEW"
# Built on one core at low priority, so the running voice keeps answering meanwhile.
DOCKER_BUILDKIT=0 nice -n 19 docker build --cpuset-cpus 0 --cpu-shares 128 -t voicebook:next . >/var/log/voicebook-build.log 2>&1 \
  || nice -n 19 docker build -t voicebook:next . >>/var/log/voicebook-build.log 2>&1 \
  || { echo "build failed (see /var/log/voicebook-build.log); the running server is kept"; tail -5 /var/log/voicebook-build.log; exit 1; }
docker tag voicebook:next voicebook:latest
docker rm -f voicebook >/dev/null 2>&1 || true
docker run -d --name voicebook --restart unless-stopped --cpu-shares 4096 -p 127.0.0.1:8080:8080 -e PORT=8080 \
  --env-file /etc/voicebook.env voicebook:latest >/dev/null
echo "$NEW" > /var/lib/voicebook/built
# Warm the voice so the first listener doesn't wait.
for i in $(seq 1 30); do curl -fsS -m 60 "http://127.0.0.1:8080/api/voice?test=1" >/dev/null 2>&1 && break; sleep 2; done
docker image prune -f >/dev/null
echo "$(date -u +%FT%TZ) running $NEW"
