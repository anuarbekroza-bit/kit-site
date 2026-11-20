#!/bin/bash
# Обновление сайта «Кит» на своём сервере (kit.r-agent.kz) из GitHub.
# Запуск на сервере:  curl -fsSL https://raw.githubusercontent.com/anuarbekroza-bit/kit-site/main/deploy/setup-server.sh | sudo bash
# Что делает:
#   1) находит папку сайта на сервере и делает её резервную копию;
#   2) кладёт туда свежую версию сайта с GitHub;
#   3) ставит автообновление каждые 5 минут (правки из админки сами появятся на kit.r-agent.kz).
# Паролей и ключей здесь нет и не нужно.
set -euo pipefail

DOMAIN="kit.r-agent.kz"
SYNC=/usr/local/bin/kit-sync.sh

echo "== Ищу папку сайта на сервере..."
WEB=""
CANDIDATES=$(grep -rl --include=index.html 'data-kk-title' /var/www /srv /home /usr/share/nginx 2>/dev/null | xargs -r -n1 dirname | sort -u || true)
ROOTS=""
if command -v nginx >/dev/null 2>&1; then
  ROOTS=$(nginx -T 2>/dev/null | grep -oE '(^|[;{[:space:]])root[[:space:]]+[^;]+' | awk '{print $NF}' | sed 's#/$##' | sort -u || true)
fi
for c in $CANDIDATES; do
  if printf '%s\n' "$ROOTS" | grep -qxF "$c"; then WEB="$c"; break; fi
done
if [ -z "$WEB" ] && [ "$(printf '%s\n' "$CANDIDATES" | grep -c .)" = "1" ]; then WEB="$CANDIDATES"; fi
if [ -z "$WEB" ] || [ ! -f "$WEB/index.html" ]; then
  echo "!! Не нашла папку сайта. Ничего не изменено. Пришлите этот текст в чат." >&2
  exit 1
fi
echo "   Папка сайта: $WEB"

BACKUP="/root/kit-site-backup-$(date +%Y%m%d-%H%M%S)"
cp -a "$WEB" "$BACKUP"
echo "== Резервная копия: $BACKUP"

cat > "$SYNC" <<EOF
#!/bin/bash
# Забирает свежую версию сайта «Кит» с GitHub и кладёт в $WEB
set -euo pipefail
WEB="$WEB"
EOF
cat >> "$SYNC" <<'EOF'
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
curl -fsSL "https://anuarbekroza-bit.github.io/kit-site/?nc=$(date +%s)" -o "$TMP/index.html"
curl -fsSL "https://github.com/anuarbekroza-bit/kit-site/archive/refs/heads/main.tar.gz" | tar -xz -C "$TMP" kit-site-main/images
# адреса из GitHub Pages (/kit-site/...) переделываю под свой домен
sed -i -e 's#https://anuarbekroza-bit.github.io/kit-site/#https://kit.r-agent.kz/#g' \
       -e 's#"/kit-site/#"/#g' -e "s#'/kit-site/#'/#g" -e 's#(/kit-site/#(/#g' "$TMP/index.html"
# защита: если скачалось что-то не то, сайт не трогаю
grep -q 'data-kk-title' "$TMP/index.html" || { echo "скачанная страница не похожа на сайт, пропускаю"; exit 1; }
mkdir -p "$WEB/images"
cp -r "$TMP/kit-site-main/images/." "$WEB/images/"
if ! cmp -s "$TMP/index.html" "$WEB/index.html"; then
  cp "$TMP/index.html" "$WEB/index.html"
  echo "$(date '+%F %T') сайт обновлён"
fi
chmod -R a+rX "$WEB"
EOF
chmod +x "$SYNC"

echo "== Обновляю сайт..."
"$SYNC"

echo "*/5 * * * * root $SYNC >> /var/log/kit-sync.log 2>&1" > /etc/cron.d/kit-sync
chmod 644 /etc/cron.d/kit-sync
echo "== Автообновление включено: каждые 5 минут (журнал: /var/log/kit-sync.log)"

if curl -fsS "https://$DOMAIN/?nc=$(date +%s)" | grep -q 'padding-left:24px'; then
  echo "== ГОТОВО: https://$DOMAIN обновлён."
else
  echo "== Файлы обновлены в $WEB. Если сайт ещё старый — обновите страницу через минуту."
fi
