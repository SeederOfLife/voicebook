#!/bin/bash
# One-time upgrade of a Voicebook server set up before 20 Nov 2026, plus a health report.
# From Oracle Cloud Shell:
#   ssh ubuntu@<ip> 'curl -fsSL https://raw.githubusercontent.com/SeederOfLife/voicebook/main/deploy/server-fix.sh | sudo bash'
set -u
echo "== machine"; uptime; nproc; free -g | head -2
echo "== containers"; docker ps -a --format '{{.Names}}  {{.Status}}'
echo "== last update log"; tail -4 /var/log/voicebook-update.log 2>/dev/null || echo "(none yet)"
pgrep -fa "docker build" >/dev/null && echo "!! a rebuild is running right now (this is why the voice is slow or away)"

cat > /usr/local/bin/voicebook-update <<'SCRIPT'
#!/bin/bash
cd /opt/voicebook && git fetch -q --depth 100 origin main && git reset -q --hard origin/main && exec bash /opt/voicebook/deploy/voicebook-update.sh "$@"
SCRIPT
chmod +x /usr/local/bin/voicebook-update
cd /opt/voicebook && git fetch -q --depth 100 origin main && git reset -q --hard origin/main
mkdir -p /var/lib/voicebook
# The running server is up to date for listening: don't rebuild just for this upgrade.
if docker ps -q -f name=^voicebook$ | grep -q . && ! pgrep -f "docker build" >/dev/null; then
  git rev-parse HEAD > /var/lib/voicebook/built
  docker tag voicebook voicebook:latest 2>/dev/null || true
fi
for ipt in iptables iptables-legacy iptables-nft; do
  command -v $ipt >/dev/null || continue
  for port in 443 80; do $ipt -C INPUT -p tcp --dport $port -j ACCEPT 2>/dev/null || $ipt -I INPUT 1 -p tcp --dport $port -j ACCEPT || true; done
done
docker start caddy >/dev/null 2>&1 || true
echo "== updater upgraded (rebuilds only for server changes, on one core, voice keeps running)"
echo "== voice test"
curl -sS -m 60 http://127.0.0.1:8080/api/voice?test=1 | head -c 220; echo
