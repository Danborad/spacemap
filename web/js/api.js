window.SpaceAPI = (function() {
    let onUnauthorizedHandler = null;

    function setUnauthorizedHandler(fn) {
        onUnauthorizedHandler = fn;
    }

    async function request(url, options = {}) {
        const res = await fetch(url, {
            credentials: 'same-origin',
            headers: {
                'Content-Type': 'application/json',
                ...(options.headers || {})
            },
            ...options
        });

        let body = null;
        try {
            body = await res.json();
        } catch (_) {
            body = null;
        }

        if (res.status === 401 && onUnauthorizedHandler) {
            onUnauthorizedHandler();
        }

        if (!res.ok || (body && body.success === false)) {
            const msg = (body && body.error) || `请求失败 (${res.status})`;
            const err = new Error(msg);
            err.status = res.status;
            throw err;
        }
        return body ? body.data : null;
    }

    return {
        setUnauthorizedHandler,
        env: () => request('/api/env'),
        authStatus: async () => {
            const res = await fetch('/api/auth/status', { credentials: 'same-origin' });
            return res.json();
        },
        login: (password) => request('/api/auth/login', {
            method: 'POST',
            body: JSON.stringify({ password })
        }),
        logout: () => request('/api/auth/logout', { method: 'POST', body: '{}' }),
        updatePassword: (oldPassword, newPassword) => request('/api/auth/password', {
            method: 'POST',
            body: JSON.stringify({ oldPassword, newPassword })
        }),
        getRoots: () => request('/api/roots'),
        saveFolders: (folders) => request('/api/saved-folders', {
            method: 'POST',
            body: JSON.stringify({ folders })
        }),
        getSchedule: () => request('/api/schedule'),
        saveSchedule: (cfg) => request('/api/schedule', {
            method: 'POST',
            body: JSON.stringify(cfg)
        }),
        startScan: (path) => request('/api/scan/start', {
            method: 'POST',
            body: JSON.stringify({ path })
        }),
        cancelScan: (keepPartial = false) => request('/api/scan/cancel', {
            method: 'POST',
            body: JSON.stringify({ keepPartial: !!keepPartial })
        }),
        scanStatus: () => request('/api/scan/status'),
        listScans: (rootPath = '', limit = 50) => {
            const qs = new URLSearchParams();
            if (rootPath) qs.set('rootPath', rootPath);
            qs.set('limit', String(limit));
            return request(`/api/scans?${qs.toString()}`);
        },
        deleteScan: (id) => request(`/api/scans/${id}`, { method: 'DELETE' }),
        scanOverview: (id) => request(`/api/scans/${id}/overview`),
        scanChildren: (id, dirPath, limit = 200) => {
            const qs = new URLSearchParams({ path: dirPath || '', limit: String(limit) });
            return request(`/api/scans/${id}/children?${qs.toString()}`);
        },
        scanFiles: (id, params) => {
            const qs = new URLSearchParams();
            Object.entries(params || {}).forEach(([k, v]) => {
                if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
            });
            return request(`/api/scans/${id}/files?${qs.toString()}`);
        },
        coldFiles: (id, params) => {
            const qs = new URLSearchParams();
            Object.entries(params || {}).forEach(([k, v]) => {
                if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
            });
            return request(`/api/scans/${id}/cold-files?${qs.toString()}`);
        },
        findDuplicates: (id, minSize) => request(`/api/scans/${id}/duplicates`, {
            method: 'POST',
            body: JSON.stringify({ minSize })
        }),
        fileDetails: (filePath) => request(`/api/file/details?path=${encodeURIComponent(filePath)}`),
        deleteFiles: (paths) => request('/api/files/delete', {
            method: 'POST',
            body: JSON.stringify({ paths })
        }),
        getUpdateStatus: () => request('/api/update/status'),
        saveUpdateConfig: (cfg) => request('/api/update/config', {
            method: 'POST',
            body: JSON.stringify(cfg)
        }),
        checkUpdate: () => request('/api/update/check', { method: 'POST', body: '{}' }),
        applyUpdate: () => request('/api/update/apply', { method: 'POST', body: '{}' })
    };
})();
