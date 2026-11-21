#!/bin/bash
# Установка сайта «Кит» и админки на свой сервер (Node.js + SQLite).
# Запуск:  ssh myserver "curl -fsSL https://raw.githubusercontent.com/anuarbekroza-bit/kit-site/main/server-app/install.sh | sudo bash"
# Повторный запуск безопасен: данные в базе не трогаются, обновляется только код.
set -euo pipefail

REPO_TAR="https://github.com/anuarbekroza-bit/kit-site/archive/refs/heads/main.tar.gz"
APP=/opt/kit-app
DATA=/var/lib/kit
SITE_DOMAIN=kit.r-agent.kz
ADMIN_DOMAIN=admin.r-agent.kz
MAIN_DOMAIN=r-agent.kz

say() { echo; echo "== $*"; }
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo"; exit 1; }

say "1/7 Node.js"
NODE_MAJOR=$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs >/dev/null
fi
echo "   Node.js $(node -v)"

say "2/7 Код сайта и админки"
id kit >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin kit
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL "$REPO_TAR" | tar -xz -C "$TMP"
SRC="$TMP/kit-site-main"
rm -rf "$APP.new" && mkdir -p "$APP.new"
cp -r "$SRC/server-app/." "$APP.new/"
rm -rf "$APP.old"; [ -d "$APP" ] && mv "$APP" "$APP.old"; mv "$APP.new" "$APP"
chown -R root:root "$APP"; chmod -R a+rX "$APP"
mkdir -p "$DATA/images"
cp -n "$SRC"/images/* "$DATA/images/" 2>/dev/null || true
[ -d /var/www/kit/images ] && cp -n /var/www/kit/images/* "$DATA/images/" 2>/dev/null || true
chown -R kit:kit "$DATA"; chmod 700 "$DATA"
echo "   Код: $APP   Данные: $DATA"

run_cli() { runuser -u kit -- env KIT_DATA="$DATA" node --disable-warning=ExperimentalWarning "$APP/cli.js" "$@"; }

say "3/7 База данных SQLite"
run_cli init

say "4/7 Вход в админку"
echo "   Логин и пароль задаются в браузере по одноразовой ссылке (она будет в конце)"

say "5/7 Служба (работает 24/7, сама перезапускается)"
cat > /etc/systemd/system/kit-app.service <<EOF
[Unit]
Description=Kit: сайт и админка
After=network.target

[Service]
User=kit
Group=kit
WorkingDirectory=$APP
Environment=KIT_DATA=$DATA
Environment=PORT=3000
Environment=SITE_URL=https://$SITE_DOMAIN
Environment=ADMIN_URL=https://$ADMIN_DOMAIN
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning $APP/server.js
Restart=always
RestartSec=3
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=$DATA

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable kit-app >/dev/null 2>&1
systemctl restart kit-app
for i in $(seq 1 20); do curl -fsS http://127.0.0.1:3000/health >/dev/null 2>&1 && break; sleep 0.5; done
curl -fsS http://127.0.0.1:3000/health >/dev/null || { echo "!! Служба не запустилась:"; journalctl -u kit-app -n 30 --no-pager; exit 1; }
echo "   Служба kit-app работает"
echo "0 3 * * * kit KIT_DATA=$DATA /usr/bin/node --disable-warning=ExperimentalWarning $APP/cli.js backup >/dev/null 2>&1" > /etc/cron.d/kit-backup
chmod 644 /etc/cron.d/kit-backup
# отвязка от GitHub: старое автообновление больше не нужно
rm -f /etc/cron.d/kit-sync /usr/local/bin/kit-sync.sh

say "6/7 SSL-сертификат для $ADMIN_DOMAIN"
if [ ! -f "/etc/letsencrypt/live/$ADMIN_DOMAIN/fullchain.pem" ]; then
  # порт 80 должен отдавать проверку Let's Encrypt для admin — временно добавляем это в nginx
  ACME=/etc/nginx/conf.d/kit-acme-tmp.conf
  printf 'server { listen 80; listen [::]:80; server_name %s; location /.well-known/acme-challenge/ { root /var/www/html; } }\n' "$ADMIN_DOMAIN" > "$ACME"
  if nginx -t >/dev/null 2>&1; then systemctl reload nginx; else rm -f "$ACME"; fi
  if certbot certonly --webroot -w /var/www/html -d "$ADMIN_DOMAIN" --non-interactive --agree-tos --register-unsafely-without-email >/tmp/kit-certbot.log 2>&1; then
    echo "   Сертификат получен"
  else
    echo "   !! Сертификат пока не выдан. Причина:"; tail -n 6 /tmp/kit-certbot.log | sed 's/^/      /'
  fi
  rm -f "$ACME"
else
  echo "   Сертификат уже есть"
fi

say "7/7 Nginx: $SITE_DOMAIN и $ADMIN_DOMAIN"
SSL_OPTS=""
[ -f /etc/letsencrypt/options-ssl-nginx.conf ] && SSL_OPTS="include /etc/letsencrypt/options-ssl-nginx.conf;"
[ -f /etc/letsencrypt/ssl-dhparams.pem ] && SSL_OPTS="$SSL_OPTS ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;"
MAIN_CERT=/etc/letsencrypt/live/$MAIN_DOMAIN
ADMIN_CERT=/etc/letsencrypt/live/$ADMIN_DOMAIN
PROXY='proxy_pass http://127.0.0.1:3000; proxy_set_header Host $host; proxy_set_header X-Real-IP $remote_addr; proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto https;'
CONF=/etc/nginx/sites-available/sites
[ -f "$CONF" ] && cp "$CONF" "/root/nginx-sites-backup-$(date +%Y%m%d-%H%M%S)"
{
cat <<EOF
# Сайты на сервере. Файл создан установщиком «Кит».
server {
    listen 80;
    listen [::]:80;
    server_name $MAIN_DOMAIN www.$MAIN_DOMAIN $SITE_DOMAIN $ADMIN_DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $MAIN_DOMAIN www.$MAIN_DOMAIN;
    ssl_certificate $MAIN_CERT/fullchain.pem;
    ssl_certificate_key $MAIN_CERT/privkey.pem;
    $SSL_OPTS
    root /var/www/html;
    index index.html index.nginx-debian.html;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $SITE_DOMAIN;
    ssl_certificate $MAIN_CERT/fullchain.pem;
    ssl_certificate_key $MAIN_CERT/privkey.pem;
    $SSL_OPTS
    client_max_body_size 1m;
    location /admin { return 404; }
    location / { $PROXY }
}
EOF
if [ -f "$ADMIN_CERT/fullchain.pem" ]; then
cat <<EOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name $ADMIN_DOMAIN;
    ssl_certificate $ADMIN_CERT/fullchain.pem;
    ssl_certificate_key $ADMIN_CERT/privkey.pem;
    $SSL_OPTS
    client_max_body_size 20m;
    add_header X-Robots-Tag "noindex" always;
    location / { $PROXY }
}
EOF
fi
} > "$CONF.new"
mv "$CONF.new" "$CONF"
ln -sf "$CONF" /etc/nginx/sites-enabled/sites
if nginx -t >/dev/null 2>&1; then
  systemctl reload nginx
else
  echo "!! Ошибка в настройке nginx, возвращаю старую:"; nginx -t || true
  LAST=$(ls -t /root/nginx-sites-backup-* 2>/dev/null | head -1)
  [ -n "$LAST" ] && cp "$LAST" "$CONF" && systemctl reload nginx
  exit 1
fi

echo
SITE_OK=$(curl -s -o /dev/null -w '%{http_code}' "https://$SITE_DOMAIN/" || true)
ADMIN_OK=$(curl -s -o /dev/null -w '%{http_code}' "https://$ADMIN_DOMAIN/admin/login" || true)
echo "   Сайт:    https://$SITE_DOMAIN  (ответ $SITE_OK)"
echo "   Админка: https://$ADMIN_DOMAIN  (ответ $ADMIN_OK)"
if [ "$SITE_OK" = 200 ] && [ "$ADMIN_OK" = 200 ]; then
  LINK=$(runuser -u kit -- env KIT_DATA="$DATA" ADMIN_URL="https://$ADMIN_DOMAIN" node --disable-warning=ExperimentalWarning "$APP/cli.js" setup-link)
  echo
  echo "   Откройте ссылку и задайте логин и пароль (ссылка одноразовая, действует 24 часа):"
  echo "SETUP-LINK $LINK"
  echo
  echo "== ГОТОВО"
else
  echo "== Почти готово: если админка не открылась, запустите команду ещё раз через 10–15 минут."
fi
