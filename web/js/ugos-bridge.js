// 绿联 UGOS Pro 桌面环境前端能力桥接（离线封装 @ugreen-nas/core，非宿主环境静默跳过）
let coreInitialized = false;
let cloudWindowRef = null;
let initPromise = null;

function inUGOSHostFrame() {
    try {
        return window.self !== window.top || window.UgWebHost != null;
    } catch (_) {
        return true;
    }
}

async function ensureReady() {
    if (!inUGOSHostFrame()) return false;
    if (coreInitialized && cloudWindowRef) return true;
    if (!initPromise) {
        initPromise = (async () => {
            try {
                const [coreMod, cwMod] = await Promise.all([
                    import('../assets/ugos-core/ugos-core/index.js'),
                    import('../assets/ugos-core/cloudWindow/index.js')
                ]);
                const UGOSCore = coreMod && coreMod.default ? coreMod.default : coreMod;
                const cloudWindow = cwMod && cwMod.default ? cwMod.default : cwMod;
                if (UGOSCore && typeof UGOSCore.init === 'function') {
                    UGOSCore.init();
                }
                if (cloudWindow && typeof cloudWindow.useCapacity === 'function') {
                    cloudWindowRef = cloudWindow;
                    coreInitialized = true;
                    return true;
                }
            } catch (_) {
                // 非绿联宿主或浏览器不支持时不报错
            }
            return false;
        })();
    }
    return initPromise;
}

function normalizePath(rawPath) {
    let p = String(rawPath || '').trim().replace(/\\/g, '/');
    if (!p) return '';
    if (p.length > 1) p = p.replace(/\/+$/, '');

    // 将绿联沙箱映射路径还原为真实系统路径，便于文件管理器正确定位
    const volMatch = p.match(/^\/var\/packages\/[^/]+\/shared\/(volume\d+(?:\/.*)?)$/);
    if (volMatch) {
        return '/' + volMatch[1];
    }
    const homeMatch = p.match(/^\/var\/packages\/[^/]+\/shared\/(home(?:\/.*)?)$/);
    if (homeMatch) {
        return '/' + homeMatch[1];
    }
    return p;
}

async function openFileManager(rawPath) {
    const ok = await ensureReady();
    if (!ok || !cloudWindowRef) {
        return false;
    }
    const targetPath = normalizePath(rawPath);
    if (!targetPath) return false;
    try {
        await cloudWindowRef.useCapacity(
            'openApp',
            {
                appId: 'com.ugreen.filemgr',
                data: { filePathOpen: targetPath }
            },
            5000
        );
        return true;
    } catch (_) {
        return false;
    }
}

async function openAppCenter() {
    const ok = await ensureReady();
    if (!ok || !cloudWindowRef) {
        return false;
    }
    try {
        await cloudWindowRef.useCapacity(
            'openAppCenterDetail',
            {
                appId: 'com.danborad.spacemap',
                appCenterType: 'installed'
            },
            4000
        );
        return true;
    } catch (_) {
        try {
            await cloudWindowRef.useCapacity(
                'openApp',
                { appId: 'com.ugreen.appcenter' },
                4000
            );
            return true;
        } catch (_) {
            return false;
        }
    }
}

// 预加载初始化（非绿联宿主环境直接空操作返回）
ensureReady().catch(() => {});

window.UGOSBridge = {
    isAvailable: () => !!(inUGOSHostFrame() && coreInitialized && cloudWindowRef),
    ensureReady,
    normalizePath,
    openFileManager,
    openAppCenter
};
