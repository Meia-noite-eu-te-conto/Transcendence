FROM nginx:1.27.4-alpine-slim

RUN apk add --no-cache openssl

ARG GAME_CORE_DB
ARG GAME_CORE_DB_USER
ARG GAME_CORE_DB_PASS

ARG GUARDIAN_DB
ARG GUARDIAN_DB_USER
ARG GUARDIAN_DB_PASS

ARG USER_SESSION_DB
ARG USER_SESSION_DB_USER
ARG USER_SESSION_DB_PASS


RUN if [ ! -f /etc/ssl/certs/certificate.pem ]; then \
    openssl req \
    -x509 \
    -newkey rsa:4096 \
    -sha256 \
    -days 365 \
    -nodes \
    -keyout /etc/ssl/private/certificate.key.pem \
    -out /etc/ssl/certs/certificate.pem \
    -subj "/C=BR/ST=SP/L=Itaquera/O=42/OU=42/CN=dapaulin@42.fr"; \
    fi

COPY ./nginx/default.conf /etc/nginx/conf.d/default.conf