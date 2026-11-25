#!/usr/bin/env bash
set -euo pipefail

# 参数: build-fpk.sh <arch: x86|arm64> <binary_path> <version> <icons_dir> <out_dir>
ARCH="${1:?需要架构参数 x86 或 arm64}"
BIN_PATH="${2:?需要二进制路径}"
VERSION="${3:?需要版本号}"
ICONS_DIR="${4:?需要图标目录}"
OUT_DIR="${5:?需要输出目录}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

FN_PLATFORM="x86"
if [ "$ARCH" = "arm64" ] || [ "$ARCH" = "arm" ]; then
    FN_PLATFORM="arm"
fi

# 准备官方 Native FPK 标准源码目录
FPK_SRC="${WORK_DIR}/spacemap"
mkdir -p "${FPK_SRC}/app/bin" \
         "${FPK_SRC}/app/ui/images" \
         "${FPK_SRC}/cmd" \
         "${FPK_SRC}/config" \
         "${FPK_SRC}/wizard"

sed -e "s/__VERSION__/${VERSION}/g" -e "s/__PLATFORM__/${FN_PLATFORM}/g" \
    "${SCRIPT_DIR}/manifest.tmpl" > "${FPK_SRC}/manifest"

cp "${ICONS_DIR}/ICON.PNG" "${FPK_SRC}/ICON.PNG"
cp "${ICONS_DIR}/ICON_256.PNG" "${FPK_SRC}/ICON_256.PNG"
cp "${SCRIPT_DIR}/config/privilege" "${FPK_SRC}/config/privilege"
cp "${SCRIPT_DIR}/config/resource" "${FPK_SRC}/config/resource"

cp "$BIN_PATH" "${FPK_SRC}/app/bin/spacemap"
chmod 0755 "${FPK_SRC}/app/bin/spacemap"
cp "${SCRIPT_DIR}/app/ui/config" "${FPK_SRC}/app/ui/config"
cp "${ICONS_DIR}/ICON.PNG" "${FPK_SRC}/app/ui/images/icon_64.png"
cp "${ICONS_DIR}/ICON_256.PNG" "${FPK_SRC}/app/ui/images/icon_256.png"

cp "${SCRIPT_DIR}/cmd/main" "${FPK_SRC}/cmd/main"
chmod 0755 "${FPK_SRC}/cmd/main"

# 官方 Native 规范生命周期钩子脚本
for hook in install_init install_callback uninstall_init uninstall_callback upgrade_init upgrade_callback config_init; do
    cat << 'EOF' > "${FPK_SRC}/cmd/${hook}"
#!/bin/bash
exit 0
EOF
    chmod 0755 "${FPK_SRC}/cmd/${hook}"
done

# config_callback：当用户在飞牛应用设置修改访问权限时，热同步最新路径到运行目录免重启生效
cat << 'EOF' > "${FPK_SRC}/cmd/config_callback"
#!/bin/bash
LOG_FILE="${TRIM_PKGVAR}/info.log"
mkdir -p "${TRIM_PKGVAR}"
TMP_FILE="${TRIM_PKGVAR}/fnos_paths.env.tmp"
{
    printf 'TRIM_DATA_ACCESSIBLE_PATHS=%s\n' "${TRIM_DATA_ACCESSIBLE_PATHS:-}"
    printf 'TRIM_DATA_SHARE_PATHS=%s\n' "${TRIM_DATA_SHARE_PATHS:-}"
} > "${TMP_FILE}" && mv -f "${TMP_FILE}" "${TRIM_PKGVAR}/fnos_paths.env"
echo "$(date '+%Y-%m-%d %H:%M:%S') - config_callback synced paths: ${TRIM_DATA_ACCESSIBLE_PATHS:-}" >> "${LOG_FILE}"
exit 0
EOF
chmod 0755 "${FPK_SRC}/cmd/config_callback"

mkdir -p "${OUT_DIR}"
OUT_FILE="${OUT_DIR}/spacemap_${VERSION}_${ARCH}.fpk"

if command -v fnpack >/dev/null 2>&1; then
    (cd "${WORK_DIR}" && fnpack build -d "${FPK_SRC}")
    BUILT_FPK="$(find "${WORK_DIR}" -maxdepth 2 -name '*.fpk' | head -n 1)"
    if [ -z "${BUILT_FPK}" ]; then
        echo "fnpack build 未生成 .fpk 文件" >&2
        exit 1
    fi
    mv -f "${BUILT_FPK}" "${OUT_FILE}"
else
    # 非飞牛主机环境兜底打包（含 app.tgz 与 manifest checksum）
    STAGE="${WORK_DIR}/stage"
    mkdir -p "${STAGE}"
    cp -a "${FPK_SRC}/ICON.PNG" "${FPK_SRC}/ICON_256.PNG" "${FPK_SRC}/config" "${FPK_SRC}/cmd" "${FPK_SRC}/wizard" "${STAGE}/"
    tar -czf "${STAGE}/app.tgz" -C "${FPK_SRC}/app" .
    APP_MD5=$(md5sum "${STAGE}/app.tgz" | awk '{print $1}')
    cp "${FPK_SRC}/manifest" "${STAGE}/manifest"
    printf "checksum              = %s\n" "${APP_MD5}" >> "${STAGE}/manifest"
    tar -czf "${OUT_FILE}" -C "${STAGE}" .
fi

echo "已生成飞牛套件: ${OUT_FILE}"
