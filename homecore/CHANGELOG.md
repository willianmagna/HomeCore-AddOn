# Changelog

## 0.3.0

### Biblioteca IR

- **Catálogo público via GitHub.** A biblioteca SmartIR agora é puxada de https://github.com/willianmagna/HomeCoreIR. Novo botão "Atualizar" na barra de abas faz o sync — limpa o range 1000–8999 e repopula a partir dos arquivos do repo.
- **Convenção de nome humano** no repo: `<tipo>_<fabricante>_<modelo>.json` (ex.: `climate_fujitsu_ar-rrc1e.json`) em vez de IDs numéricos.
- **Captura local isolada em 9000+.** Códigos capturados pelo usuário não colidem mais com os do GitHub. `POST /api/smartir` agora delega pra `ir.nextCodeId()` (antes tinha contador próprio começando em 1000).
- **Identificação visual:** itens locais ganham ícone de chapéu de formatura no canto superior direito; itens do GitHub ficam neutros.
- **Botão "Editar"** no editor da biblioteca (só aparece pra itens locais) abre o arquivo direto no wizard de captura.
- **Cabeçalho do editor** mostra `[Marca] Modelo` + badge do tipo + `#id` em vez do nome do arquivo cru.
- **Status chip "JSON válido"** só aparece no modo JSON.
- **Exportar JSON** client-side direto do editor (substitui o botão "Baixar JSON" da aba Manutenção, que foi removida).

### Wizard de captura

- **Atalhos de teclado:** `Espaço` captura, `→`/`←` navegam entre combinações (com OFF como item virtual no início para climate). Funcionam só na tela de captura, ignoram foco em campo de texto e modificadores.
- **Layout polido:** botões "Atualizar"/"Importar" e "Baixar JSON" movidos pra direita da barra de abas (consistente com o resto da UI). Botões "Cancelar"/"Criar arquivo" do form viraram pills compactos abaixo do card.
- **Tab Off do editor climate** abre o modal direto (era 2 cliques) e ganha indicador verde quando há código capturado.
- **Estilos faltantes** adicionados pros pills do wizard, barra de progresso por modo, badges de pendente/capturado, chips de fontes, etc.
- **Bug fix:** ícones dos botões "Capturar IR" e "Testar" não somem mais ao alternar texto (`textContent` estava limpando o `<i lucide>`; agora o label vive num `<span>` dedicado).
- **Modal de edição** lembra o último emissor escolhido via `localStorage`.

### Branding e visual

- **Logo `hc-logo.png`** vira o ícone do add-on no HA Supervisor, favicon de todas as páginas e logo no sidebar à esquerda do texto HOMECORE.
- **Separador de título** trocado de em-dash (—) por barra vertical (`HomeCore | Biblioteca IR`).
- **Altura do header** alinhada em 56px (mesma altura real do bloco do logo no sidebar).

### Outros

- Aba "Manutenção" removida; funcionalidade de export migrou pra biblioteca.
- Listener cleanup: removidas referências fantasmas a `btn-new` que travavam o `library.html` por TypeError.

## 0.2.2

- Re-bundle do HomeCore com fix crítico no MQTT Discovery: `upsertDevice` e `removeDevice` em `lib/ir.js` agora notificam os listeners. Sem isso, ao adicionar um dispositivo IR (climate / media_player / remote) pelo HomeCore, a entidade não aparecia no HA até reiniciar o add-on.
- Inclui também as melhorias visuais recentes da página dispositivos e a UI nova da biblioteca SmartIR.

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
