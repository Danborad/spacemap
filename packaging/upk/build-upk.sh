#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 5 ]; then
    echo "用法: $0 <amd64_bin> <arm64_bin> <version> <icons_dir> <out_dir>" >&2
    exit 1
fi

AMD64_BIN="$1"
ARM64_BIN="$2"
VERSION="$3"
ICONS_DIR="$4"
OUT_DIR="$5"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
UGCLI_URL="https://osswaf.ugnas.com/pro/ugcli/download/ugcli-v1.1.0.25-linux-amd64"
UGCLI_CACHE_DIR="/tmp/ugcli-cache"
UGCLI_BIN="${UGCLI_CACHE_DIR}/ugcli"

if command -v ugcli >/dev/null 2>&1; then
    UGCLI="$(command -v ugcli)"
else
    mkdir -p "${UGCLI_CACHE_DIR}"
    if [ ! -s "${UGCLI_BIN}" ]; then
        echo "==> 下载绿联官方 ugcli 打包工具..."
        curl -fL --retry 3 --connect-timeout 15 -o "${UGCLI_BIN}.tmp" "${UGCLI_URL}"
        if [ ! -s "${UGCLI_BIN}.tmp" ]; then
            echo "错误: 下载 ugcli 失败或文件为空" >&2
            rm -f "${UGCLI_BIN}.tmp"
            exit 1
        fi
        chmod +x "${UGCLI_BIN}.tmp"
        mv -f "${UGCLI_BIN}.tmp" "${UGCLI_BIN}"
    fi
    UGCLI="${UGCLI_BIN}"
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "${WORK_DIR}"' EXIT

PROJ_DIR="${WORK_DIR}/spacemap-upk"
mkdir -p \
    "${PROJ_DIR}/rootfs_common/www" \
    "${PROJ_DIR}/rootfs_amd64/bin" \
    "${PROJ_DIR}/rootfs_arm64/bin"

sed "s/__VERSION__/${VERSION}/g" "${SCRIPT_DIR}/project.yaml.tmpl" > "${PROJ_DIR}/project.yaml"

ICON_SRC="${ICONS_DIR}/ICON_256.PNG"
if [ ! -f "${ICON_SRC}" ]; then
    echo "错误: 未找到 256x256 图标文件: ${ICON_SRC}" >&2
    exit 1
fi
cp "${ICON_SRC}" "${PROJ_DIR}/rootfs_common/icon.png"

cp -r "${ROOT_DIR}/web/." "${PROJ_DIR}/rootfs_common/www/"
find "${PROJ_DIR}/rootfs_common/www" -mindepth 1 \( -name '.*' -o -name 'embed.go' \) -exec rm -rf {} +
chmod -R a+rX "${PROJ_DIR}/rootfs_common"

cp "${AMD64_BIN}" "${PROJ_DIR}/rootfs_amd64/bin/spacemap"
cp "${ARM64_BIN}" "${PROJ_DIR}/rootfs_arm64/bin/spacemap"
chmod 755 "${PROJ_DIR}/rootfs_amd64/bin/spacemap" "${PROJ_DIR}/rootfs_arm64/bin/spacemap"

echo "==> 执行 ugcli check & pack..."
(
    cd "${PROJ_DIR}"
    "${UGCLI}" check
    "${UGCLI}" pack --arch all --build 1
)

mkdir -p "${OUT_DIR}"

AMD64_UPK="$(find "${PROJ_DIR}" -maxdepth 5 -type f -name '*.upk' \( -iname '*amd64*' -o -iname '*x86*' \) | head -n 1 || true)"
ARM64_UPK="$(find "${PROJ_DIR}" -maxdepth 5 -type f -name '*.upk' -iname '*arm64*' | head -n 1 || true)"

if [ -z "${AMD64_UPK}" ] || [ -z "${ARM64_UPK}" ]; then
    echo "错误: 未能找到双架构 .upk 输出文件，当前目录结构如下:" >&2
    find "${PROJ_DIR}" -maxdepth 5 -ls >&2
    exit 1
fi

cp -f "${AMD64_UPK}" "${OUT_DIR}/SpaceMap_${VERSION}_amd64.upk"
cp -f "${ARM64_UPK}" "${OUT_DIR}/SpaceMap_${VERSION}_arm64.upk"
echo "    已生成: ${OUT_DIR}/SpaceMap_${VERSION}_amd64.upk"
echo "    已生成: ${OUT_DIR}/SpaceMap_${VERSION}_arm64.upk"
