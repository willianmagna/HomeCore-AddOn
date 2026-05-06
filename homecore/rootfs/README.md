# HomeCore

Plataforma de automação residencial em Node.js que unifica dispositivos **Wi-Fi (Sonoff/Tuya)**, **Zigbee (zigbee2mqtt)** e **IR (Broadlink RM)** sob uma interface web única, publicando tudo no **Home Assistant** via MQTT Discovery.

Toda a configuração (cômodos, nomes, áreas) é per-saída e sincronizada bidirecionalmente com o registry do HA.

---

## O que faz

### Wi-Fi (`/dispositivos.html`)

| Vendor | Protocolo | Inclusão | Controle |
|--------|-----------|----------|----------|
| **Sonoff** | eWeLink LAN (mDNS + HTTP `:8081/zeroconf`) — AES-128-CBC | Login eWeLink uma única vez pra baixar `devicekey` | 100% local |
| **Tuya** | LAN v3.3/v3.4 (TCP `:6668` persistente) — AES-128-ECB + HMAC handshake | Cloud OpenAPI pra baixar `localKey` | 100% local |

- Cards agrupados por cômodo, com toggle por canal (S1, S2…) e indicador de sinal Wi-Fi.
- Modal de configuração 2 colunas: nome, tipo HA, cômodo, `object_id`, identificador, detalhes técnicos.
- Identify (pisca o relé) e remoção via UI.

### Zigbee (`/zigbee.html`)

- Lê `bridge/devices` do z2m e enriquece com o registry do Home Assistant.
- Cards adaptam o conteúdo conforme o tipo:
  - **Switch/Luz**: toggles S1, S2…
  - **Sensor de temperatura/umidade**: `Temp.` · `Umidade` · `Bateria`
  - **Sensor de porta**: `Estado` · `Bateria`
  - **Sensor de presença**: `Presença` · `Bateria`
  - **Botão**: `Última ação` (ex: `single há 12s`) · `Bateria`
  - **Repetidor (Router)**: `Online`
- **Cômodo per-saída**: módulos com 2+ canais aparecem em cards separados quando os canais estão em cômodos diferentes (e o número da saída original — S1, S2 — é preservado).
- Modal lista as **ações reconhecidas** do device (single, double, triple, hold, release, etc) destacando a última disparada.

### Zigbee — Parear (`/zigbee-pair.html`)

- Botão "Permitir pareamento" (60s / 2min / 4min) com countdown.
- **SSE** de `bridge/event`: cards aparecem em tempo real conforme `device_joined` → `interviewing` → `pareado` (ou `failed`/`left`).
- Detecta **rejoin** (IEEE já conhecido) e mostra badge — toda config do HomeCore (cômodo por saída, nome, area no HA) sobrevive ao rejoin porque é indexada pelo IEEE, que não muda.
- "Configurar" deeplinka direto pra `zigbee.html?cfg=<ieee>` e abre o modal.

### IR (`/index.html`)

- Broadlink RM4 via UDP (descoberta + envio de pacotes).
- Biblioteca SmartIR portada (climate, media_player, etc).
- MQTT Discovery por device.

### Home Assistant — sync automático

Em todo save:
1. Override local em SQLite (Sonoff/Tuya) ou JSON (Zigbee em `data/zigbee-overrides.json`).
2. **MQTT Discovery** publicado com `name`, `unique_id`, `object_id`, `suggested_area` (Wi-Fi).
3. **HA WS API** (`config/area_registry/create`, `config/device_registry/update`, `config/entity_registry/update`) força:
   - `area_id` — cria a área no HA se não existir.
   - `name_by_user` no device com prefixo `[Cômodo] <Nome>`.
   - `new_entity_id` baseado no `object_id`.
4. **Zigbee**: se o `friendly_name` no z2m ainda é o IEEE, dispara `bridge/request/device/rename` automaticamente com um slug do nome.

---

## Setup

### Dependências

- Node.js 20+
- MQTT broker (ex: Mosquitto) em `127.0.0.1:1883`
- Home Assistant rodando (opcional mas recomendado) com Long-Lived Token
- **zigbee2mqtt** (opcional) para módulos Zigbee
- **Broadlink RM** na rede (opcional) para IR

### Instalação

```bash
git clone git@github.com:willianmagna/HomeCore.git
cd HomeCore
npm install
cp .env.example .env  # edite com seus dados
./scripts/setup-firewall.sh   # libera UDP da sub-rede pro discovery LAN
node server.js
```

Servidor sobe em `http://localhost:3010`.

### `.env`

```bash
# MQTT
MQTT_HOST=127.0.0.1
MQTT_PORT=1883
MQTT_USERNAME=...
MQTT_PASSWORD=...
MQTT_DISCOVERY_PREFIX=homeassistant

# Home Assistant (gere Long-Lived Token em HA → Profile)
HA_URL=http://127.0.0.1:8123
HA_TOKEN=eyJ...

# Zigbee2MQTT (opcional, default: mqtt://127.0.0.1:1883)
MQTT_URL=mqtt://127.0.0.1:1883
```

### Tuya Cloud

