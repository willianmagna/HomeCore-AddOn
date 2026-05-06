#!/usr/bin/env python3
import cgi
import broadlink
import time
import base64
import os
import csv
import struct
import unicodedata
import re

from config import HOST, MAC, DEV_TYPE, TIMEOUT_APRENDIZADO, FREQUENCIA_PADRAO, NOME_ARQUIVO_CSV, CAMINHO_ARQUIVO

def formatar_mac(mac_string):
    """Remove separadores comuns do MAC e converte para bytes."""
    clean_mac = mac_string.replace(":", "").replace(" ", "").replace("_", "")
    return bytes.fromhex(clean_mac)

def slug_sem_acentos(*partes):
    """
    Concatena partes em 'marca_modelo_botao', remove acentos, espaços extras e caracteres não-alfanuméricos,
    substituindo por '_' e reduzindo repetições.
    """
    combinado = "_".join(p.strip() for p in partes if p and p.strip())
    # Normaliza e remove diacríticos
    nfkd = unicodedata.normalize('NFD', combinado)
    sem_acentos = ''.join(ch for ch in nfkd if unicodedata.category(ch) != 'Mn')
    # Troca não-alfa-num por underscore e normaliza
    sem_acentos = re.sub(r"[^A-Za-z0-9]+", "_", sem_acentos)
    sem_acentos = re.sub(r"_+", "_", sem_acentos).strip('_')
    return sem_acentos

def broadlink_to_sendir(ir_packet, freq_hz=38000):
    """
    Converte um pacote IR Broadlink (bytes) para o formato Global Caché (sendir).
    Retorna uma tupla: (string_completa, string_limpa).
    """
    if not ir_packet:
        return None, None

    durations_broadlink = []
    payload = ir_packet[4:]
    i = 0
    while i < len(payload):
        if payload[i] == 0x00:
            if i + 2 >= len(payload): break
            value = struct.unpack('>H', payload[i+1:i+3])[0]
            i += 3
        else:
            value = payload[i]
            i += 1
        durations_broadlink.append(value)

    us_per_unit = 1000000 / 32768
    durations_us = [round(d * us_per_unit) for d in durations_broadlink]

    period_us = 1000000 / freq_hz
    cycles = [max(1, round(us / period_us)) for us in durations_us]

    # Parte numérica (limpa)
    sendir_limpo = f"{freq_hz},{','.join(map(str, cycles))}"
    # String completa
    sendir_completo = f"sendir,1:1,1,{sendir_limpo}"
    return sendir_completo, sendir_limpo

# --- Início do Script ---

form = cgi.FieldStorage()
marca = form.getvalue("marca", "").strip()
modelo = form.getvalue("modelo", "").strip()
nome_botao = form.getvalue("nome_botao", "").strip()  # campo 'Botão'

chave = slug_sem_acentos(marca, modelo, nome_botao)

page_title = ""
html_content = ""

