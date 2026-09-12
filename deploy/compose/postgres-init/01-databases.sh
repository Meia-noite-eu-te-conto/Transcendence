#!/bin/bash
# Dois bancos com donos separados, um por serviço — espelha o que
# manifests/10-postgres.yaml faz no cluster (ADR-0009 no nível lógico:
# o usuário de um serviço não tem permissão no banco do outro).
set -euo pipefail
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-SQL
  CREATE USER usersession WITH PASSWORD 'usersession';
  CREATE DATABASE usersession OWNER usersession;
  REVOKE ALL ON DATABASE usersession FROM PUBLIC;

  CREATE USER gamecore WITH PASSWORD 'gamecore';
  CREATE DATABASE gamecore OWNER gamecore;
  REVOKE ALL ON DATABASE gamecore FROM PUBLIC;
SQL
