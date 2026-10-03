# Imagem do smoke de consumidor: o Node da matriz + o que um app real precisa para instalar dependências
# nativas (better-sqlite3, pg-native...) quando o binário pronto não baixa, e o openssl do Prisma 5/6.
ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
