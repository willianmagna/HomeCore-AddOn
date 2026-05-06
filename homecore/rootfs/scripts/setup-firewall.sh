#!/usr/bin/env bash
# HomeCore — abre UDP da LAN local pro server, idempotente.
#
# Por que é necessário:
#   - Discovery do Broadlink (Wi-Fi IR) usa UDP broadcast (porta 80), respostas
#     vêm de IPs distintos com porta-fonte 80 → conntrack não associa com a
#     "conexão" outgoing do broadcast → UFW (default deny) bloqueia as respostas.
#   - mDNS / Sonoff (Wi-Fi switches) também depende de tráfego UDP entrante.
#
# Uso: sudo ./scripts/setup-firewall.sh
#
# O script detecta automaticamente a LAN da interface de saída padrão e cria
# uma regra UFW restrita a essa subnet apenas (não abre Tailscale, Docker, WAN).
#
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "rode como root (sudo)" >&2
  exit 1
fi

if ! command -v ufw >/dev/null 2>&1; then
  echo "ufw não instalado — pulando (configure firewall manualmente se houver outro)" >&2
  exit 0
fi

# Detecta interface da rota default
IFACE=$(ip -4 route show default | awk '{print $5; exit}')
if [[ -z "${IFACE:-}" ]]; then
  echo "não consegui detectar interface default" >&2
  exit 1
fi

# IP + máscara da interface
IP_CIDR=$(ip -4 -o addr show dev "$IFACE" scope global | awk '{print $4; exit}')
if [[ -z "${IP_CIDR:-}" ]]; then
  echo "não consegui detectar IP da interface $IFACE" >&2
  exit 1
fi

LOCAL_IP="${IP_CIDR%/*}"
PREFIX="${IP_CIDR#*/}"

# Calcula subnet (network/prefix) usando python3 (presente em todas as distros sensatas)
SUBNET=$(python3 -c "import ipaddress; print(ipaddress.ip_interface('$IP_CIDR').network)")

echo "Interface: $IFACE  IP: $LOCAL_IP  Subnet: $SUBNET"

# Idempotente: ufw allow não duplica regras
ufw allow from "$SUBNET" to "$LOCAL_IP" proto udp comment 'HomeCore: Broadlink/mDNS UDP'
echo "regra adicionada (ou já existia)."
ufw status | grep -E "$LOCAL_IP|HomeCore" || true
