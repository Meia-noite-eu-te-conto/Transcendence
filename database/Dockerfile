FROM postgres:16-alpine

COPY init-database.sh /docker-entrypoint-initdb.d/init-database.sh

RUN chmod +x /docker-entrypoint-initdb.d/init-database.sh
