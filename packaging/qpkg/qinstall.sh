#!/bin/sh

QPKG_NAME="SpaceMap"
CONF_DIR="/mnt/HDA_ROOT/.config"
[ -d "${CONF_DIR}" ] || CONF_DIR="/etc/config"
QPKG_CONF="${CONF_DIR}/qpkg.conf"
[ -f "${QPKG_CONF}" ] || touch "${QPKG_CONF}"

set_progress() {
    /bin/echo "${1:--1}" > /tmp/update_process 2>/dev/null || true
}

fail_install() {
    set_progress -1
    [ -x /sbin/log_tool ] && /sbin/log_tool -t2 -uSystem -p127.0.0.1 -mlocalhost -a "[SpaceMap] $1" 2>/dev/null || true
    exit 1
}

set_progress 0

get_qpkg_base() {
    if [ -n "${QPKG_INSTALL_PATH:-}" ] && [ -d "${QPKG_INSTALL_PATH}" ]; then
        echo "${QPKG_INSTALL_PATH}"
        return
    fi
    if [ -n "${QINSTALL_PATH:-}" ] && [ -d "${QINSTALL_PATH}" ]; then
        echo "${QINSTALL_PATH}"
        return
    fi
    if [ -x /sbin/getcfg ]; then
        BASE=$(/sbin/getcfg Public path -f /etc/config/smb.conf 2>/dev/null)
        if [ -n "$BASE" ]; then
            echo "$(dirname "$BASE")/.qpkg"
            return
        fi
    fi
    for vol in /share/CACHEDEV1_DATA /share/ZFS530_DATA /share/MD0_DATA /share/HDA_DATA; do
        if [ -d "$vol" ]; then
            echo "$vol/.qpkg"
            return
        fi
    done
    echo "/opt/.qpkg"
}

QPKG_INSTALL_ROOT="$(get_qpkg_base)"
QPKG_DIR="${QPKG_INSTALL_ROOT}/${QPKG_NAME}"
SELF_DIR="$(cd "$(dirname "$0")" && pwd)"

. "${SELF_DIR}/qpkg.cfg"
[ -n "${QPKG_DISPLAY_NAME:-}" ] || QPKG_DISPLAY_NAME="${QPKG_NAME}"

# 如果已有旧版本正在运行，先优雅停止
if [ -x "${QPKG_DIR}/spacemap.sh" ]; then
    "${QPKG_DIR}/spacemap.sh" stop 2>/dev/null || true
fi

set_progress 1

mkdir -p "${QPKG_DIR}/data" || fail_install "Failed to create install directory: ${QPKG_DIR}"

# 解压数据载荷
if [ -f "${SELF_DIR}/data.tar.gz" ]; then
    /bin/tar -xzf "${SELF_DIR}/data.tar.gz" -C "${QPKG_DIR}" || fail_install "Failed to extract data.tar.gz"
else
    fail_install "Missing data.tar.gz"
fi

chmod +x "${QPKG_DIR}/spacemap" "${QPKG_DIR}/spacemap.sh" 2>/dev/null || true

set_progress 2

# 写入图标
WEB_RSS_IMG="/home/httpd/RSS/images"
if [ -d "${WEB_RSS_IMG}" ]; then
    cp -f "${SELF_DIR}/${QPKG_NAME}.gif" "${WEB_RSS_IMG}/${QPKG_NAME}.gif" 2>/dev/null || true
    cp -f "${SELF_DIR}/${QPKG_NAME}_80.gif" "${WEB_RSS_IMG}/${QPKG_NAME}_80.gif" 2>/dev/null || true
    cp -f "${SELF_DIR}/${QPKG_NAME}_gray.gif" "${WEB_RSS_IMG}/${QPKG_NAME}_gray.gif" 2>/dev/null || true
fi

# 注册服务自启与关机脚本
ln -sf "${QPKG_DIR}/spacemap.sh" "/etc/init.d/spacemap.sh" 2>/dev/null || true
if [ -d "/etc/rcS.d" ]; then
    ln -sf "/etc/init.d/spacemap.sh" "/etc/rcS.d/QS${QPKG_RC_NUM:-101}${QPKG_NAME}" 2>/dev/null || true
fi
if [ -d "/etc/rcK.d" ]; then
    SHUT_NUM=$(printf "%03d" $((1000 - ${QPKG_RC_NUM:-101})))
    ln -sf "/etc/init.d/spacemap.sh" "/etc/rcK.d/QK${SHUT_NUM}${QPKG_NAME}" 2>/dev/null || true
fi

# 生成标准卸载脚本
cat <<EOF > "${QPKG_DIR}/.uninstall.sh"
#!/bin/sh
if [ -x "${QPKG_DIR}/spacemap.sh" ]; then
    "${QPKG_DIR}/spacemap.sh" stop 2>/dev/null || true
fi
rm -f "/etc/init.d/spacemap.sh"
rm -f /etc/rcS.d/QS*${QPKG_NAME} /etc/rcK.d/QK*${QPKG_NAME} 2>/dev/null || true
rm -f "${WEB_RSS_IMG}/${QPKG_NAME}.gif" "${WEB_RSS_IMG}/${QPKG_NAME}_80.gif" "${WEB_RSS_IMG}/${QPKG_NAME}_gray.gif" 2>/dev/null || true
rm -rf "${QPKG_DIR}"
exit 0
EOF
chmod 0755 "${QPKG_DIR}/.uninstall.sh" 2>/dev/null || true

# 写入 qpkg.conf
if [ -x /sbin/setcfg ]; then
    /sbin/setcfg "${QPKG_NAME}" Name "${QPKG_NAME}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Display_Name "${QPKG_DISPLAY_NAME}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Version "${QPKG_VER}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Author "${QPKG_AUTHOR}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" QPKG_File "${QPKG_NAME}.qpkg" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Date "$(date +%F)" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Shell "${QPKG_DIR}/spacemap.sh" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Install_Path "${QPKG_DIR}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" WebUI "${QPKG_WEBUI}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Web_Port "${QPKG_WEB_PORT}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Service_Port "${QPKG_SERVICE_PORT:-7080}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Desktop "${QPKG_DESKTOP_APP:-1}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Win_Width "${QPKG_DESKTOP_APP_WIN_WIDTH:-1178}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Win_Height "${QPKG_DESKTOP_APP_WIN_HEIGHT:-600}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Timeout "${QPKG_TIMEOUT:-10,30}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" RC_Number "${QPKG_RC_NUM:-101}" -f "${QPKG_CONF}"
    /sbin/setcfg "${QPKG_NAME}" Enable "TRUE" -f "${QPKG_CONF}"
fi

sync

# 启动服务
"${QPKG_DIR}/spacemap.sh" start || true

if [ -x /usr/local/sbin/notify ]; then
    /usr/local/sbin/notify send -A A039 -C C001 -M 46 -l info -t 3 "[{0}] {1} {2} has been installed in {3} successfully." "App Center" "${QPKG_DISPLAY_NAME}" "${QPKG_VER}" "${QPKG_DIR}" 2>/dev/null || true
elif [ -x /sbin/log_tool ]; then
    /sbin/log_tool -t0 -uSystem -p127.0.0.1 -mlocalhost -a "[App Center] Installed ${QPKG_DISPLAY_NAME} ${QPKG_VER} in ${QPKG_DIR}." 2>/dev/null || true
fi

set_progress 3
exit 0
