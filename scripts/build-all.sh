#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d ' \r\n' < "${ROOT_DIR}/VERSION")"
DIST_DIR="${ROOT_DIR}/dist"
BIN_DIR="${DIST_DIR}/bin"
ICONS_DIR="${DIST_DIR}/icons"

rm -rf "${DIST_DIR}"
mkdir -p "${BIN_DIR}" "${ICONS_DIR}"

echo "==> 1. 生成套件图标..."
(cd "${ROOT_DIR}" && go run ./packaging/gen-icons.go "${ICONS_DIR}")

echo "==> 2. 交叉编译 Go 单二进制 (linux/amd64 & linux/arm64)..."
(cd "${ROOT_DIR}" && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o "${BIN_DIR}/spacemap-linux-amd64" ./cmd/spacemap)
(cd "${ROOT_DIR}" && CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags="-s -w" -o "${BIN_DIR}/spacemap-linux-arm64" ./cmd/spacemap)

echo "==> 3. 打包飞牛 fnOS (.fpk)..."
chmod +x "${ROOT_DIR}/packaging/fpk/build-fpk.sh" "${ROOT_DIR}/packaging/qpkg/build-qpkg.sh" "${ROOT_DIR}/packaging/upk/build-upk.sh"
"${ROOT_DIR}/packaging/fpk/build-fpk.sh" x86 "${BIN_DIR}/spacemap-linux-amd64" "${VERSION}" "${ICONS_DIR}" "${DIST_DIR}"
"${ROOT_DIR}/packaging/fpk/build-fpk.sh" arm64 "${BIN_DIR}/spacemap-linux-arm64" "${VERSION}" "${ICONS_DIR}" "${DIST_DIR}"

echo "==> 4. 打包威联通 QNAP (.qpkg)..."
"${ROOT_DIR}/packaging/qpkg/build-qpkg.sh" x86_64 "${BIN_DIR}/spacemap-linux-amd64" "${VERSION}" "${ICONS_DIR}" "${DIST_DIR}"
"${ROOT_DIR}/packaging/qpkg/build-qpkg.sh" arm_64 "${BIN_DIR}/spacemap-linux-arm64" "${VERSION}" "${ICONS_DIR}" "${DIST_DIR}"

echo "==> 5. 打包绿联 UGOS Pro (.upk)..."
"${ROOT_DIR}/packaging/upk/build-upk.sh" "${BIN_DIR}/spacemap-linux-amd64" "${BIN_DIR}/spacemap-linux-arm64" "${VERSION}" "${ICONS_DIR}" "${DIST_DIR}"

echo "==> 6. 生成 SHA-256 校验清单 (dist/checksums.txt)..."
(
    cd "${DIST_DIR}"
    {
        (cd bin && sha256sum spacemap-linux-amd64 spacemap-linux-arm64)
        sha256sum ./*.fpk ./*.qpkg ./*.upk | sed 's|^\([a-f0-9]*  \)\./|\1|'
    } > checksums.txt
)

echo "==> 构建完成，产物列表:"
ls -lh "${DIST_DIR}"/*.fpk "${DIST_DIR}"/*.qpkg "${DIST_DIR}"/*.upk "${DIST_DIR}/checksums.txt" "${BIN_DIR}"/*
