#!/usr/bin/env bash
# ============================================================
#  절임배추 주문관리 앱 - Ubuntu 서버 원커맨드 설치 스크립트
#  사용법:  압축 해제 후  sudo bash deploy/setup-ubuntu.sh
# ============================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="jeolim-cabbage"
RUN_USER="jeolim"
PORT="${PORT:-3000}"

if [ "$(id -u)" -ne 0 ]; then
  echo "sudo 권한으로 실행해주세요:  sudo bash deploy/setup-ubuntu.sh"
  exit 1
fi

echo "=== [1/5] Node.js 확인 및 설치 ==="
NODE_MAJOR="$(node -v 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/' || echo 0)"
if [ "${NODE_MAJOR}" -lt 18 ]; then
  echo "Node.js 18+ 설치 중..."
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg build-essential
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "Node.js 경로: ${NODE_BIN} ($(node -v))"

echo "=== [2/5] 의존성 설치 ==="
cd "${APP_DIR}"
npm ci --no-audit --no-fund 2>/dev/null || npm install --no-audit --no-fund

echo "=== [3/5] 프론트엔드 빌드 ==="
npm run build

echo "=== [4/5] 서비스 계정 및 자동 시작 등록 ==="
id "${RUN_USER}" >/dev/null 2>&1 || useradd --system --home "${APP_DIR}" --shell /usr/sbin/nologin "${RUN_USER}"
chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"

sed -e "s|__APP_DIR__|${APP_DIR}|g" \
    -e "s|__RUN_USER__|${RUN_USER}|g" \
    -e "s|__NODE_BIN__|${NODE_BIN}|g" \
    "${APP_DIR}/deploy/jeolim-cabbage.service" > "/etc/systemd/system/${SERVICE_NAME}.service"

systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"

echo "=== [5/5] 서비스 시작 ==="
systemctl restart "${SERVICE_NAME}"
sleep 2
systemctl --no-pager --lines=5 status "${SERVICE_NAME}" || true

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
echo ""
echo "============================================================"
echo "  설치 완료!"
echo "  접속 주소:  http://${IP:-서버IP}:${PORT}"
echo ""
echo "  주요 명령어:"
echo "    상태 확인:   sudo systemctl status ${SERVICE_NAME}"
echo "    재시작:      sudo systemctl restart ${SERVICE_NAME}"
echo "    로그 보기:   sudo journalctl -u ${SERVICE_NAME} -f"
echo ""
echo "  문자(SMS) 발송 기능이 필요하면:"
echo "    1) cp .env.example .env"
echo "    2) .env 파일에 SolAPI 키 입력"
echo "    3) sudo systemctl restart ${SERVICE_NAME}"
echo "============================================================"
