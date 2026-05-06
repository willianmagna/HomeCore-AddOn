#!/bin/bash
# Inicia servidor HTTP local na porta 8000
cd "$(dirname "$0")"
python3 -m http.server --cgi 8000