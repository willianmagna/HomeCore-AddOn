# config.py

import os

# --- Início da Configuração ---
HOST = "192.168.8.55"      # IP do seu Broadlink RM
MAC = "24:DF:A7:7A:F8:59"   # MAC do seu Broadlink RM (pode usar ':', '_' ou espaços)
DEV_TYPE = 0x5f36           # Tipo do dispositivo (RM3 mini)
TIMEOUT_APRENDIZADO = 3     # Segundos para aguardar pelo código IR
FREQUENCIA_PADRAO = 38000   # Frequência em Hz para a conversão SendIR
NOME_ARQUIVO_CSV = "codigos_ir.csv"
CAMINHO_ARQUIVO = os.path.join(os.path.dirname(os.path.abspath(__file__)), NOME_ARQUIVO_CSV)
# --- Fim da Configuração ---
