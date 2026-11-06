#!/bin/bash
# Zet de meetserver neer of werkt hem bij, op een kale Ubuntu 24.04-server (Hetzner of elders).
# Idempotent: mag vaker draaien. Aanroepen als root vanuit /opt/meet: bash deploy/install.sh
# Geen geheime sleutels nodig: de meetserver maakt zijn eigen sleutelpaar; de openbare sleutel van
# rapportage staat in config/clients.json (in GitHub).
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$(pwd)"
IMAGE=websitegesprek-meet:latest

echo "== Pakketten"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q docker.io caddy git iptables unattended-upgrades ca-certificates
systemctl enable --now docker

echo "== Docker-logboek begrenzen"
mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  printf '{\n  "log-driver": "json-file",\n  "log-opts": { "max-size": "10m", "max-file": "3" }\n}\n' > /etc/docker/daemon.json
  systemctl restart docker
fi

echo "== Automatische beveiligingsupdates"
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

echo "== SSH: geen wachtwoorden"
mkdir -p /etc/ssh/sshd_config.d
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/10-meet.conf
systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || true

echo "== Netwerk en firewall voor de container"
docker network inspect meetnet >/dev/null 2>&1 || docker network create --driver bridge --subnet 172.30.0.0/24 -o com.docker.network.bridge.name=br-meet meetnet
install -m 0755 deploy/firewall.sh /usr/local/sbin/meet-firewall
cat > /etc/systemd/system/meet-firewall.service <<'EOF'
[Unit]
Description=Firewall meetserver Websitegesprek
After=docker.service
Requires=docker.service
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/meet-firewall
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
EOF

echo "== Image bouwen"
docker build --pull -t "$IMAGE" .

echo "== Dienst"
cat > /etc/systemd/system/meet.service <<EOF
[Unit]
Description=Meetserver Websitegesprek
After=docker.service meet-firewall.service
Requires=docker.service meet-firewall.service
[Service]
Restart=always
RestartSec=5
ExecStartPre=-/usr/bin/docker rm -f meet
ExecStart=/usr/bin/docker run --rm --name meet --network meetnet -p 127.0.0.1:8080:8080 \\
  --shm-size=1g --memory=3g --pids-limit=1024 --cap-drop=ALL \\
  --security-opt seccomp=$DIR/deploy/seccomp_profile.json \\
  -v meetdata:/data -e MEET_PUBLIC_BASE=https://meet.websitegesprek.nl $IMAGE
ExecStop=/usr/bin/docker stop -t 20 meet
[Install]
WantedBy=multi-user.target
EOF

echo "== Wekelijks bijwerken (zondag 04:17): code uit GitHub, nieuwste basis-image, herstart"
cat > /etc/systemd/system/meet-update.service <<EOF
[Unit]
Description=Meetserver bijwerken
[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=/bin/bash -c 'git fetch -q origin && git reset -q --hard origin/main && bash deploy/install.sh'
EOF
cat > /etc/systemd/system/meet-update.timer <<'EOF'
[Unit]
Description=Meetserver wekelijks bijwerken
[Timer]
OnCalendar=Sun *-*-* 04:17:00
Persistent=true
[Install]
WantedBy=timers.target
EOF

echo "== Caddy (https)"
mkdir -p /etc/meet
touch /etc/meet/rapportage-ip
if [ -s /etc/meet/rapportage-ip ]; then
  IP="$(head -n1 /etc/meet/rapportage-ip | tr -dc '0-9a-fA-F:.')"
  printf '@nietrapportage {\n\tpath /v1/measure\n\tnot remote_ip %s\n}\nrespond @nietrapportage 403\n' "$IP" > /etc/meet/caddy-allow.conf
else
  : > /etc/meet/caddy-allow.conf
fi
install -m 0644 deploy/Caddyfile /etc/caddy/Caddyfile

systemctl daemon-reload
systemctl enable --now meet-firewall.service
systemctl restart meet-firewall.service
systemctl enable meet.service meet-update.timer
systemctl restart meet.service
systemctl start meet-update.timer
systemctl enable caddy
systemctl reload caddy 2>/dev/null || systemctl restart caddy

echo "== Controle"
for i in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:8080/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:8080/healthz && echo
echo "Openbare sleutel van deze meetserver (voor rapportage):"
curl -fsS http://127.0.0.1:8080/v1/pubkey && echo
echo "Klaar."
