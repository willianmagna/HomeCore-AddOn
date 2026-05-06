#!/usr/bin/env python3
import cgi
import json
import broadlink
import base64

from config import HOST, MAC, DEV_TYPE

def formatar_mac(mac_string):
    clean_mac = mac_string.replace(":", "").replace(" ", "").replace("_", "")
    return bytes.fromhex(clean_mac)

print("Content-type: application/json; charset=utf-8\n")

try:
    form = cgi.FieldStorage()
    codigo_b64 = form.getvalue("codigo_b64", "").strip()

    if not codigo_b64:
        print(json.dumps({"ok": False, "erro": "Nenhum codigo fornecido"}))
    else:
        ir_packet = base64.b64decode(codigo_b64)
        device_mac = formatar_mac(MAC)
        dev = broadlink.gendevice(DEV_TYPE, (HOST, 80), device_mac)
        dev.auth()
        dev.send_data(ir_packet)
        print(json.dumps({"ok": True, "mensagem": "Comando enviado com sucesso"}))

except Exception as e:
    print(json.dumps({"ok": False, "erro": str(e)}, ensure_ascii=False))
