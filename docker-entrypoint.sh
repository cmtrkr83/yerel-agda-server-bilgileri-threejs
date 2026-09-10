#!/bin/sh
# Varsa host'taki gizli env dosyasını yükle (her değişken, ortamda zaten
# tanımlı değilse). Böylece şifreler git'e girmeden container'a ulaşır.
# Dosya konumu: -v /opt/kodm-monitor:/run/kodm-env:ro
if [ -f /run/kodm-env/.env ]; then
  while IFS='=' read -r k v || [ -n "$k" ]; do
    case "$k" in ''|\#*) continue ;; esac
    eval "cur=\${$k-UNSET}"
    if [ "$cur" = "UNSET" ] || [ -z "$cur" ]; then
      export "$k=$v"
    fi
  done < /run/kodm-env/.env
fi
exec "$@"
