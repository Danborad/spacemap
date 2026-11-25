#!/bin/sh
CONF=/etc/config/qpkg.conf
[ -f "$CONF" ] || CONF=/mnt/HDA_ROOT/.config/qpkg.conf
QPKG_NAME="SpaceMap"
QPKG_ROOT=$(/sbin/getcfg "$QPKG_NAME" Install_Path -f "$CONF" 2>/dev/null || true)
if [ -z "$QPKG_ROOT" ]; then
    QPKG_ROOT="$(cd "$(dirname "$0")" && pwd)"
fi

PID_FILE="${QPKG_ROOT}/data/spacemap.pid"
LOG_FILE="${QPKG_ROOT}/data/spacemap.log"
APP_BIN="${QPKG_ROOT}/spacemap"

mkdir -p "${QPKG_ROOT}/data"
chmod +x "${APP_BIN}" 2>/dev/null || true

is_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE" 2>/dev/null)
        if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
            return 0
        fi
    fi
    return 1
}

case "$1" in
    start)
        ENABLED=$(/sbin/getcfg "$QPKG_NAME" Enable -u -d TRUE -f "$CONF" 2>/dev/null || echo "TRUE")
        if [ "$ENABLED" != "TRUE" ]; then
            echo "$QPKG_NAME is disabled."
            exit 0
        fi
        if is_running; then
            echo "$QPKG_NAME is already running."
            exit 0
        fi
        export PORT=7080
        export DATA_DIR="${QPKG_ROOT}/data"
        if command -v nohup >/dev/null 2>&1; then
            nohup "${APP_BIN}" >> "${LOG_FILE}" 2>&1 </dev/null &
            APP_PID=$!
        elif command -v setsid >/dev/null 2>&1; then
            setsid "${APP_BIN}" >> "${LOG_FILE}" 2>&1 </dev/null &
            APP_PID=$!
        else
            "${APP_BIN}" >> "${LOG_FILE}" 2>&1 </dev/null &
            APP_PID=$!
        fi
        echo "${APP_PID}" > "${PID_FILE}"
        sleep 1
        if ! kill -0 "${APP_PID}" 2>/dev/null; then
            LAST_ERR=$(tail -n 1 "${LOG_FILE}" 2>/dev/null || echo "process exited")
            [ -x /sbin/log_tool ] && /sbin/log_tool -t2 -uSystem -p127.0.0.1 -mlocalhost -a "[SpaceMap] Failed to start on port 7080: ${LAST_ERR}" 2>/dev/null || true
            exit 1
        fi
        ;;
    stop)
        if is_running; then
            PID=$(cat "$PID_FILE")
            kill "$PID" 2>/dev/null || true
            sleep 1
            if kill -0 "$PID" 2>/dev/null; then
                kill -9 "$PID" 2>/dev/null || true
            fi
        fi
        rm -f "$PID_FILE"
        ;;
    restart)
        "$0" stop
        sleep 1
        "$0" start
        ;;
    status)
        if is_running; then
            echo "$QPKG_NAME is running."
            exit 0
        else
            echo "$QPKG_NAME is stopped."
            exit 1
        fi
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status}"
        exit 1
        ;;
esac

exit 0
