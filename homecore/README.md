# HomeCore

Marketplace de automação residencial — Sonoff/Tuya Wi-Fi, Zigbee e IR Broadlink integrados via MQTT Discovery.

## Pré-requisitos

- Home Assistant **OS** ou **Supervised** (não funciona em Core / Container).
- Add-on **Mosquitto broker** instalado e rodando (HomeCore publica entidades via MQTT Discovery).

## Instalação

1. **Settings → Add-ons → Add-on Store**.
2. Menu **⋮** → **Repositories** → adicione `https://github.com/willianmagna/HomeCore-AddOn`.
3. Procure **HomeCore** na loja e clique **Install**.
4. Aba **Configuration** — não precisa mexer (vazio por padrão).
5. **Start**.

## Acesso à interface

Como o ingress ainda não está habilitado nesta versão, acesse direto:

```
http://<ip-do-home-assistant>:3010
```

(`host_network: true` faz o HomeCore escutar direto na rede local do HA.)

## O que o add-on faz

- **Network mode `host`**: necessário pra Broadlink discovery (UDP broadcast na LAN) e Tuya/Sonoff LAN protocol.
- **MQTT auto-config**: lê credenciais do Mosquitto do HA via supervisor — zero configuração.
- **Persistência em `/data`**: favoritos, dispositivos, códigos IR e SmartIR sobrevivem a updates do add-on.

## Funcionalidades expostas

- Descoberta e controle de dispositivos **Sonoff Wi-Fi** (DIY mode).
- Pareamento e controle **Tuya LAN** (cloud + local).
- **Zigbee** via MQTT (zigbee2mqtt).
- **IR Broadlink** com captura, biblioteca SmartIR e ar-condicionado completo.

Todos os dispositivos aparecem automaticamente no Home Assistant via MQTT Discovery.

## Suporte

- Issues: https://github.com/willianmagna/HomeCore-AddOn/issues
