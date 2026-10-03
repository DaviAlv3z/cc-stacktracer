# Smoke de consumidor

Instala o `cc-stacktracer` **empacotado** (`npm pack`) em projetos limpos, um por cenário, com os
frameworks e bancos reais, e roda o que o cliente roda. É o gate que faltava: as falhas graves de
2026-09 passaram pelos testes unitários porque eles rodam onde tudo já está instalado e contra mocks.

    npm run build:client
    node consumer-smoke/docker.mjs                 # Node 20, 22, 24 e 26, cada um num container
    node consumer-smoke/docker.mjs --node 24 --only esm-core,lucid22-pg
    npm pack cc-stacktracer@3.2.0 && node consumer-smoke/docker.mjs --tarball cc-stacktracer-3.2.0.tgz   # versão publicada

- O `docker.mjs` monta uma imagem por versão do Node (`docker/Dockerfile`) e sobe Postgres, MySQL e
  SQL Server numa rede própria (`cc-smoke-net`). No fim derruba tudo, salvo com `--keep-services`.
  Containers, rede e volume levam o prefixo `cc-smoke-`: nada aqui toca em container de outra coisa.
- Sem Docker, `node consumer-smoke/run.mjs` roda os cenários no Node da máquina, com os bancos que as
  variáveis `CC_SMOKE_PG_URL`, `CC_SMOKE_MYSQL_URL` e `CC_SMOKE_MSSQL_URL` apontarem.
- `--only a,b` roda só os cenários listados; `--keep` (do `run.mjs`) mantém os projetos temporários.
- Cada cenário é uma pasta em `scenarios/` com `package.json` (dependências reais e o script `smoke`) e
  um bloco `"smoke"`: `minNode`, `nodeMajors`, `requireEsm`, `services` (`postgres`, `mysql`, `mssql`) e
  `timeoutMs`.
- Um cenário termina com `PASS <nome>` (código 0) ou `FAIL <nome>` e a lista do que divergiu.
- `scenarios/app-*` são apps reais (Adonis gerado pelo `create-adonisjs`, Fastify + Prisma + SQL Server):
  build de produção, roteiro HTTP e SIGTERM no fim. `scenarios/nest*` saem de `tools/make-nest-scenarios.mjs`.
- Duração se mede com `performance.now()`: o relógio de parede da VM do Docker Desktop salta.
- Nenhum nome de cliente aqui: esta pasta vai para o repo público.
- Cenário novo para todo bug de integração que escapar: reproduza aqui antes de corrigir.
