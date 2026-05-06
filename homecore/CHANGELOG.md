# Changelog

## 0.2.1

- Corrige `s6-envdir: fatal: unable to envdir /run/s6/container_environment`. O `ENTRYPOINT tini` que eu tinha posto impedia o s6-overlay (que vem na base do HA) de subir como PID 1, e sem isso o `with-contenv bashio` no `run.sh` não tinha o env do supervisor pra ler.
- Adiciona icon/logo do HomeCore.

## 0.2.0

- **Ingress habilitado** — clique em "OPEN WEB UI" dentro do HA agora abre o HomeCore via Nabu Casa, sem VPN.
- Mini proxy interno (porta 8099) intercepta URLs absolutas (`/api/*`, WebSocket, XHR) e prefixa com o caminho do ingress no browser. Sem patch no HomeCore.
- Acesso LAN direto via porta 3010 continua funcionando pra dev.

## 0.1.0

- Versão inicial do add-on.
- Empacota HomeCore em container Alpine + Node 20.
- Network mode `host` pra Broadlink/Tuya/Sonoff LAN discovery.
- MQTT auto-config via serviço do supervisor.
- Persistência em `/data` (sobrevive a updates do add-on).
- Acesso direto via porta 3010 (ingress será habilitado em versão futura).
