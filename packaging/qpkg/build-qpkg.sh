#!/usr/bin/env bash
set -euo pipefail

# 参数: build-qpkg.sh <arch: x86_64|arm_64> <binary_path> <version> <icons_dir> <out_dir>
ARCH="${1:?需要架构参数 x86_64 或 arm_64}"
BIN_PATH="${2:?需要二进制路径}"
VERSION="${3:?需要版本号}"
ICONS_DIR="${4:?需要图标目录}"
OUT_DIR="${5:?需要输出目录}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# 1. 构建 data.tar.gz（应用二进制与启停脚本）
DATA_STAGE="${WORK_DIR}/data_stage"
mkdir -p "${DATA_STAGE}"
cp "${BIN_PATH}" "${DATA_STAGE}/spacemap"
chmod 0755 "${DATA_STAGE}/spacemap"
cp "${SCRIPT_DIR}/shared/spacemap.sh" "${DATA_STAGE}/spacemap.sh"
chmod 0755 "${DATA_STAGE}/spacemap.sh"
tar -czf "${WORK_DIR}/data.tar.gz" -C "${DATA_STAGE}" .

# 2. 构建 control.tar.gz 并用非压缩 tar 包装为 control.tar（QTS 标准格式）
CTRL_STAGE="${WORK_DIR}/ctrl_stage"
mkdir -p "${CTRL_STAGE}"
sed -e "s/__VERSION__/${VERSION}/g" -e "s/__QPKG_ARCH__/${ARCH}/g" \
    "${SCRIPT_DIR}/qpkg.cfg.tmpl" > "${CTRL_STAGE}/qpkg.cfg"
cp "${SCRIPT_DIR}/qinstall.sh" "${CTRL_STAGE}/qinstall.sh"
chmod 0755 "${CTRL_STAGE}/qinstall.sh"
cp "${ICONS_DIR}/spacemap.gif" "${CTRL_STAGE}/SpaceMap.gif"
cp "${ICONS_DIR}/spacemap_80.gif" "${CTRL_STAGE}/SpaceMap_80.gif"
cp "${ICONS_DIR}/spacemap_gray.gif" "${CTRL_STAGE}/SpaceMap_gray.gif"

tar -czf "${WORK_DIR}/control.tar.gz" -C "${CTRL_STAGE}" .
tar -cf "${WORK_DIR}/control.tar" -C "${WORK_DIR}" control.tar.gz

CTRL_TAR_SIZE=$(wc -c < "${WORK_DIR}/control.tar" | tr -d ' ')
DATA_TAR_SIZE=$(wc -c < "${WORK_DIR}/data.tar.gz" | tr -d ' ')
FULL_BLOCKS=$((DATA_TAR_SIZE / 4096))
REM_BYTES=$((DATA_TAR_SIZE % 4096))

# 3. 构造标准 QPKG 自解压头部脚本，并精确计算无前导零的十进制偏移
make_header() {
    local slen="$1"
    local off="$2"
    cat <<EOF
#!/bin/sh
/bin/echo "Install QNAP package on TS-NAS..."
/bin/grep "/mnt/HDA_ROOT" /proc/mounts >/dev/null 2>&1 || true
script_len=${slen}
offset=${off}

log_fail() {
    /bin/echo -1 > /tmp/update_process 2>/dev/null || true
    [ -x /sbin/log_tool ] && /sbin/log_tool -t2 -uSystem -p127.0.0.1 -mlocalhost -a "[SpaceMap] \$1" 2>/dev/null || true
    exit 1
}

find_qpkg_install_path() {
    if [ -n "\${QINSTALL_PATH:-}" ] && [ -d "\${QINSTALL_PATH}" ]; then
        echo "\${QINSTALL_PATH}"
        return
    fi
    if [ -x /sbin/getcfg ]; then
        _PUB=\$(/sbin/getcfg Public path -f /etc/config/smb.conf 2>/dev/null)
        if [ -n "\${_PUB}" ] && [ -d "\${_PUB}" ]; then
            _BASE=\$(dirname "\${_PUB}")
            if [ -d "\${_BASE}/.qpkg" ] || mkdir -p "\${_BASE}/.qpkg" 2>/dev/null; then
                echo "\${_BASE}/.qpkg"
                return
            fi
        fi
    fi
    for _VOL in /share/CACHEDEV1_DATA /share/ZFS530_DATA /share/MD0_DATA /share/HDA_DATA; do
        if [ -d "\${_VOL}" ]; then
            mkdir -p "\${_VOL}/.qpkg" 2>/dev/null || true
            if [ -d "\${_VOL}/.qpkg" ]; then
                echo "\${_VOL}/.qpkg"
                return
            fi
        fi
    done
    echo "/tmp"
}

/bin/echo 0 > /tmp/update_process 2>/dev/null || true
QPKG_INSTALL_PATH=\$(find_qpkg_install_path)
export QPKG_INSTALL_PATH
_EXTRACT_DIR="\${QPKG_INSTALL_PATH}/.tmp-SpaceMap"
/bin/rm -rf "\${_EXTRACT_DIR}" 2>/dev/null || true
/bin/mkdir -p "\${_EXTRACT_DIR}" || log_fail "Failed to create extract dir: \${_EXTRACT_DIR}"

/bin/dd if="\${0}" bs=\${script_len} skip=1 count=32 2>/dev/null | /bin/tar -xO | /bin/tar -xz -C "\${_EXTRACT_DIR}" || log_fail "Failed to extract control archive"
/bin/dd if="\${0}" bs=\${offset} skip=1 of="\${_EXTRACT_DIR}/data.tmp" 2>/dev/null || log_fail "Failed to read data payload"
/bin/dd if="\${_EXTRACT_DIR}/data.tmp" bs=4096 count=${FULL_BLOCKS} of="\${_EXTRACT_DIR}/data.tar.gz" 2>/dev/null || log_fail "Failed to slice data archive"
/bin/dd if="\${_EXTRACT_DIR}/data.tmp" bs=4096 skip=${FULL_BLOCKS} count=1 2>/dev/null | /bin/dd bs=1 count=${REM_BYTES} 2>/dev/null >> "\${_EXTRACT_DIR}/data.tar.gz" || log_fail "Failed to append data tail"
/bin/rm -f "\${_EXTRACT_DIR}/data.tmp"

(cd "\${_EXTRACT_DIR}" && /bin/sh qinstall.sh)
RET=\$?
/bin/rm -rf "\${_EXTRACT_DIR}"
if [ "\${RET}" -eq 0 ]; then
    /bin/echo 3 > /tmp/update_process 2>/dev/null || true
    exit 10
fi
/bin/echo -1 > /tmp/update_process 2>/dev/null || true
exit \${RET}
EOF
}