try:
    device_mac = formatar_mac(MAC)
    dev = broadlink.gendevice(DEV_TYPE, (HOST, 80), device_mac)
    dev.auth()
    dev.enter_learning()
    time.sleep(TIMEOUT_APRENDIZADO)
    ir_packet = dev.check_data()

    if ir_packet:
        page_title = "Código Capturado!"

        # Converte o pacote de bytes para os formatos necessários
        code_b64 = base64.b64encode(ir_packet).decode('utf-8')
        code_sendir_full, code_sendir_clean = broadlink_to_sendir(ir_packet, FREQUENCIA_PADRAO)

        log_message = ""
        try:
            arquivo_existe = os.path.isfile(CAMINHO_ARQUIVO)
            with open(CAMINHO_ARQUIVO, 'a', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                if not arquivo_existe:
                    # Cabeçalho conforme solicitado
                    writer.writerow(["marca_modelo_botao", "codigo_sendir", "codigo_b64"])
                # Coluna 1: chave marca_modelo_botao (sem acento)
                # Coluna 2: código convertido para sendir (limpo)
                # Coluna 3: código original em base64
                writer.writerow([chave, code_sendir_clean, code_b64])
            log_message = f"<p style='color: #15803d;'><b>Salvo com sucesso em:</b> <code>{NOME_ARQUIVO_CSV}</code></p>"
        except IOError as e:
            log_message = f"<p style='color: #b91c1c;'><b>Erro ao salvar:</b> {e}</p>"

        # Monta o HTML de sucesso com os dados
        html_content = f"""
            <div class="success"><div class="status-icon">✅</div><h1>Código Capturado</h1></div>
            <a href="../index.html" class="button">Capturar Outro Código</a>
            <div class="card" style="margin-top: 1.5em; background-color: #f0f9ff; border-color: #7dd3fc;">{log_message}</div>

            <div class="grid-container">
                <div class="card">
                    <h3>Identificador (marca_modelo_botao)</h3>
                    <pre>{chave}</pre>
                </div>
                <div class="card">
                    <h3>Código Convertido (SendIR / GC)</h3>
                    <pre>{code_sendir_full}</pre>
                </div>
                <div class="card">
                    <h3>Código Original (Base64)</h3>
                    <pre>{code_b64}</pre>
                </div>
            </div>
        """
    else:
        page_title = "Falha na Captura"
        html_content = f"""
            <div class="error"><div class="status-icon">⚠️</div><h1>Nenhum Código Capturado</h1>
            <p class="message">O tempo de {TIMEOUT_APRENDIZADO} segundos esgotou para <b>{marca} / {modelo}</b> — botão '<i>{nome_botao or 'sem_nome'}</i>'.</p></div>
            <a href="../index.html" class="button">Tentar Novamente</a>
        """

except Exception as e:
    page_title = "Erro na Execução"
    html_content = f"""
        <div class="error"><div class="status-icon">❌</div><h1>Ocorreu um Erro na Execução</h1>
        <p class="message" style="text-align:left;"><b>Detalhes:</b><br>{e}</p></div>
        <a href="../index.html" class="button">Voltar e Verificar</a>
    """

# Imprime a página HTML final (mantendo a identidade visual existente)
print("Content-type: text/html; charset=utf-8\n")
print(f"""<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <title>{page_title}</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap' );
        body {{ font-family: 'Roboto', sans-serif; background-color: #f0f2f5; color: #333; margin: 0; padding: 1em; display: flex; justify-content: center; align-items: center; min-height: 100vh; }}
        .container {{ width: 100%; max-width: 800px; background: #fff; padding: 2em; border-radius: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.08); text-align: center; }}
        h1 {{ font-size: 1.8em; color: #1e3a8a; margin-top: 0; margin-bottom: 0.5em; }}
        .grid-container {{ display: grid; grid-template-columns: 1fr; gap: 1em; text-align: left; margin-top: 1.5em; }}
        .card {{ background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 1em; }}
        .card h3 {{ margin-top: 0; color: #374151; font-size: 1.1em; }}
        pre {{ 
            background-color: #1e293b; color: #f1f5f9; padding: 1em; border-radius: 6px; 
            white-space: pre-wrap;
            word-break: break-all;
            font-family: 'Courier New', Courier, monospace; font-size: 0.9em; text-align: left;
        }}
        .status-icon {{ font-size: 2.5em; }}
        .success .status-icon {{ color: #22c55e; }}
        .error .status-icon {{ color: #ef4444; }}
        .message {{ font-size: 1.1em; color: #475569; margin-top: 0.5em; }}
        .button {{ display: inline-block; background-color: #2563eb; color: white; padding: 12px 25px; border: none; border-radius: 8px; cursor: pointer; font-size: 1em; font-weight: 500; text-decoration: none; margin-top: 1.5em; transition: background-color 0.3s; }}
        .button:hover {{ background-color: #1d4ed8; }}
    </style>
</head>
<body><div class="container">{html_content}</div></body>
</html>
""")
