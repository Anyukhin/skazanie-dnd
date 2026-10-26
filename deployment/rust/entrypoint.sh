#!/bin/sh
# Точка входа образа Rust-сервера (Dockerfile.rust, С19.3).
#
# DND_EXTRA_CA_CERTS — путь к дополнительному корневому сертификату (PEM),
# аналог NODE_EXTRA_CA_CERTS у JS-образа: антивирус (Kaspersky) подменяет
# HTTPS-сертификаты в трафике Docker. rustls доверяет системному хранилищу,
# а SSL_CERT_FILE его заменяет, а не дополняет, поэтому собираем общий пакет
# во временном каталоге (в compose он tmpfs, файловая система только для чтения).
set -eu

if [ -n "${DND_EXTRA_CA_CERTS:-}" ]; then
  if [ ! -r "$DND_EXTRA_CA_CERTS" ]; then
    echo "[Сказание] DND_EXTRA_CA_CERTS: файл $DND_EXTRA_CA_CERTS не читается" >&2
    exit 1
  fi
  bundle="${TMPDIR:-/tmp}/skazanie-ca-bundle.crt"
  cat /etc/ssl/certs/ca-certificates.crt "$DND_EXTRA_CA_CERTS" > "$bundle"
  SSL_CERT_FILE="$bundle"
  export SSL_CERT_FILE
fi

exec /app/skazanie-server "$@"
