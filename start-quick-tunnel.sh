#!/usr/bin/env bash
set -euo pipefail
umask 077

APP=/root/zalo-qr-recovery
mkdir -p "$APP/.run" "$APP/.tools"

echo "=== Kiểm tra Zalo Recovery ==="
curl -fsS --max-time 5 \
  http://127.0.0.1:9093/api/health
echo

echo "=== Email được phép truy cập website ==="
read -r -p "Nhập email của bạn: " EMAIL

if [[ ! "$EMAIL" == *@*.* ]]; then
  echo "Email không hợp lệ."
  exit 1
fi

# Ưu tiên cloudflared đã cài và hỗ trợ email OTP.
CF="$(command -v cloudflared || true)"

if [[ -z "$CF" ]] || \
   ! "$CF" tunnel --help 2>&1 | grep -Fq -- "--allowed-mail"; then

  echo "Cài cloudflared mới riêng cho dự án..."

  case "$(uname -m)" in
    x86_64) ARCH=amd64 ;;
    aarch64|arm64) ARCH=arm64 ;;
    *)
      echo "CPU chưa hỗ trợ tự động: $(uname -m)"
      exit 1
      ;;
  esac

  CF="$APP/.tools/cloudflared"

  curl -fLsS --retry 3 \
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${ARCH}" \
    -o "$CF.tmp"

  chmod 700 "$CF.tmp"
  mv "$CF.tmp" "$CF"
fi

echo "=== Phiên bản Cloudflare ==="
"$CF" --version

LOG="$APP/.run/quick-tunnel.log"
PIDFILE="$APP/.run/quick-tunnel.pid"

if [[ -f "$PIDFILE" ]] && \
   kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "Tunnel dự án đang chạy. Không tạo thêm."
else
  echo "=== Khởi động Cloudflare Quick Tunnel ==="

  nohup "$CF" tunnel \
    --url http://127.0.0.1:9093 \
    --allowed-mail "$EMAIL" \
    > "$LOG" 2>&1 < /dev/null &

  echo $! > "$PIDFILE"
fi

echo "Đang chờ Cloudflare cấp URL..."

URL=""

for i in $(seq 1 15); do
  URL="$(grep -oE \
    'https://[a-zA-Z0-9-]+\.trycloudflare\.com' \
    "$LOG" 2>/dev/null | head -1 || true)"

  if [[ -n "$URL" ]]; then
    break
  fi

  sleep 2
done

echo
echo "=============================="

if [[ -n "$URL" ]]; then
  echo "WEBSITE: $URL"
  echo "ACCESS: Chỉ email $EMAIL"
else
  echo "Chưa nhận được URL."
  echo "Kiểm tra log:"
  tail -n 25 "$LOG"
fi

echo "=============================="