# 不使用前导零，通过多轮收敛精确算出纯十进制 script_len 与 offset
CUR_SLEN=500
CUR_OFF=10000
for _ in 1 2 3 4 5; do
    make_header "${CUR_SLEN}" "${CUR_OFF}" > "${WORK_DIR}/header.sh"
    NEXT_SLEN=$(wc -c < "${WORK_DIR}/header.sh" | tr -d ' ')
    NEXT_OFF=$((NEXT_SLEN + CTRL_TAR_SIZE))
    if [ "${NEXT_SLEN}" -eq "${CUR_SLEN}" ] && [ "${NEXT_OFF}" -eq "${CUR_OFF}" ]; then
        break
    fi
    CUR_SLEN="${NEXT_SLEN}"
    CUR_OFF="${NEXT_OFF}"
done

make_header "${CUR_SLEN}" "${CUR_OFF}" > "${WORK_DIR}/header.sh"
FINAL_SLEN=$(wc -c < "${WORK_DIR}/header.sh" | tr -d ' ')
EXACT_OFFSET=$((FINAL_SLEN + CTRL_TAR_SIZE))
if [ "${FINAL_SLEN}" -ne "${CUR_SLEN}" ] || [ "${EXACT_OFFSET}" -ne "${CUR_OFF}" ]; then
    echo "header 长度未收敛: ${FINAL_SLEN} != ${CUR_SLEN}" >&2
    exit 1
fi

mkdir -p "${OUT_DIR}"
OUT_FILE="${OUT_DIR}/SpaceMap_${VERSION}_${ARCH}.qpkg"
cat "${WORK_DIR}/header.sh" "${WORK_DIR}/control.tar" "${WORK_DIR}/data.tar.gz" > "${OUT_FILE}"

# 4. 追加 QNAP QDK 官方规范末尾 100 字节元数据与 qpkg_encrypt 文件大小校验码
BODY_SIZE=$(wc -c < "${OUT_FILE}" | tr -d ' ')
TOTAL_SIZE=$((BODY_SIZE + 100))
EN_FULL=$((TOTAL_SIZE * 3589 + 1000000000))
EN_STR="${EN_FULL:0:10}"

{
    printf '%-10.10s' ""
    printf '%-30.30s' ""
    printf '%-10.10s' "${EN_STR}"
    printf '%-10.10s' ""
    printf '%-20.20s' "SpaceMap"
    printf '%-10.10s' "${VERSION}"
    printf '%-10.10s' "QNAPQPKG"
} >> "${OUT_FILE}"

ACTUAL_SIZE=$(wc -c < "${OUT_FILE}" | tr -d ' ')
if [ "${ACTUAL_SIZE}" -ne "${TOTAL_SIZE}" ]; then
    echo "QPKG 尾部大小校验失败: ${ACTUAL_SIZE} != ${TOTAL_SIZE}" >&2
    exit 1
fi

chmod 0755 "${OUT_FILE}"

echo "已生成威联通套件: ${OUT_FILE} (script_len=${FINAL_SLEN}, offset=${EXACT_OFFSET}, data_size=${DATA_TAR_SIZE}, total_size=${ACTUAL_SIZE}, encrypt=${EN_STR})"
