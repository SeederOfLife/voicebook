#!/bin/bash
# Voicebook voice server on an Oracle Cloud "Always Free" Arm machine (Ubuntu).
# Paste this one line into "Initialization script" (cloud-init) when creating the machine:
#   #!/bin/bash
#   curl -fsSL https://raw.githubusercontent.com/SeederOfLife/voicebook/main/deploy/oracle-setup.sh | bash
# It installs Docker, builds the voice server from GitHub, serves it over HTTPS at
# https://<public-ip-with-dashes>.sslip.io (free certificate, renewed by itself),
# restarts it after reboots, and updates it every hour from GitHub.
set -eux
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y docker.io git curl iptables-persistent
systemctl enable --now docker

# Oracle's Ubuntu images block web ports in the machine's own firewall: open 80 and 443.
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT || iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT || iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
netfilter-persistent save || true

# Optional settings (e.g. GEMINI_API_KEY=..., APP_PASSWORD=...), one per line.
touch /etc/voicebook.env
chmod 600 /etc/voicebook.env

[ -d /opt/voicebook ] || git clone --depth 1 https://github.com/SeederOfLife/voicebook.git /opt/voicebook

cat > /usr/local/bin/voicebook-update <<'SCRIPT'
#!/bin/bash
# Rebuilds and restarts the voice server when GitHub has newer code (or on first run).
set -e
cd /opt/voicebook
git fetch -q --depth 1 origin main
if [ "$1" != "--force" ] && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] && docker ps -q -f name=^voicebook$ | grep -q .; then exit 0; fi
git reset -q --hard origin/main
docker build -t voicebook . 
docker rm -f voicebook 2>/dev/null || true
docker run -d --name voicebook --restart unless-stopped -p 127.0.0.1:8080:8080 -e PORT=8080 --env-file /etc/voicebook.env voicebook
docker image prune -f >/dev/null
SCRIPT
chmod +x /usr/local/bin/voicebook-update
/usr/local/bin/voicebook-update --force

# HTTPS in front (Caddy gets and renews a free certificate for the sslip.io name).
IP=$(curl -fsS https://api.ipify.org)
HOST="${IP//./-}.sslip.io"
docker rm -f caddy 2>/dev/null || true
docker run -d --name caddy --restart unless-stopped --network host -v caddy_data:/data caddy:2 \
  caddy reverse-proxy --from "$HOST" --to localhost:8080
echo "https://$HOST" > /opt/voicebook-address.txt

# Keep it on the newest code.
echo "17 * * * * root /usr/local/bin/voicebook-update >> /var/log/voicebook-update.log 2>&1" > /etc/cron.d/voicebook
echo "Voicebook voice server: https://$HOST"
