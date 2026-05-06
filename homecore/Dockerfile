ARG BUILD_FROM
FROM $BUILD_FROM

# Toolchain pra compilar módulos nativos (better-sqlite3) + node + tini
RUN apk add --no-cache \
    nodejs \
    npm \
    python3 \
    make \
    g++ \
    tini

WORKDIR /app

# Copia o snapshot do HomeCore
COPY rootfs/ /app/

# Instala deps de produção (compila better-sqlite3 com a toolchain)
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Limpa toolchain de build pra reduzir imagem
RUN apk del python3 make g++

# Script de inicialização do add-on
COPY run.sh /run.sh
RUN chmod +x /run.sh

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/run.sh"]