Pra incluir devices Tuya, crie credenciais em [iot.tuya.com](https://iot.tuya.com) (projeto Cloud Development → API Explorer → access_id + access_secret) e configure no botão "Importar Tuya" da UI.

### eWeLink

Pra incluir Sonoff, faz login na eWeLink uma única vez (no botão "Buscar" → "Incluir") — credenciais não são salvas, só usadas pra baixar a `devicekey` do device.

---

## Estrutura

```
homecore/
├── server.js                       # Express + WebSocket
├── lib/
│   ├── ha.js                       # HA WS API (areas + device + entity registry)
│   ├── areas.js                    # cômodos + andares (data/areas.json)
│   ├── ir.js, ir-mqtt.js           # IR (Broadlink + discovery)
│   ├── broadlink.js                # protocolo Broadlink RM
│   ├── zigbee.js                   # bridge z2m (subscribe + ring buffer de eventos)
│   ├── zigbee-overrides.js         # overrides per-saída (room_id, name)
│   ├── sonoff/
│   │   ├── index.js, scanner.js    # mDNS + HTTP /zeroconf
│   │   ├── crypto.js, ewelink.js   # AES-128-CBC + login eWeLink
│   │   ├── storage.js              # SQLite (data/wifi.db)
│   │   ├── state-bus.js            # eventos de estado
│   │   ├── routes.js               # /api/wifi/*
│   │   └── mqtt-bridge.js          # discovery + state HA
│   └── tuya/
│       ├── crypto.js, protocol.js  # AES-128-ECB + frame v3.3/v3.4
│       ├── lan.js                  # TCP cliente persistente
│       ├── cloud.js, cloud-config.js  # Tuya Cloud OpenAPI
│       ├── udp-discover.js         # broadcast :6667 → IP LAN
│       ├── storage.js              # SQLite (data/tuya.db)
│       ├── routes.js, index.js
│       └── mqtt-bridge.js
├── public/
│   ├── dispositivos.html           # Wi-Fi (Sonoff + Tuya unificados)
│   ├── wifi-scan.html              # buscar Wi-Fi (Sonoff + Tuya na rede)
│   ├── zigbee.html                 # Zigbee (todos os tipos)
│   ├── zigbee-pair.html            # parear (SSE de bridge/event)
│   ├── index.html                  # IR
│   ├── areas.html                  # cômodos + andares
│   └── assets/
└── data/                           # gitignored — DBs + overrides + secrets
```

---

## API

| Endpoint | Função |
|----------|--------|
| `GET /api/areas` | cômodos + andares |
| `GET /api/wifi/devices` | Sonoff incluídos |
| `GET /api/tuya/devices` | Tuya incluídos |
| `GET /api/wifi/discover/stream` (SSE) | varredura Wi-Fi |
| `POST /api/wifi/include` | incluir Sonoff (eWeLink) |
| `POST /api/tuya/include` | incluir Tuya (Cloud) |
| `POST /api/wifi/devices/:id/switch` | toggle Sonoff |
| `POST /api/tuya/devices/:id/dp` | set DP Tuya |
| `PATCH /api/wifi/devices/:id` | atualiza Sonoff |
| `PATCH /api/tuya/devices/:id` | atualiza Tuya |
| `GET /api/zigbee/state` | snapshot do mesh (com overrides aplicados) |
| `GET /api/zigbee/pair-stream` (SSE) | eventos `device_joined`/`interview`/`leave` |
| `POST /api/zigbee/permit-join` | abre/fecha pareamento (`{seconds}`) |
| `POST /api/zigbee/update` | salva nome + cômodo (per-device ou per-saída) |
| `POST /api/zigbee/set` | controla device |
| `POST /api/zigbee/remove` | remove do mesh (suporta `force`) |

---

## Persistência

| Sistema | Onde |
|---------|------|
| Sonoff | SQLite `data/wifi.db` |
| Tuya | SQLite `data/tuya.db` |
| IR | JSON `data/ir-devices.json` |
| Cômodos/Andares | JSON `data/areas.json` |
| Zigbee (overrides homecore) | JSON `data/zigbee-overrides.json` |
| Zigbee (nomes de entidades) | HA `entity_registry` |
| Tuya Cloud creds | JSON `data/tuya-cloud.json` (modo `0600`) |

Tudo indexado por **deviceid** (Wi-Fi) ou **IEEE** (Zigbee), portanto sobrevive a rejoin/reinclusão.

---

## Particularidades técnicas

- **Sonoff MINI R4**: só aceita `/zeroconf/switches` (plural, array). `/switch` retorna `error:0` mas não atua.
- **eWeLink APP_ID**: rotaciona — usado o ID do AlexxIT/SonoffLAN. HMAC precisa ser bytes-idênticos ao body POSTado.
- **Tuya v3.4**: payload precisa ser `{data:{dps,cid}, protocol:5, t}`, não `{devId,uid,t,dps}`. `DP_QUERY_NEW` é cmd `0x10`, não `0x0d`.
- **Tuya Cloud**: retorna `ip` com WAN, não LAN — use UDP listener em `:6667` decryptando com `MD5("yGAdlopoPVldABfn")` pra mapear `gwId → IP local`.
- **Z2M state merge**: z2m publica updates parciais (`{action:"single"}` seguido de `{action:""}`). HomeCore faz merge em vez de overwrite, e preserva a última `action` válida com timestamp próprio (`_action_ts`).
- **HA `name_by_user` vs MQTT `name`**: device prefixado com `[Cômodo]`, entity sem prefixo (saídas não levam colchetes).

---

## License

MIT
