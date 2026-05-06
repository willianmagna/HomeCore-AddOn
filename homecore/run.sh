#!/usr/bin/with-contenv bashio
set -e

# ─── MQTT do Home Assistant ───
if bashio::services.available "mqtt"; then
    export MQTT_HOST=$(bashio::services "mqtt" "host")
    export MQTT_PORT=$(bashio::services "mqtt" "port")
    export MQTT_USERNAME=$(bashio::services "mqtt" "username")
    export MQTT_PASSWORD=$(bashio::services "mqtt" "password")
    export MQTT_URL="mqtt://${MQTT_USERNAME}:${MQTT_PASSWORD}@${MQTT_HOST}:${MQTT_PORT}"
    export MQTT_DISCOVERY_PREFIX="homeassistant"
    bashio::log.info "MQTT do HA: ${MQTT_HOST}:${MQTT_PORT}"
else
    bashio::log.warning "Serviço MQTT do HA indisponível — instale e configure o add-on Mosquitto."
fi

# ─── Persistência ───
# /data é o volume persistente que o supervisor mantém entre updates do add-on.
# HomeCore grava em ./data/ por padrão; redirecionamos via symlink.
mkdir -p /data
if [ -e /app/data ] && [ ! -L /app/data ]; then
    rm -rf /app/data
fi
ln -sfn /data /app/data

# ─── Porta ───
export PORT=3010

# ─── Sobe o HomeCore ───
cd /app
bashio::log.info "Iniciando HomeCore na porta ${PORT}..."
exec node server.js
