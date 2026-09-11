#!/usr/bin/env bash
# One-time preparation of a fresh Ubuntu 24.04 DigitalOcean droplet for the MKTR voice stack.
# Run as root over SSH:  ssh root@<ip> 'bash -s' < scripts/bootstrap-host.sh
# Idempotent: safe to re-run. Installs Docker Engine and Compose, adds a swap file so the
# FreeSWITCH image can be built on a 2 GB host, creates the mktr operator user, hardens SSH,
# and opens only the ports the stack needs, with SIP and RTP limited to Singtel's addresses.
set -euo pipefail

OPERATOR_USER="${OPERATOR_USER:-mktr}"
SWAP_GB="${SWAP_GB:-4}"
SINGTEL_SIGNALING_IP="${SINGTEL_SIGNALING_IP:-52.77.0.62}"
SINGTEL_SIP_HOST="${SINGTEL_SIP_HOST:-sipsg01.b3networks.com}"
# Singtel media range 54.251.255.196 to 54.251.255.211 as exact CIDR blocks.
SINGTEL_MEDIA_CIDRS="54.251.255.196/30 54.251.255.200/29 54.251.255.208/30"
RTP_PORTS="10000:10199"

export DEBIAN_FRONTEND=noninteractive

echo "==> System packages"
apt-get -o DPkg::Lock::Timeout=600 update -q
apt-get -o DPkg::Lock::Timeout=600 install -y -q --no-install-recommends ca-certificates curl gnupg ufw fail2ban rsync git jq unattended-upgrades

echo "==> Docker Engine and Compose plugin"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get -o DPkg::Lock::Timeout=600 update -q
  apt-get -o DPkg::Lock::Timeout=600 install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
docker --version
docker compose version

echo "==> Swap (${SWAP_GB} GB) for the FreeSWITCH source build"
if ! swapon --show | grep -q '^/swapfile'; then
  fallocate -l "${SWAP_GB}G" /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10 >/dev/null
grep -q '^vm.swappiness' /etc/sysctl.d/99-mktr.conf 2>/dev/null || echo 'vm.swappiness=10' >> /etc/sysctl.d/99-mktr.conf
free -m | head -3

echo "==> Operator user ${OPERATOR_USER}"
if ! id "${OPERATOR_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${OPERATOR_USER}"
fi
usermod -aG sudo,docker "${OPERATOR_USER}"
echo "${OPERATOR_USER} ALL=(ALL) NOPASSWD:ALL" > "/etc/sudoers.d/90-${OPERATOR_USER}"
chmod 440 "/etc/sudoers.d/90-${OPERATOR_USER}"
install -d -m 700 -o "${OPERATOR_USER}" -g "${OPERATOR_USER}" "/home/${OPERATOR_USER}/.ssh"
if [ -f /root/.ssh/authorized_keys ]; then
  install -m 600 -o "${OPERATOR_USER}" -g "${OPERATOR_USER}" /root/.ssh/authorized_keys "/home/${OPERATOR_USER}/.ssh/authorized_keys"
fi
install -d -m 750 -o root -g "${OPERATOR_USER}" /etc/mktr
install -d -m 755 -o "${OPERATOR_USER}" -g "${OPERATOR_USER}" /srv/mktr-bot

echo "==> SSH hardening (keys only, no root login) applied after the operator user can log in"
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/; s/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
rm -f /etc/ssh/sshd_config.d/50-cloud-init.conf
systemctl restart ssh

echo "==> Firewall"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw allow 80/tcp comment 'caddy http challenge'
ufw allow 443/tcp comment 'caddy https'
ufw allow 443/udp comment 'caddy http3'
ufw allow from "${SINGTEL_SIGNALING_IP}" to any port 5061 proto tcp comment 'singtel sip tls'
for ip in $(getent ahostsv4 "${SINGTEL_SIP_HOST}" | awk '{print $1}' | sort -u); do
  ufw allow from "${ip}" to any port 5061 proto tcp comment "singtel sip host ${ip}"
done
for cidr in ${SINGTEL_MEDIA_CIDRS}; do
  ufw allow from "${cidr}" to any port "${RTP_PORTS}" proto udp comment 'singtel srtp media'
done
ufw --force enable
ufw status numbered

echo "==> fail2ban and automatic security updates"
systemctl enable --now fail2ban
dpkg-reconfigure -f noninteractive unattended-upgrades >/dev/null 2>&1 || true

echo "==> Done. Public IPv4: $(curl -fsS --max-time 8 https://ifconfig.me || echo unknown)"
