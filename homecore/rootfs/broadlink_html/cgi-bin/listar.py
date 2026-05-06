#!/usr/bin/env python3
import json
import csv
import os

from config import CAMINHO_ARQUIVO

print("Content-type: application/json; charset=utf-8\n")

resultado = {}

try:
    if os.path.isfile(CAMINHO_ARQUIVO):
        with open(CAMINHO_ARQUIVO, 'r', encoding='utf-8') as f:
            reader = csv.DictReader(f)
            for row in reader:
                chave = row.get("marca_modelo_botao", "")
                partes = chave.split("_")
                if len(partes) >= 3:
                    marca = partes[0]
                    modelo = partes[1]
                    botao = "_".join(partes[2:])
                    dispositivo = f"{marca}_{modelo}"
                else:
                    dispositivo = "outros"
                    botao = chave

                if dispositivo not in resultado:
                    resultado[dispositivo] = []

                resultado[dispositivo].append({
                    "chave": chave,
                    "botao": botao,
                    "codigo_b64": row.get("codigo_b64", ""),
                    "codigo_sendir": row.get("codigo_sendir", "")
                })

    print(json.dumps(resultado, ensure_ascii=False))
except Exception as e:
    print(json.dumps({"erro": str(e)}, ensure_ascii=False))
