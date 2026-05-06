# Changelog

## 0.1.0

- Versão inicial do add-on.
- Empacota HomeCore em container Alpine + Node 20.
- Network mode `host` pra Broadlink/Tuya/Sonoff LAN discovery.
- MQTT auto-config via serviço do supervisor.
- Persistência em `/data` (sobrevive a updates do add-on).
- Acesso direto via porta 3010 (ingress será habilitado em versão futura).
