(function() {
    const U = window.SpaceUtils;
    const API = window.SpaceAPI;
    const Charts = window.SpaceCharts;

    const PAGE_META = {
        overview: {
            title: '空间总览与目录树图',
            sub: () => state.overviewData && state.overviewData.scan
                ? `当前快照：${state.overviewData.scan.rootPath} · 更新于 ${U.formatTimeMs(state.overviewData.scan.finishedAt || state.overviewData.scan.startedAt)} · 已自动排除硬链接重复计算`
                : '选择授权目录后点击「立即扫描」开始分析空间占用、硬链接与重复文件',
            tag: () => ''
        },
        largeFiles: {
            title: '大文件占用排行',
            sub: () => '快速定位体积最大的单个文件，支持按关键词、类型、最小体积与修改时间多维筛选',
            tag: () => state.largeTotal ? `匹配 ${state.largeTotal.toLocaleString()} 个文件` : ''
        },
        duplicates: {
            title: '重复文件精确清理',
            sub: () => '采用「大小预筛 → 首尾 64KB → 全量 SHA-256」三级校验，自动跳过硬链接防误删',
            tag: () => state.dupReport && state.dupReport.groupCount
                ? `${state.dupReport.groupCount} 组可释放 ${U.formatBytes(state.dupReport.reclaimableBytes)}`
                : ''
        },
        coldFiles: {
            title: '沉睡冷数据排查',
            sub: () => '筛选长期未修改的大体积归档、旧安装包与历史镜像，辅助安全释放冷存储',
            tag: () => state.coldTotal ? `共 ${state.coldTotal.toLocaleString()} 个沉睡文件` : ''
        },
        history: {
            title: '存储增长历史趋势',
            sub: () => '基于 SQLite 轻量化存储，长期记录空间增量变化并支持历史快照回溯',
            tag: () => state.scansList.length ? `共 ${state.scansList.length} 条记录` : ''
        },
        settings: {
            title: '扫描目录与任务设置',
            sub: () => '管理授权扫描路径、后台定时自动扫描计划与访问密码保护',
            tag: () => ''
        }
    };

    const state = {
        view: 'overview',
        theme: localStorage.getItem('spacemap_theme') || 'auto',
        env: null,
        rootsData: null,
        selectedRootPath: localStorage.getItem('spacemap_selected_root') || '',
        currentScanId: null,
        snapshotSeq: 0,
        loadedLargeScanId: null,
        loadedColdScanId: null,
        overviewData: null,
        scansList: [],
        writable: false,

        // 树图与节点检查器联动状态
        chartMode: 'treemap',
        topLimit: 20,
        explorerPath: '',
        explorerChildren: null,
        inspectedNode: null,       // 当前选中的目录或文件（树图点击选中某子目录时联动右侧展示其子项）
        inspectorChildren: null,
        inspectorSelected: new Set(),

        // 大文件
        largePage: 1,
        largeTotal: 0,
        largeItems: [],
        largeSelected: new Set(),

        // 重复文件
        dupReport: null,
        dupSelected: new Set(),

        // 冷数据
        coldPage: 1,
        coldTotal: 0,
        coldItems: [],
        coldSelected: new Set(),

        eventSource: null,
        wasScanning: false
    };

    document.addEventListener('DOMContentLoaded', async () => {
        U.mountIcons();
        initTheme();
        bindGlobalEvents();
        API.setUnauthorizedHandler(showLoginModal);
        await checkAuthAndBoot();
    });

    function initTheme() {
        applyTheme(state.theme);
        const media = window.matchMedia('(prefers-color-scheme: dark)');
        if (media && media.addEventListener) {
            media.addEventListener('change', () => {
                if (state.theme === 'auto') applyTheme('auto');
            });
        }
    }

    function applyTheme(choice) {
        state.theme = choice || 'auto';
        localStorage.setItem('spacemap_theme', state.theme);
        const isDark = state.theme === 'dark' ||
            (state.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
        document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.themeChoice === state.theme);
        });
        reRenderCharts();
    }

    function reRenderCharts() {
        if (state.explorerChildren) {
            renderExplorerChart();
        }
        if (state.scansList.length) {
            Charts.renderTrendChart('historyTrendChart', state.scansList);
        }
    }

    function updatePageHeader() {
        const meta = PAGE_META[state.view] || PAGE_META.overview;
        document.getElementById('pageHeroTitle').textContent = meta.title;
        document.getElementById('pageHeroSub').textContent = meta.sub();
        const tagText = meta.tag();
        const tagEl = document.getElementById('pageHeroTag');
        tagEl.textContent = tagText;
        tagEl.classList.toggle('hidden', !tagText);
    }

    async function checkAuthAndBoot() {
        try {
            const env = await API.env();
            state.env = env;
            document.getElementById('appVersionBadge').textContent = 'v' + (env.version || '2.1.0');
            document.getElementById('platformBadge').textContent = env.platformLabel || 'NAS 环境';
        } catch (_) {}

        try {
            const auth = await API.authStatus();
            if (auth.hasPassword) {
                document.getElementById('logoutBtn').classList.remove('hidden');
            }
            if (auth.hasPassword && !auth.authenticated) {
                showLoginModal();
                return;
            }
        } catch (err) {
            U.toast('检查服务状态失败: ' + err.message, 'error');
        }
        await bootAppData();
    }

    function showLoginModal() {
        document.getElementById('loginModal').classList.remove('hidden');
        setTimeout(() => document.getElementById('loginPasswordInput')?.focus(), 50);
    }

    async function bootAppData() {
        await loadRoots();
        await loadSchedule();
        await refreshScansAndView();
        loadUpdateStatus(true).catch(() => {});
        connectSSE();
    }

    async function loadRoots() {
        const prevSignature = ((state.rootsData && state.rootsData.authorized) || [])
            .map(r => `${r.path}:${r.writable ? 1 : 0}`)
            .join('|');
        const data = await API.getRoots();
        state.rootsData = data;

        const authRoots = data.authorized || [];
        const nextSignature = authRoots.map(r => `${r.path}:${r.writable ? 1 : 0}`).join('|');
        const select = document.getElementById('rootSelect');
        if (!authRoots.length) {
            select.innerHTML = '<option value="">尚未配置扫描路径</option>';
            state.selectedRootPath = '';
        } else {
            if (!authRoots.some(r => r.path === state.selectedRootPath)) {
                state.selectedRootPath = authRoots[0].path;
                localStorage.setItem('spacemap_selected_root', state.selectedRootPath);
            }
            select.innerHTML = authRoots.map(r =>
                `<option value="${U.escapeHtml(r.path)}">${U.escapeHtml(r.name)} (${U.escapeHtml(r.path)})</option>`
            ).join('');
            select.value = state.selectedRootPath;
        }
        updateWritableBadge();
        renderSettingsRoots();
        return prevSignature !== nextSignature;
    }

    let lastFocusSyncAt = 0;
    async function syncRootsOnFocus(manual = false) {
        const now = Date.now();
        if (!manual && now - lastFocusSyncAt < 3000) return;
        lastFocusSyncAt = now;
        try {
            const changed = await loadRoots();
            if (changed) {
                await refreshScansAndView();
                U.toast('已同步最新授权目录列表', 'ok');
            } else if (manual) {
                U.toast('授权目录已是最新', 'info');
            }
        } catch (err) {
            if (manual) U.toast('刷新目录失败: ' + err.message, 'error');
        }
    }

    function updateWritableBadge() {
        const badge = document.getElementById('rwStatusBadge');
        const dot = document.getElementById('rwDot');
        const roots = (state.rootsData && state.rootsData.authorized) || [];
        const current = roots.find(r => r.path === state.selectedRootPath);
        if (!current) {
            badge.textContent = '未选择';
            badge.className = 'rw-pill';
            dot.className = 'rw-dot';
            state.writable = false;
            return;
        }
        state.writable = !!current.writable;
        if (state.writable) {
            badge.textContent = '读写';
            badge.className = 'rw-pill ok';
            dot.className = 'rw-dot ok';
        } else {
            badge.textContent = '只读';
            badge.className = 'rw-pill warn';
            dot.className = 'rw-dot warn';
        }
    }

    async function refreshScansAndView() {
        if (!state.selectedRootPath) {
            state.scansList = [];
            state.currentScanId = null;
            state.overviewData = null;
            const platform = state.rootsData && state.rootsData.platform;
            let tip = '尚未发现可扫描目录，请前往「设置」添加或授权扫描路径。';
            if (platform === 'fnos') {
                tip = '尚未检测到授权目录，请打开飞牛「应用中心 → SpaceMap 存储分析 → 应用设置 → 访问权限」添加允许访问的文件夹，保存后刷新即可。';
            } else if (platform === 'ugos') {
                tip = '尚未检测到扫描目录，请在绿联「应用中心 → SpaceMap 存储分析 → 应用设置（或应用配置）」中点击添加「扫描文件夹」或授权可访问文件夹，保存并重启应用后刷新即可。';
            }
            toggleEmptyState(true, tip);
            updatePageHeader();
            return;
        }

        const scans = await API.listScans(state.selectedRootPath, 50);
        state.scansList = scans || [];
        renderHistoryTable();

        const latestWithDetails = state.scansList.find(s => (s.status === 'completed' || s.status === 'partial') && s.hasDetails);
        if (!latestWithDetails) {
            state.currentScanId = null;
            state.overviewData = null;
            toggleEmptyState(true, `路径「${state.selectedRootPath}」尚无完整扫描快照，点击右上角「立即扫描」开始分析。`);
            updatePageHeader();
            return;
        }

        await loadScanSnapshot(latestWithDetails.id);
    }

    async function loadScanSnapshot(scanID) {
        const seq = ++state.snapshotSeq;
        state.currentScanId = scanID;
        state.loadedLargeScanId = null;
        state.loadedColdScanId = null;
        toggleEmptyState(false);

        const ov = await API.scanOverview(scanID);
        if (seq !== state.snapshotSeq) return;

        state.overviewData = ov;
        state.writable = !!ov.writable;
        state.explorerPath = ov.scan.rootPath;
        state.inspectedNode = null;
        state.inspectorSelected.clear();
        state.largeSelected.clear();
        state.dupSelected.clear();
        state.coldSelected.clear();
        state.dupReport = null;
        document.getElementById('dupGroupsContainer').innerHTML = '';
        document.getElementById('dupSelectKeepNewestBtn').classList.add('hidden');
        document.getElementById('dupSelectKeepOldestBtn').classList.add('hidden');
        document.getElementById('dupBulkDeleteBtn').classList.add('hidden');
        document.getElementById('navDupCount').classList.add('hidden');

        renderOverviewKPIAndSegments();

        // 直接复用 overview 已返回的顶层目录与直接文件渲染树图，避免重复查根目录 children
        const rootFolders = ov.topFolders || [];
        const rootFiles = ov.directFiles || [];
        const rootData = {
            path: ov.scan.rootPath,
            rootPath: ov.scan.rootPath,
            currentSize: ov.scan.totalSize,
            folders: rootFolders,
            files: rootFiles
        };
        state.explorerChildren = rootData;
        renderBreadcrumbs(ov.scan.rootPath, ov.scan.rootPath);

        if (rootFolders.length > 0) {
            state.inspectedNode = rootFolders[0];
            renderExplorerChart();
            // 右侧节点检查器异步加载，不阻塞主视图切换
            inspectFolderNode(rootFolders[0], false).catch(() => {});
        } else {
            state.inspectorChildren = rootData;
            renderInspectorPanel(ov.scan.rootPath, ov.scan.totalSize, rootFolders, rootFiles, false);
            renderExplorerChart();
        }

        Charts.renderTrendChart('historyTrendChart', state.scansList);
        updatePageHeader();

        // 大文件与冷数据按需加载：仅当前正停留在对应标签页时立即拉取
        if (state.view === 'largeFiles') {
            await loadLargeFiles(1);
        } else if (state.view === 'coldFiles') {
            await loadColdFiles(1);
        }
    }

    function toggleEmptyState(showEmpty, desc = '') {
        const hero = document.getElementById('emptyStateHero');
        const container = document.querySelector('.view-container');
        if (showEmpty) {
            if (desc) document.getElementById('emptyStateDesc').textContent = desc;
            hero.classList.remove('hidden');
            if (state.view === 'settings') {
                hero.classList.add('hidden');
                container.classList.remove('hidden');
            } else {
                container.classList.add('hidden');
            }
        } else {
            hero.classList.add('hidden');
            container.classList.remove('hidden');
        }
    }

    function renderOverviewKPIAndSegments() {
        const ov = state.overviewData;
        if (!ov || !ov.scan) return;
        const sc = ov.scan;
        const prev = ov.previousScan;

        document.getElementById('kpiUniqueSize').textContent = U.formatBytes(sc.uniqueSize);
        document.getElementById('kpiHardlinkSub').textContent = `逻辑总大小 ${U.formatBytes(sc.totalSize)}`;
        document.getElementById('kpiHardlinkSaved').textContent = U.formatBytes(sc.hardlinkSaved || 0);
        document.getElementById('kpiTotalFiles').textContent = (sc.totalFiles || 0).toLocaleString();
        document.getElementById('kpiFoldersSub').textContent = `共 ${(sc.totalFolders || 0).toLocaleString()} 个目录`;
        document.getElementById('kpiLargestFile').textContent = U.formatBytes(ov.largestFileSize || 0);
        const avgSize = sc.totalFiles > 0 ? sc.uniqueSize / sc.totalFiles : 0;
        document.getElementById('kpiLargestSub').textContent = `单文件均占 ${U.formatBytes(avgSize)}`;

        const deltaValEl = document.getElementById('kpiDeltaVal');
        if (prev && prev.uniqueSize > 0) {
            const diff = sc.uniqueSize - prev.uniqueSize;
            const pct = (diff / prev.uniqueSize) * 100;
            const sign = pct > 0 ? '+' : '';
            deltaValEl.textContent = `${sign}${pct.toFixed(1)}%`;
            document.getElementById('kpiScanTimeSub').textContent = `变化 ${diff >= 0 ? '+' : '-'}${U.formatBytes(Math.abs(diff))}`;
        } else {
            deltaValEl.textContent = '基准';
            document.getElementById('kpiScanTimeSub').textContent = U.formatTimeMs(sc.finishedAt || sc.startedAt);
        }

        renderTypeSegmentBar(ov.typeStats || []);
    }

    function renderTypeSegmentBar(typeStats) {
        const bar = document.getElementById('typeSegmentBar');
        const readout = document.getElementById('typeSegmentReadout');
        const valid = (typeStats || []).filter(s => s.size > 0);
        const total = valid.reduce((sum, s) => sum + s.size, 0);

        if (!valid.length || total <= 0) {
            bar.innerHTML = '';
            readout.textContent = '当前目录下无文件';
            return;
        }

        const topStat = valid[0];
        const topPct = ((topStat.size / total) * 100).toFixed(1);
        readout.textContent = `${U.typeLabel(topStat.type)} · ${U.formatBytes(topStat.size)} (${topPct}%) · ${topStat.count.toLocaleString()} 个文件`;

        bar.innerHTML = valid.map(s => {
            const pct = Math.max(0.8, (s.size / total) * 100);
            const tip = `${U.typeLabel(s.type)} · ${U.formatBytes(s.size)} (${((s.size / total) * 100).toFixed(1)}%) · ${s.count.toLocaleString()} 个文件`;
            return `<div class="seg-slice" data-seg-tip="${U.escapeHtml(tip)}" style="width:${pct.toFixed(2)}%;background:${U.typeColor(s.type)}"></div>`;
        }).join('');

        bar.querySelectorAll('.seg-slice').forEach(el => {
            el.onmouseenter = () => { readout.textContent = el.dataset.segTip; };
        });
    }

    // =========================================================================
    // 空间总览双栏核心：左侧树图/排行 + 右侧实时节点检查器（Node Inspector）
    // =========================================================================
    let isLoadingExplorerDir = false;
    async function loadExplorerDir(dirPath) {
        if (!state.currentScanId || !dirPath) return;
        if (isLoadingExplorerDir) return;
        isLoadingExplorerDir = true;
        try {
            const data = await API.scanChildren(state.currentScanId, dirPath, 200);
            state.explorerChildren = data;
            state.explorerPath = data.path;
            state.inspectorSelected.clear();

            renderBreadcrumbs(data.rootPath, data.path);

            const folders = data.folders || [];
            if (folders.length > 0) {
                // 默认选中最大子目录在右侧展示其内容，实现即看即联动
                await inspectFolderNode(folders[0], false);
            } else {
                state.inspectedNode = null;
                state.inspectorChildren = data;
                renderInspectorPanel(data.path, data.currentSize, data.folders || [], data.files || [], false);
            }
            renderExplorerChart();
        } catch (err) {
            U.toast(err.message || '加载目录失败', 'error');
        } finally {
            isLoadingExplorerDir = false;
        }
    }

    async function inspectFolderNode(folderItem, rerenderChart = true) {
        if (!folderItem || !folderItem.path || !state.currentScanId) return;
        state.inspectedNode = folderItem;
        state.inspectorSelected.clear();
        if (rerenderChart) renderExplorerChart();

        const sub = await API.scanChildren(state.currentScanId, folderItem.path, 200);
        state.inspectorChildren = sub;
        renderInspectorPanel(folderItem.path, folderItem.size, sub.folders || [], sub.files || [], true);
    }

    function parentDirPath(p) {
        if (!p) return '';
        const clean = p.replace(/\/+$/, '');
        const idx = clean.lastIndexOf('/');
        return idx > 0 ? clean.slice(0, idx) : clean;
    }

    function buildSmbPaths(absPath) {
        if (!absPath) return null;
        const clean = absPath.replace(/\/+$/, '') || '/';
        const host = window.location.hostname || 'localhost';

        const candidates = [];
        const roots = state.rootsData || {};
        [...(roots.authorized || []), ...(roots.discovered || []), ...(roots.saved || [])].forEach(r => {
            if (r && r.path) candidates.push({ path: r.path.replace(/\/+$/, ''), name: r.name || '' });
        });
        if (state.overviewData && state.overviewData.scan && state.overviewData.scan.rootPath) {
            const rp = state.overviewData.scan.rootPath.replace(/\/+$/, '');
            if (!candidates.some(c => c.path === rp)) {
                candidates.push({ path: rp, name: rp.split('/').filter(Boolean).pop() || rp });
            }
        }

        let matched = null;
        for (const c of candidates) {
            if (!c.path) continue;
            if (clean === c.path || clean.startsWith(c.path + '/')) {
                if (!matched || c.path.length > matched.path.length) {
                    matched = c;
                }
            }
        }

        let shareName = '';
        let rel = '';
        if (matched) {
            shareName = matched.name || matched.path.split('/').filter(Boolean).pop() || '';
            rel = clean.slice(matched.path.length).replace(/^\/+/, '');
        } else {
            const qnapM = clean.match(/^\/share\/(?:[^/]+_DATA\/)?([^/]+)(?:\/(.*))?$/);
            const fnosM = clean.match(/^\/vol\d+\/\d+\/([^/]+)(?:\/(.*))?$/);
            const ugosM = clean.match(/^\/volume\d+\/([^/]+)(?:\/(.*))?$/);
            if (qnapM) {
                shareName = qnapM[1];
                rel = qnapM[2] || '';
            } else if (fnosM) {
                shareName = fnosM[1];
                rel = fnosM[2] || '';
            } else if (ugosM) {
                shareName = ugosM[1];
                rel = ugosM[2] || '';
            } else {
                const segs = clean.split('/').filter(Boolean);
                shareName = segs[0] || '';
                rel = segs.slice(1).join('/');
            }
        }

        if (!shareName) return null;
        const win = `\\\\${host}\\${shareName}` + (rel ? `\\${rel.replace(/\//g, '\\')}` : '');
        const mac = `smb://${host}/${shareName}` + (rel ? `/${rel}` : '');
        const isMac = /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent || '');
        return { win, mac, preferred: isMac ? mac : win };
    }

    async function copySmbPath(absPath, mode = 'preferred') {
        const smb = buildSmbPaths(absPath);
        if (!smb) {
            U.toast('无法解析 SMB 路径', 'error');
            return;
        }
        const text = smb[mode] || smb.preferred;
        const ok = await U.copyText(text);
        if (ok) {
            U.toast(`已复制 SMB 路径：${text}`, 'ok');
        } else {
            U.toast(`复制失败，请手动复制：${text}`, 'info');
        }
    }

    function renderInspectorPanel(targetPath, targetSize, folders, files, canDrill) {
        document.getElementById('inspectorTitle').textContent = targetPath || '-';
        document.getElementById('inspectorSize').textContent = U.formatBytes(targetSize || 0);

        const copySmbBtn = document.getElementById('inspectorCopySmbBtn');
        if (targetPath && buildSmbPaths(targetPath)) {
            copySmbBtn.classList.remove('hidden');
            copySmbBtn.onclick = () => copySmbPath(targetPath);
        } else {
            copySmbBtn.classList.add('hidden');
            copySmbBtn.onclick = null;
        }

        const drillBtn = document.getElementById('inspectorDrillBtn');
        if (canDrill && targetPath && targetPath !== state.explorerPath) {
            drillBtn.classList.remove('hidden');
            drillBtn.onclick = () => loadExplorerDir(targetPath);
        } else {
            drillBtn.classList.add('hidden');
            drillBtn.onclick = null;
        }

        const listEl = document.getElementById('inspectorList');
        const baseSize = Math.max(targetSize || 0, 1);
        const rows = [
            ...(folders || []).map(f => ({ ...f, kind: 'folder' })),
            ...(files || []).map(f => ({ ...f, kind: 'file' }))
        ].sort((a, b) => b.size - a.size);

        updateBulkBtn('inspectorBulkDeleteBtn', state.inspectorSelected);
        document.getElementById('inspectorSelectAll').checked = false;

        if (!rows.length) {
            listEl.innerHTML = '<div style="padding:36px 12px;text-align:center;color:var(--ink-muted);font-size:12px;">该目录为空</div>';
            return;
        }

        listEl.innerHTML = rows.slice(0, 80).map(r => {
            const isDir = r.kind === 'folder';
            const pct = (((r.size || 0) / baseSize) * 100).toFixed(1);
            const checked = state.inspectorSelected.has(r.path);
            const metaText = isDir
                ? `${r.folderCount || 0} 子目录 · ${r.fileCount || 0} 文件 · 占 ${pct}%`
                : `${U.typeLabel(r.type)} · 占 ${pct}% · ${U.formatTimeSec(r.mtime)}`;
            const delDisabled = !state.writable ? 'disabled title="只读挂载不可删除"' : '';

            return `
                <div class="inspector-row">
                    <div class="inspector-row-left">
                        ${isDir
                            ? `<span class="item-icon folder">${U.ICONS.folder}</span>`
                            : `<input type="checkbox" class="ins-cb" data-path="${U.escapeHtml(r.path)}" ${checked ? 'checked' : ''}>`}
                        <div style="min-width:0;flex:1;">
                            <button class="inspector-row-name" data-ins-kind="${r.kind}" data-ins-path="${U.escapeHtml(r.path)}" title="${U.escapeHtml(r.path)}">${U.escapeHtml(r.name)}</button>
                            <div class="inspector-row-meta">${U.escapeHtml(metaText)}</div>
                        </div>
                    </div>
                    <div class="inspector-row-right">
                        <span class="inspector-row-size">${U.formatBytes(r.size)}</span>
                        ${isDir
                            ? `<button class="btn btn-ghost btn-sm" data-ins-drill="${U.escapeHtml(r.path)}">进入</button>`
                            : `<button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-ins-del="${U.escapeHtml(r.path)}" ${delDisabled}>删</button>`}
                    </div>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.inspector-row').forEach(row => {
            row.ondblclick = (e) => {
                if (e.target.closest('input') || e.target.closest('[data-ins-del]')) return;
                const nameBtn = row.querySelector('[data-ins-kind]');
                if (nameBtn && nameBtn.dataset.insKind === 'folder') {
                    loadExplorerDir(nameBtn.dataset.insPath);
                } else if (nameBtn) {
                    openFileDetails(nameBtn.dataset.insPath);
                }
            };
        });
        listEl.querySelectorAll('[data-ins-kind]').forEach(btn => {
            btn.onclick = () => {
                if (btn.dataset.insKind === 'folder') {
                    loadExplorerDir(btn.dataset.insPath);
                } else {
                    openFileDetails(btn.dataset.insPath);
                }
            };
        });
        listEl.querySelectorAll('[data-ins-drill]').forEach(btn => {
            btn.onclick = () => loadExplorerDir(btn.dataset.insDrill);
        });
        listEl.querySelectorAll('[data-ins-del]').forEach(btn => {
            btn.onclick = () => confirmAndDelete([btn.dataset.insDel]);
        });
        listEl.querySelectorAll('.ins-cb').forEach(cb => {
            cb.onchange = () => {
                if (cb.checked) state.inspectorSelected.add(cb.dataset.path);
                else state.inspectorSelected.delete(cb.dataset.path);
                updateBulkBtn('inspectorBulkDeleteBtn', state.inspectorSelected);
            };
        });
    }

    function renderBreadcrumbs(rootPath, curPath) {
        const container = document.getElementById('explorerBreadcrumbs');
        const upBtn = document.getElementById('explorerUpBtn');
        upBtn.disabled = curPath === rootPath;

        const rootNorm = rootPath.replace(/\/+$/, '') || '/';
        const curNorm = curPath.replace(/\/+$/, '') || '/';
        const rootName = rootNorm.split('/').filter(Boolean).pop() || rootNorm;
        const crumbs = [{ label: rootName, path: rootPath }];

        if (curNorm !== rootNorm) {
            const rel = rootNorm === '/' ? curNorm.slice(1) : curNorm.slice(rootNorm.length + 1);
            const parts = rel.split('/').filter(Boolean);
            let acc = rootNorm === '/' ? '' : rootNorm;
            for (const part of parts) {
                acc = acc + '/' + part;
                crumbs.push({ label: part, path: acc });
            }
        }

        container.innerHTML = crumbs.map((c, idx) => {
            const isLast = idx === crumbs.length - 1;
            const btn = `<button class="crumb-btn ${isLast ? 'current' : ''}" data-crumb-path="${U.escapeHtml(c.path)}">${U.escapeHtml(c.label)}</button>`;
            return isLast ? btn : btn + '<span class="crumb-sep">/</span>';
        }).join('');

        container.querySelectorAll('.crumb-btn').forEach(btn => {
            btn.onclick = () => loadExplorerDir(btn.dataset.crumbPath);
        });
    }

    function navigateUpExplorer() {
        const data = state.explorerChildren;
        if (!data || data.path === data.rootPath) return;
        const idx = data.path.lastIndexOf('/');
        const parent = idx <= 0 ? '/' : data.path.slice(0, idx);
        loadExplorerDir(parent.length >= data.rootPath.length ? parent : data.rootPath);
    }

    function renderExplorerChart() {
        const data = state.explorerChildren;
        if (!data) return;
        const items = [
            ...(data.folders || []).map(f => ({ name: f.name, path: f.path, size: f.size, fileCount: f.fileCount, folderCount: f.folderCount, kind: 'folder' })),
            ...(data.files || []).map(f => ({ name: f.name, path: f.path, size: f.size, kind: 'file' }))
        ].sort((a, b) => b.size - a.size).slice(0, state.topLimit);

        const activePath = state.inspectedNode ? state.inspectedNode.path : '';
        Charts.renderFolderChart(
            'overviewFolderChart',
            items,
            state.chartMode,
            activePath,
            item => {
                if (item.kind === 'folder' && item.path) {
                    // 若用户点击的是已处于选中高亮状态的同一个目录，直接下钻进入
                    if (state.inspectedNode && state.inspectedNode.path === item.path) {
                        loadExplorerDir(item.path);
                    } else {
                        inspectFolderNode(item, true);
                    }
                } else if (item.path) {
                    openFileDetails(item.path);
                }
            },
            item => {
                if (item.kind === 'folder' && item.path) {
                    loadExplorerDir(item.path);
                }
            }
        );
    }

    // =========================================================================
    // 大文件 / 冷数据 / 重复文件 / 历史 / 设置
    // =========================================================================
    async function loadLargeFiles(page = 1) {
        if (!state.currentScanId) return;
        state.largePage = page;
        const sortParts = (document.getElementById('fileSortSelect').value || 'size:desc').split(':');
        const data = await API.scanFiles(state.currentScanId, {
            q: document.getElementById('fileSearchInput').value.trim(),
            type: document.getElementById('fileTypeSelect').value,
            minSize: document.getElementById('fileMinSizeSelect').value,
            sort: sortParts[0],
            order: sortParts[1],
            page,
            pageSize: 50
        });
        state.loadedLargeScanId = state.currentScanId;
        state.largeItems = data.items || [];
        state.largeTotal = data.total || 0;
        renderFileTable('largeFilesBody', 'largeFilesSummary', 'largeFilesPager', state.largeItems, state.largeTotal, page, 50, state.largeSelected, 'largeBulkDeleteBtn', loadLargeFiles);
        if (state.view === 'largeFiles') updatePageHeader();
    }

    async function loadColdFiles(page = 1) {
        if (!state.currentScanId) return;
        state.coldPage = page;
        const data = await API.coldFiles(state.currentScanId, {
            olderThanDays: document.getElementById('coldDaysSelect').value,
            minSize: document.getElementById('coldMinSizeSelect').value,
            page,
            pageSize: 50
        });
        state.loadedColdScanId = state.currentScanId;
        state.coldItems = data.items || [];
        state.coldTotal = data.total || 0;
        renderFileTable('coldFilesBody', 'coldSummary', 'coldFilesPager', state.coldItems, state.coldTotal, page, 50, state.coldSelected, 'coldBulkDeleteBtn', loadColdFiles);
        if (state.view === 'coldFiles') updatePageHeader();
    }

    function renderFileTable(tbodyId, summaryId, pagerId, items, total, page, pageSize, selectedSet, bulkBtnId, onPageChange) {
        const tbody = document.getElementById(tbodyId);
        const summary = document.getElementById(summaryId);
        const pager = document.getElementById(pagerId);

        summary.textContent = `共匹配 ${total.toLocaleString()} 个文件（当前第 ${page} 页）`;
        updateBulkBtn(bulkBtnId, selectedSet);

        if (!items.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--ink-muted);padding:32px;">没有符合条件的文件</td></tr>';
            pager.innerHTML = '';
            return;
        }

        tbody.innerHTML = items.map(f => {
            const checked = selectedSet.has(f.path);
            const delDisabled = !state.writable ? 'disabled title="只读目录无法删除"' : '';
            return `
                <tr>
                    <td class="col-check"><input type="checkbox" class="row-cb" data-path="${U.escapeHtml(f.path)}" ${checked ? 'checked' : ''}></td>
                    <td>
                        <div class="name-cell">
                            <span class="item-icon">${U.ICONS.file}</span>
                            <button class="name-btn" data-detail-path="${U.escapeHtml(f.path)}" title="${U.escapeHtml(f.name)}">${U.escapeHtml(f.name)}</button>
                        </div>
                    </td>
                    <td><div class="path-cell" title="${U.escapeHtml(f.path)}">${U.escapeHtml(f.parentPath || f.path)}</div></td>
                    <td class="col-size"><strong>${U.formatBytes(f.size)}</strong></td>
                    <td class="col-type"><span class="badge badge-neutral">${U.escapeHtml(U.typeLabel(f.type))}</span></td>
                    <td class="col-time">${U.formatTimeSec(f.mtime)}</td>
                    <td class="col-act">
                        <button class="btn btn-ghost btn-sm" data-smb-dir="${U.escapeHtml(f.parentPath || parentDirPath(f.path))}" title="复制所在文件夹 SMB 路径">SMB</button>
                        <button class="btn btn-ghost btn-sm" data-detail-path="${U.escapeHtml(f.path)}">详情</button>
                        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del-path="${U.escapeHtml(f.path)}" ${delDisabled}>删除</button>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('[data-smb-dir]').forEach(btn => {
            btn.onclick = () => copySmbPath(btn.dataset.smbDir);
        });
        tbody.querySelectorAll('[data-detail-path]').forEach(btn => {
            btn.onclick = () => openFileDetails(btn.dataset.detailPath);
        });
        tbody.querySelectorAll('[data-del-path]').forEach(btn => {
            btn.onclick = () => confirmAndDelete([btn.dataset.delPath]);
        });
        tbody.querySelectorAll('.row-cb').forEach(cb => {
            cb.onchange = () => {
                if (cb.checked) selectedSet.add(cb.dataset.path);
                else selectedSet.delete(cb.dataset.path);
                updateBulkBtn(bulkBtnId, selectedSet);
            };
        });

        const totalPages = Math.max(1, Math.ceil(total / pageSize));
        pager.innerHTML = `
            <button class="btn btn-secondary btn-sm" ${page <= 1 ? 'disabled' : ''} id="${pagerId}_prev">上一页</button>
            <span class="table-meta" style="margin:0 6px;">${page} / ${totalPages}</span>
            <button class="btn btn-secondary btn-sm" ${page >= totalPages ? 'disabled' : ''} id="${pagerId}_next">下一页</button>
        `;
        document.getElementById(`${pagerId}_prev`).onclick = () => onPageChange(page - 1);
        document.getElementById(`${pagerId}_next`).onclick = () => onPageChange(page + 1);
    }

    async function runDuplicateCheck() {
        if (!state.currentScanId) return;
        const btn = document.getElementById('runDupCheckBtn');
        const minSize = Number(document.getElementById('dupMinSizeSelect').value || 1048576);
        btn.disabled = true;
        btn.textContent = '正在计算 SHA-256...';
        try {
            const report = await API.findDuplicates(state.currentScanId, minSize);
            state.dupReport = report;
            state.dupSelected.clear();
            renderDuplicates(report);
            updatePageHeader();
        } catch (err) {
            U.toast('查重失败: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '开始精确查重 (SHA-256)';
        }
    }

    function renderDuplicates(report) {
        const summary = document.getElementById('dupSummary');
        const box = document.getElementById('dupGroupsContainer');
        const keepNewBtn = document.getElementById('dupSelectKeepNewestBtn');
        const keepOldBtn = document.getElementById('dupSelectKeepOldestBtn');
        const countBadge = document.getElementById('navDupCount');

        if (!report || !report.groups || !report.groups.length) {
            summary.textContent = `未发现满足阈值（≥ ${U.formatBytes(report ? report.minSize : 0)}）的内容重复文件。`;
            box.innerHTML = '<div style="padding:36px;text-align:center;color:var(--ink-muted);font-size:13px;">未发现重复文件</div>';
            keepNewBtn.classList.add('hidden');
            keepOldBtn.classList.add('hidden');
            countBadge.classList.add('hidden');
            updateBulkBtn('dupBulkDeleteBtn', state.dupSelected);
            return;
        }

        countBadge.textContent = String(report.groupCount);
        countBadge.classList.remove('hidden');
        summary.textContent = `共发现 ${report.groupCount} 组重复文件（${report.duplicateFiles} 个文件），预计可释放 ${U.formatBytes(report.reclaimableBytes)} 空间`;
        keepNewBtn.classList.remove('hidden');
        keepOldBtn.classList.remove('hidden');
        updateBulkBtn('dupBulkDeleteBtn', state.dupSelected);

        box.innerHTML = report.groups.map(g => {
            const rowsHtml = g.files.map(f => {
                const checked = state.dupSelected.has(f.path);
                const delDisabled = !state.writable ? 'disabled' : '';
                return `
                    <div class="dup-file-row">
                        <div class="dup-file-main">
                            <input type="checkbox" class="dup-cb" data-path="${U.escapeHtml(f.path)}" ${checked ? 'checked' : ''}>
                            <div style="min-width:0;flex:1;">
                                <div><strong>${U.escapeHtml(f.name)}</strong> · <span style="color:var(--ink-muted)">修改于 ${U.formatTimeSec(f.mtime)}</span></div>
                                <div class="dup-file-path" title="${U.escapeHtml(f.path)}">${U.escapeHtml(f.path)}</div>
                            </div>
                        </div>
                        <div class="path-item-actions">
                            <button class="btn btn-ghost btn-sm" data-smb-dir="${U.escapeHtml(f.parentPath || parentDirPath(f.path))}" title="复制所在文件夹 SMB 路径">SMB</button>
                            <button class="btn btn-ghost btn-sm" data-detail-path="${U.escapeHtml(f.path)}">详情</button>
                            <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del-path="${U.escapeHtml(f.path)}" ${delDisabled}>删除</button>
                        </div>
                    </div>
                `;
            }).join('');

            return `
                <div class="dup-group">
                    <div class="dup-group-head">
                        <div>
                            <strong>单文件 ${U.formatBytes(g.size)}</strong> · ${g.count} 个副本 ·
                            <span style="color:var(--amber);font-weight:700;">可释放 ${U.formatBytes(g.reclaimableBytes)}</span>
                        </div>
                        <span class="dup-hash">SHA256: ${U.escapeHtml(g.hash.slice(0, 16))}...</span>
                    </div>
                    <div class="dup-files">${rowsHtml}</div>
                </div>
            `;
        }).join('');

        box.querySelectorAll('.dup-cb').forEach(cb => {
            cb.onchange = () => {
                if (cb.checked) state.dupSelected.add(cb.dataset.path);
                else state.dupSelected.delete(cb.dataset.path);
                updateBulkBtn('dupBulkDeleteBtn', state.dupSelected);
            };
        });
        box.querySelectorAll('[data-smb-dir]').forEach(btn => {
            btn.onclick = () => copySmbPath(btn.dataset.smbDir);
        });
        box.querySelectorAll('[data-detail-path]').forEach(btn => {
            btn.onclick = () => openFileDetails(btn.dataset.detailPath);
        });
        box.querySelectorAll('[data-del-path]').forEach(btn => {
            btn.onclick = () => confirmAndDelete([btn.dataset.delPath]);
        });
    }

    function autoSelectDuplicateStrategy(keepMode) {
        if (!state.dupReport || !state.dupReport.groups) return;
        state.dupSelected.clear();
        state.dupReport.groups.forEach(g => {
            if (!g.files || g.files.length < 2) return;
            const sorted = g.files.slice().sort((a, b) => a.mtime - b.mtime);
            const keepIndex = keepMode === 'newest' ? sorted.length - 1 : 0;
            sorted.forEach((f, idx) => {
                if (idx !== keepIndex) state.dupSelected.add(f.path);
            });
        });
        renderDuplicates(state.dupReport);
    }

    function renderHistoryTable() {
        const tbody = document.getElementById('historyTableBody');
        if (!tbody) return;
        if (!state.scansList.length) {
            tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:var(--ink-muted);padding:24px;">暂无历史记录</td></tr>';
            return;
        }
        const statusMap = {
            completed: ['已完成', 'badge-ok'],
            partial: ['部分快照', 'badge-warn'],
            running: ['扫描中', 'badge-warn'],
            cancelled: ['已取消', 'badge-neutral'],
            failed: ['失败', 'badge-danger']
        };
        tbody.innerHTML = state.scansList.map(s => {
            const [stLabel, stCls] = statusMap[s.status] || [s.status, 'badge-neutral'];
            const activeMark = s.id === state.currentScanId ? ' <span class="badge badge-ok">当前</span>' : '';
            return `
                <tr>
                    <td>${U.formatTimeMs(s.startedAt)}${activeMark}</td>
                    <td><div class="path-cell" title="${U.escapeHtml(s.rootPath)}">${U.escapeHtml(s.rootPath)}</div></td>
                    <td><span class="badge ${stCls}">${stLabel}</span></td>
                    <td class="col-size"><strong>${U.formatBytes(s.uniqueSize)}</strong></td>
                    <td class="col-num">${U.formatBytes(s.hardlinkSaved)}</td>
                    <td class="col-num">${(s.totalFiles || 0).toLocaleString()} / ${(s.totalFolders || 0).toLocaleString()}</td>
                    <td class="col-act">
                        ${s.hasDetails
                            ? `<button class="btn btn-ghost btn-sm" data-load-scan="${s.id}">加载快照</button>`
                            : `<span style="color:var(--ink-muted);margin-right:6px;">仅摘要</span>`}
                        <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-del-scan="${s.id}">删除</button>
                    </td>
                </tr>
            `;
        }).join('');

        tbody.querySelectorAll('[data-load-scan]').forEach(btn => {
            btn.onclick = async () => {
                const oldText = btn.textContent;
                btn.disabled = true;
                btn.textContent = '加载中...';
                try {
                    await loadScanSnapshot(Number(btn.dataset.loadScan));
                    switchView('overview');
                    U.toast('已切换到选定历史快照', 'ok');
                } catch (err) {
                    U.toast(err.message || '加载快照失败', 'error');
                } finally {
                    btn.disabled = false;
                    btn.textContent = oldText;
                }
            };
        });
        tbody.querySelectorAll('[data-del-scan]').forEach(btn => {
            btn.onclick = async () => {
                const ok = await U.confirmDialog({
                    title: '删除扫描历史',
                    desc: '确定删除该条扫描记录及其明细数据吗？不会影响硬盘上的实际文件。',
                    okText: '删除记录'
                });
                if (!ok) return;
                await API.deleteScan(Number(btn.dataset.delScan));
                U.toast('历史记录已删除', 'ok');
                await refreshScansAndView();
            };
        });
    }

    function renderSettingsRoots() {
        const data = state.rootsData;
        if (!data) return;

        const tipEl = document.getElementById('platformPathTip');
        if (data.platform === 'fnos') {
            tipEl.textContent = '飞牛 fnOS：请在「应用中心 → SpaceMap 存储分析 → 应用设置 → 访问权限」中添加允许访问的文件夹（保存后生效）。';
        } else if (data.platform === 'qnap') {
            tipEl.textContent = '威联通 QNAP：已自动识别 /share 下的共享文件夹，无需繁琐路径映射。';
        } else if (data.platform === 'ugos') {
            tipEl.textContent = '绿联 UGOS Pro：请在「应用中心 → SpaceMap 存储分析 → 应用设置」中添加「扫描文件夹」或勾选允许访问的文件夹（保存后按提示重启应用生效）。';
        } else {
            tipEl.textContent = `当前环境 (${data.platformLabel})：支持自动发现与手动追加合法目录路径。`;
        }

        const sourceLabel = (src) => {
            if (src === 'fnos:accessible') return '系统授权';
            if (src === 'ugos:shared') return '绿联授权目录';
            if (src === 'env:SCAN_PATHS' && data.platform === 'ugos') return '绿联应用配置';
            if (src && src.startsWith('env:')) return '环境变量';
            if (src && src.startsWith('auto:')) return '自动发现';
            return src || '-';
        };

        const discEl = document.getElementById('discoveredRootsList');
        const discovered = data.discovered || [];
        discEl.innerHTML = discovered.length ? discovered.map(r => `
            <div class="path-item">
                <div class="path-item-info">
                    <div class="path-item-name">${U.escapeHtml(r.name)}</div>
                    <div class="path-item-raw">${U.escapeHtml(r.path)}</div>
                </div>
                <div class="path-item-actions">
                    <span class="badge ${r.writable ? 'badge-ok' : 'badge-warn'}">${r.writable ? '可读写' : '只读'}</span>
                    <span class="badge badge-neutral">${U.escapeHtml(sourceLabel(r.source))}</span>
                </div>
            </div>
        `).join('') : '<div class="table-meta">暂无系统授权路径，请在 NAS 应用设置中添加，或在上方手动添加。</div>';

        const savedEl = document.getElementById('savedRootsList');
        const saved = data.saved || [];
        savedEl.innerHTML = saved.length ? saved.map((r, idx) => `
            <div class="path-item">
                <div class="path-item-info">
                    <div class="path-item-name">${U.escapeHtml(r.name)}</div>
                    <div class="path-item-raw">${U.escapeHtml(r.path)}</div>
                </div>
                <div class="path-item-actions">
                    <span class="badge ${r.source === 'unavailable' ? 'badge-danger' : (r.writable ? 'badge-ok' : 'badge-warn')}">
                        ${r.source === 'unavailable' ? '不可访问' : (r.writable ? '可读写' : '只读')}
                    </span>
                    <button class="btn btn-ghost btn-sm" style="color:var(--danger)" data-remove-saved="${idx}">移除</button>
                </div>
            </div>
        `).join('') : '<div class="table-meta">暂无手动保存的路径</div>';

        savedEl.querySelectorAll('[data-remove-saved]').forEach(btn => {
            btn.onclick = async () => {
                const idx = Number(btn.dataset.removeSaved);
                const next = saved.filter((_, i) => i !== idx).map(x => ({ path: x.path, name: x.name }));
                await API.saveFolders(next);
                U.toast('已移除扫描路径', 'ok');
                await loadRoots();
                await refreshScansAndView();
            };
        });
    }

    async function addSavedPath() {
        const input = document.getElementById('newFolderPathInput');
        const raw = input.value.trim();
        if (!raw) {
            U.toast('请输入有效路径', 'error');
            return;
        }
        const existing = ((state.rootsData && state.rootsData.saved) || []).map(x => ({ path: x.path, name: x.name }));
        const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
        parts.forEach(p => {
            if (!existing.some(x => x.path === p)) {
                existing.push({ path: p, name: p.split('/').filter(Boolean).pop() || p });
            }
        });
        try {
            const res = await API.saveFolders(existing);
            input.value = '';
            if (res.rejected && res.rejected.length) {
                U.toast('部分路径被拒绝: ' + res.rejected.join('；'), 'error');
            } else {
                U.toast('扫描路径已保存', 'ok');
            }
            await loadRoots();
            await refreshScansAndView();
        } catch (err) {
            U.toast(err.message, 'error');
        }
    }

    async function loadSchedule() {
        try {
            const sc = await API.getSchedule();
            document.getElementById('schedEnabled').checked = !!sc.enabled;
            document.getElementById('schedMode').value = sc.mode || 'daily';
            document.getElementById('schedHour').value = sc.hour ?? 3;
            document.getElementById('schedMinute').value = sc.minute ?? 0;
            document.getElementById('schedWeekday').value = sc.weekday ?? 0;
            document.getElementById('schedIntervalHours').value = sc.intervalHours ?? 24;
            document.getElementById('schedLastRunText').textContent = sc.lastRunAt
                ? `上次自动扫描：${U.formatTimeMs(sc.lastRunAt)}（状态：${sc.lastStatus || '-'}）`
                : '尚未执行过定时扫描';
            updateScheduleVisibility();
        } catch (_) {}
    }

    function updateScheduleVisibility() {
        const mode = document.getElementById('schedMode').value;
        document.getElementById('schedWeekdayWrap').classList.toggle('hidden', mode !== 'weekly');
        document.getElementById('schedTimeWrap').classList.toggle('hidden', mode === 'interval');
        document.getElementById('schedIntervalWrap').classList.toggle('hidden', mode !== 'interval');
    }

    let updatePollTimer = null;

    async function loadUpdateStatus(syncForm = true) {
        const res = await API.getUpdateStatus();
        renderUpdatePanel(res, syncForm);
        return res;
    }

    function renderUpdatePanel(res, syncForm = true) {
        if (!res) return;
        const cfg = res.config || {};
        const st = res.status || {};

        if (syncForm) {
            const autoEl = document.getElementById('updAutoCheck');
            const repoEl = document.getElementById('updRepoInput');
            const proxyEl = document.getElementById('updProxyInput');
            if (autoEl) autoEl.checked = cfg.autoCheck !== false;
            if (repoEl) repoEl.value = cfg.repo || 'Danborad/spacemap';
            if (proxyEl) proxyEl.value = cfg.proxyPrefix || '';
        }

        const badge = document.getElementById('updateStateBadge');
        const navDot = document.getElementById('navUpdateDot');
        const curEl = document.getElementById('updateCurVerText');
        const latestEl = document.getElementById('updateLatestVerText');
        const envEl = document.getElementById('updateEnvText');
        const tipEl = document.getElementById('updateTipText');
        const notesEl = document.getElementById('updateNotesBox');
        const progWrap = document.getElementById('updateProgressWrap');
        const progBar = document.getElementById('updateProgressBar');
        const progText = document.getElementById('updateProgressText');
        const applyBtn = document.getElementById('applyUpdateBtn');
        const checkBtn = document.getElementById('checkUpdateBtn');
        const linkBtn = document.getElementById('releaseLinkBtn');

        if (!badge) return;

        curEl.textContent = st.currentVersion ? `v${st.currentVersion}` : '-';
        if (st.latestVersion) {
            latestEl.textContent = `v${st.latestVersion}`;
        } else if (st.state === 'up_to_date') {
            latestEl.textContent = '暂无线上 Release';
        } else if (st.state === 'error') {
            latestEl.textContent = '获取失败';
        } else {
            latestEl.textContent = '待检查';
        }
        envEl.textContent = `${st.platformLabel || st.platform || '-'} / linux-${st.arch || '-'}`;
        tipEl.textContent = st.message || st.selfUpdateTip || '';

        const repoLinkEl = document.getElementById('updateRepoLink');
        if (repoLinkEl) {
            const fallbackRepoUrl = cfg.repo && !/^https?:\/\//i.test(cfg.repo)
                ? `https://github.com/${cfg.repo.replace(/^\/+|\/+$/g, '')}`
                : (cfg.repo || 'https://github.com/Danborad/spacemap');
            const repoUrl = st.repoUrl || fallbackRepoUrl;
            repoLinkEl.href = repoUrl;
            repoLinkEl.textContent = repoUrl;
        }

        const stateLabels = {
            idle: ['待检查', 'badge-neutral'],
            checking: ['检查中...', 'badge-warn'],
            available: ['有新版本', 'badge-warn'],
            up_to_date: ['已是最新', 'badge-ok'],
            downloading: ['下载中', 'badge-warn'],
            verifying: ['校验中', 'badge-warn'],
            restarting: ['重启中', 'badge-warn'],
            error: ['检查/更新异常', 'badge-danger']
        };
        const [stText, stCls] = stateLabels[st.state] || [st.state || '未知', 'badge-neutral'];
        badge.className = `badge ${stCls}`;
        badge.textContent = stText;

        if (navDot) {
            navDot.classList.toggle('hidden', !st.hasUpdate);
        }

        if (st.releaseNotes && st.releaseNotes.trim()) {
            notesEl.textContent = st.releaseNotes.trim();
            notesEl.classList.remove('hidden');
        } else {
            notesEl.classList.add('hidden');
        }

        if (st.releaseUrl) {
            linkBtn.href = st.releaseUrl;
            linkBtn.classList.remove('hidden');
        } else {
            linkBtn.classList.add('hidden');
        }

        const inProgress = st.state === 'downloading' || st.state === 'verifying' || st.state === 'restarting';
        checkBtn.disabled = inProgress || st.state === 'checking';

        if (inProgress) {
            progWrap.classList.remove('hidden');
            progBar.style.width = `${st.progressPct || 0}%`;
            const dlInfo = st.totalBytes > 0
                ? `${U.formatBytes(st.downloaded || 0)} / ${U.formatBytes(st.totalBytes)} (${st.progressPct || 0}%)`
                : `${U.formatBytes(st.downloaded || 0)}`;
            progText.textContent = `${st.message || stText} · ${dlInfo}`;
        } else {
            progWrap.classList.add('hidden');
        }

        const canApply = !!(st.hasUpdate && st.canSelfUpdate && st.downloadUrl);
        applyBtn.classList.toggle('hidden', !st.hasUpdate);
        applyBtn.disabled = inProgress || !canApply;
        if (!st.canSelfUpdate && st.hasUpdate) {
            applyBtn.title = st.selfUpdateTip || '当前环境不支持直接替换二进制';
            applyBtn.textContent = st.platform === 'docker' ? '请更新 Docker 镜像' : '请手动覆盖安装';
        } else if (!st.downloadUrl && st.hasUpdate) {
            applyBtn.title = `未找到 ${st.assetName || ''} 资产`;
            applyBtn.textContent = '暂无匹配安装包';
        } else {
            applyBtn.title = '';
            applyBtn.textContent = inProgress ? '正在更新...' : `一键更新至 v${st.latestVersion || ''}`;
        }
    }

    async function triggerCheckUpdate() {
        const btn = document.getElementById('checkUpdateBtn');
        btn.disabled = true;
        btn.textContent = '检查中...';
        try {
            const res = await API.checkUpdate();
            renderUpdatePanel(res, false);
            const st = res.status || {};
            if (st.hasUpdate) {
                U.toast(`发现新版本 v${st.latestVersion}`, 'ok');
            } else {
                U.toast(`当前已是最新版本 v${st.currentVersion}`, 'info');
            }
        } catch (err) {
            await loadUpdateStatus(false).catch(() => {});
            U.toast('检查更新失败: ' + err.message, 'error');
        } finally {
            btn.disabled = false;
            btn.textContent = '检查更新';
        }
    }

    async function triggerApplyUpdate() {
        const curRes = await loadUpdateStatus(false).catch(() => null);
        const st = curRes && curRes.status ? curRes.status : {};
        const ok = await U.confirmDialog({
            title: `升级到 SpaceMap v${st.latestVersion || ''}`,
            desc: '将下载对应架构二进制并校验 SHA-256，校验通过后自动热重启服务（约 2~5 秒，原存储空间权限与扫描数据完整保留）。确定立即更新吗？',
            okText: '立即更新并重启'
        });
        if (!ok) return;

        try {
            const res = await API.applyUpdate();
            renderUpdatePanel({ config: curRes?.config, status: res.status }, false);
            startUpdateProgressPolling(st.latestVersion || '');
        } catch (err) {
            U.toast('启动更新失败: ' + err.message, 'error');
        }
    }

    function startUpdateProgressPolling(targetVer) {
        if (updatePollTimer) clearInterval(updatePollTimer);
        let sawRestarting = false;
        let rounds = 0;

        updatePollTimer = setInterval(async () => {
            rounds++;
            if (rounds > 180) {
                clearInterval(updatePollTimer);
                updatePollTimer = null;
                U.toast('等待服务恢复超时，请手动刷新页面', 'error');
                return;
            }
            try {
                if (sawRestarting) {
                    const env = await API.env();
                    if (env && env.version) {
                        clearInterval(updatePollTimer);
                        updatePollTimer = null;
                        U.toast(`已成功更新至 v${env.version}，即将刷新页面...`, 'ok');
                        setTimeout(() => window.location.reload(), 600);
                    }
                    return;
                }

                const res = await API.getUpdateStatus();
                renderUpdatePanel(res, false);
                const st = res.status || {};
                if (st.state === 'restarting') {
                    sawRestarting = true;
                } else if (st.state === 'error') {
                    clearInterval(updatePollTimer);
                    updatePollTimer = null;
                    U.toast('更新失败: ' + (st.message || '未知错误'), 'error');
                }
            } catch (_) {
                // 服务重启期间端口短暂关闭，继续探测 /api/env
                sawRestarting = true;
                try {
                    const env = await API.env();
                    if (env && (!targetVer || env.version === targetVer)) {
                        clearInterval(updatePollTimer);
                        updatePollTimer = null;
                        U.toast(`已成功更新至 v${env.version}，即将刷新页面...`, 'ok');
                        setTimeout(() => window.location.reload(), 600);
                    }
                } catch (_) {}
            }
        }, 700);
    }

    async function openFileDetails(filePath) {
        try {
            const d = await API.fileDetails(filePath);
            const dirPath = parentDirPath(d.path);
            const dirSmb = buildSmbPaths(dirPath);
            const fileSmb = buildSmbPaths(d.path);
            const body = document.getElementById('detailModalBody');
            body.innerHTML = `
                <div class="detail-row"><div class="detail-label">文件名</div><div class="detail-val"><strong>${U.escapeHtml(d.name)}</strong></div></div>
                <div class="detail-row"><div class="detail-label">完整路径</div><div class="detail-val">${U.escapeHtml(d.path)} <button class="btn btn-ghost btn-sm" data-copy-val="${U.escapeHtml(d.path)}">复制</button></div></div>
                ${dirSmb ? `<div class="detail-row"><div class="detail-label">目录 SMB</div><div class="detail-val">${U.escapeHtml(dirSmb.preferred)} <button class="btn btn-ghost btn-sm" data-copy-val="${U.escapeHtml(dirSmb.preferred)}">复制文件夹</button></div></div>` : ''}
                ${fileSmb ? `<div class="detail-row"><div class="detail-label">Win SMB</div><div class="detail-val">${U.escapeHtml(fileSmb.win)} <button class="btn btn-ghost btn-sm" data-copy-val="${U.escapeHtml(fileSmb.win)}">复制</button></div></div>` : ''}
                ${fileSmb ? `<div class="detail-row"><div class="detail-label">Mac SMB</div><div class="detail-val">${U.escapeHtml(fileSmb.mac)} <button class="btn btn-ghost btn-sm" data-copy-val="${U.escapeHtml(fileSmb.mac)}">复制</button></div></div>` : ''}
                <div class="detail-row"><div class="detail-label">文件大小</div><div class="detail-val">${U.formatBytes(d.size)} (${d.size.toLocaleString()} B)</div></div>
                <div class="detail-row"><div class="detail-label">文件类型</div><div class="detail-val">${U.escapeHtml(U.typeLabel(d.type))} (${U.escapeHtml(d.ext || '-')})</div></div>
                <div class="detail-row"><div class="detail-label">MIME 类型</div><div class="detail-val">${U.escapeHtml(d.mimeType)}</div></div>
                <div class="detail-row"><div class="detail-label">修改时间</div><div class="detail-val">${U.formatTimeSec(d.modified)}</div></div>
                <div class="detail-row"><div class="detail-label">权限状态</div><div class="detail-val">${d.writable ? '可读写' : '只读 / 无写权限'}</div></div>
            `;
            body.querySelectorAll('[data-copy-val]').forEach(btn => {
                btn.onclick = async () => {
                    const val = btn.dataset.copyVal;
                    const ok = await U.copyText(val);
                    U.toast(ok ? `已复制：${val}` : `复制失败：${val}`, ok ? 'ok' : 'error');
                };
            });
            document.getElementById('detailModal').classList.remove('hidden');
        } catch (err) {
            U.toast('获取详情失败: ' + err.message, 'error');
        }
    }

    async function confirmAndDelete(paths) {
        if (!paths || !paths.length) return;
        if (!state.writable) {
            U.toast('当前扫描路径为只读挂载或无写入权限，无法删除文件', 'error');
            return;
        }
        const ok = await U.confirmDialog({
            title: `永久删除 ${paths.length} 个文件`,
            desc: '文件将直接从 NAS 硬盘上物理移除，无法进入回收站恢复，请再次核对下方文件清单：',
            items: paths,
            okText: `确认永久删除 (${paths.length})`
        });
        if (!ok) return;

        try {
            const res = await API.deleteFiles(paths);
            const okCount = (res.deleted || []).length;
            const failCount = (res.failed || []).length;
            if (okCount > 0) {
                U.toast(`成功删除 ${okCount} 个文件` + (failCount ? `，失败 ${failCount} 个` : ''), failCount ? 'info' : 'ok');
                (res.deleted || []).forEach(p => {
                    state.inspectorSelected.delete(p);
                    state.largeSelected.delete(p);
                    state.dupSelected.delete(p);
                    state.coldSelected.delete(p);
                });
                if (state.currentScanId) {
                    await loadScanSnapshot(state.currentScanId);
                }
            } else {
                const reason = res.failed && res.failed[0] ? res.failed[0].error : '未知错误';
                U.toast('删除失败: ' + reason, 'error');
            }
        } catch (err) {
            U.toast('删除请求失败: ' + err.message, 'error');
        }
    }

    function updateBulkBtn(btnId, set) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        const n = set.size;
        btn.classList.toggle('hidden', n === 0 || !state.writable);
        btn.textContent = `删除选中 (${n})`;
    }

    function connectSSE() {
        if (state.eventSource) {
            state.eventSource.close();
        }
        const es = new EventSource('/api/scan/events');
        state.eventSource = es;
        es.addEventListener('progress', ev => {
            try {
                handleProgressSnapshot(JSON.parse(ev.data));
            } catch (_) {}
        });
    }

    function handleProgressSnapshot(snap) {
        const banner = document.getElementById('scanProgressBanner');
        const scanBtn = document.getElementById('scanNowBtn');

        if (snap && snap.running) {
            state.wasScanning = true;
            banner.classList.remove('hidden');
            scanBtn.disabled = true;
            document.getElementById('scanProgRoot').textContent = snap.rootPath || '';
            document.getElementById('scanProgStats').textContent =
                `已扫描 ${snap.scannedFiles.toLocaleString()} 文件 · ${snap.scannedFolders.toLocaleString()} 目录 · ${U.formatBytes(snap.uniqueSize)} · ${U.formatDuration(snap.elapsedMs)}`;
            document.getElementById('scanProgPath').textContent = snap.currentPath || '';
        } else {
            banner.classList.add('hidden');
            scanBtn.disabled = false;
            if (state.wasScanning && snap && snap.scanId) {
                state.wasScanning = false;
                if (snap.status === 'completed') {
                    U.toast(`扫描完成：共 ${snap.scannedFiles.toLocaleString()} 文件，实际占用 ${U.formatBytes(snap.uniqueSize)}`, 'ok');
                    refreshScansAndView();
                } else if (snap.status === 'partial') {
                    U.toast(`已取消扫描并保留部分快照：共 ${snap.scannedFiles.toLocaleString()} 文件，已统计 ${U.formatBytes(snap.uniqueSize)}`, 'ok');
                    refreshScansAndView();
                } else if (snap.status === 'cancelled') {
                    U.toast('扫描已取消，已丢弃未完成数据', 'info');
                } else if (snap.status === 'failed') {
                    U.toast('扫描失败: ' + (snap.message || '未知错误'), 'error');
                }
            }
        }
    }

    async function startScanNow() {
        if (!state.selectedRootPath) {
            U.toast('请先选择或添加扫描路径', 'error');
            switchView('settings');
            return;
        }
        try {
            await API.startScan(state.selectedRootPath);
            U.toast('已启动后台扫描任务', 'info');
        } catch (err) {
            U.toast(err.message, 'error');
        }
    }

    function switchView(name) {
        state.view = name;
        document.querySelectorAll('.top-nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === name));
        document.querySelectorAll('.view-panel').forEach(p => p.classList.toggle('active', p.id === `view-${name}`));

        if (!state.currentScanId) {
            toggleEmptyState(true);
        } else {
            document.getElementById('emptyStateHero').classList.add('hidden');
            document.querySelector('.view-container').classList.remove('hidden');
        }
        updatePageHeader();
        setTimeout(() => Charts.resizeAll(), 40);

        if (state.currentScanId) {
            if (name === 'largeFiles' && state.loadedLargeScanId !== state.currentScanId) {
                loadLargeFiles(1).catch(() => {});
            } else if (name === 'coldFiles' && state.loadedColdScanId !== state.currentScanId) {
                loadColdFiles(1).catch(() => {});
            }
        }
    }

    function bindGlobalEvents() {
        document.querySelectorAll('.top-nav-btn').forEach(btn => {
            btn.onclick = () => switchView(btn.dataset.view);
        });
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.onclick = () => applyTheme(btn.dataset.themeChoice);
        });

        document.getElementById('rootSelect').onchange = async (e) => {
            state.selectedRootPath = e.target.value;
            localStorage.setItem('spacemap_selected_root', state.selectedRootPath);
            updateWritableBadge();
            await refreshScansAndView();
        };
        document.getElementById('refreshRootsBtn').onclick = () => syncRootsOnFocus(true);
        window.addEventListener('focus', () => syncRootsOnFocus(false));
        document.getElementById('scanNowBtn').onclick = startScanNow;
        document.getElementById('heroStartScanBtn').onclick = startScanNow;
        document.getElementById('heroGoSettingsBtn').onclick = () => switchView('settings');
        document.getElementById('cancelScanBtn').onclick = () => {
            const modal = document.getElementById('cancelScanModal');
            const stats = document.getElementById('scanProgStats')?.textContent || '';
            document.getElementById('cancelScanModalDesc').textContent =
                `当前进度：${stats}。您可以选择保留已扫描到的目录与文件数据作为部分快照立即查看，或直接丢弃未完成数据。`;
            modal.classList.remove('hidden');
        };
        const submitCancelScan = async (keepPartial) => {
            document.getElementById('cancelScanModal').classList.add('hidden');
            const btn = document.getElementById('cancelScanBtn');
            const oldText = btn.textContent;
            btn.disabled = true;
            btn.textContent = keepPartial ? '正在保存...' : '正在取消...';
            try {
                await API.cancelScan(keepPartial);
            } catch (err) {
                U.toast(err.message || '取消失败', 'error');
            } finally {
                btn.disabled = false;
                btn.textContent = oldText;
            }
        };
        document.getElementById('cancelScanContinueBtn').onclick = () => {
            document.getElementById('cancelScanModal').classList.add('hidden');
        };
        document.getElementById('cancelScanDiscardBtn').onclick = () => submitCancelScan(false);
        document.getElementById('cancelScanKeepBtn').onclick = () => submitCancelScan(true);

        document.getElementById('exportCsvBtn').onclick = () => {
            if (!state.currentScanId) return U.toast('请先执行扫描', 'info');
            window.location.href = `/api/scans/${state.currentScanId}/export?format=csv`;
        };
        document.getElementById('exportJsonBtn').onclick = () => {
            if (!state.currentScanId) return U.toast('请先执行扫描', 'info');
            window.location.href = `/api/scans/${state.currentScanId}/export?format=json`;
        };

        // 树图 / 排行 & 面包屑
        document.getElementById('explorerUpBtn').onclick = navigateUpExplorer;
        document.getElementById('overviewChartMode').querySelectorAll('.seg-btn').forEach(btn => {
            btn.onclick = () => {
                state.chartMode = btn.dataset.mode;
                document.getElementById('overviewChartMode').querySelectorAll('.seg-btn').forEach(b => b.classList.toggle('active', b === btn));
                renderExplorerChart();
            };
        });
        document.getElementById('explorerTopLimit').onchange = (e) => {
            state.topLimit = Number(e.target.value) || 20;
            renderExplorerChart();
        };

        document.getElementById('inspectorSelectAll').onchange = (e) => {
            document.querySelectorAll('#inspectorList .ins-cb').forEach(cb => {
                cb.checked = e.target.checked;
                if (e.target.checked) state.inspectorSelected.add(cb.dataset.path);
                else state.inspectorSelected.delete(cb.dataset.path);
            });
            updateBulkBtn('inspectorBulkDeleteBtn', state.inspectorSelected);
        };
        document.getElementById('inspectorBulkDeleteBtn').onclick = () => confirmAndDelete(Array.from(state.inspectorSelected));

        // 大文件
        document.getElementById('fileFilterBtn').onclick = () => loadLargeFiles(1);
        document.getElementById('fileSearchInput').onkeydown = (e) => { if (e.key === 'Enter') loadLargeFiles(1); };
        document.getElementById('fileTypeSelect').onchange = () => loadLargeFiles(1);
        document.getElementById('fileMinSizeSelect').onchange = () => loadLargeFiles(1);
        document.getElementById('fileSortSelect').onchange = () => loadLargeFiles(1);
        document.getElementById('largeSelectAll').onchange = (e) => {
            document.querySelectorAll('#largeFilesBody .row-cb').forEach(cb => {
                cb.checked = e.target.checked;
                if (e.target.checked) state.largeSelected.add(cb.dataset.path);
                else state.largeSelected.delete(cb.dataset.path);
            });
            updateBulkBtn('largeBulkDeleteBtn', state.largeSelected);
        };
        document.getElementById('largeBulkDeleteBtn').onclick = () => confirmAndDelete(Array.from(state.largeSelected));

        // 重复文件
        document.getElementById('runDupCheckBtn').onclick = runDuplicateCheck;
        document.getElementById('dupSelectKeepNewestBtn').onclick = () => autoSelectDuplicateStrategy('newest');
        document.getElementById('dupSelectKeepOldestBtn').onclick = () => autoSelectDuplicateStrategy('oldest');
        document.getElementById('dupBulkDeleteBtn').onclick = () => confirmAndDelete(Array.from(state.dupSelected));

        // 冷数据
        document.getElementById('coldRefreshBtn').onclick = () => loadColdFiles(1);
        document.getElementById('coldDaysSelect').onchange = () => loadColdFiles(1);
        document.getElementById('coldMinSizeSelect').onchange = () => loadColdFiles(1);
        document.getElementById('coldSelectAll').onchange = (e) => {
            document.querySelectorAll('#coldFilesBody .row-cb').forEach(cb => {
                cb.checked = e.target.checked;
                if (e.target.checked) state.coldSelected.add(cb.dataset.path);
                else state.coldSelected.delete(cb.dataset.path);
            });
            updateBulkBtn('coldBulkDeleteBtn', state.coldSelected);
        };
        document.getElementById('coldBulkDeleteBtn').onclick = () => confirmAndDelete(Array.from(state.coldSelected));

        // 设置页
        document.getElementById('addFolderPathBtn').onclick = addSavedPath;
        document.getElementById('schedMode').onchange = updateScheduleVisibility;
        document.getElementById('scheduleForm').onsubmit = async (e) => {
            e.preventDefault();
            try {
                await API.saveSchedule({
                    enabled: document.getElementById('schedEnabled').checked,
                    mode: document.getElementById('schedMode').value,
                    hour: Number(document.getElementById('schedHour').value),
                    minute: Number(document.getElementById('schedMinute').value),
                    weekday: Number(document.getElementById('schedWeekday').value),
                    intervalHours: Number(document.getElementById('schedIntervalHours').value),
                    paths: []
                });
                U.toast('定时扫描计划已保存', 'ok');
                await loadSchedule();
            } catch (err) {
                U.toast('保存失败: ' + err.message, 'error');
            }
        };

        document.getElementById('loginForm').onsubmit = async (e) => {
            e.preventDefault();
            const pwd = document.getElementById('loginPasswordInput').value;
            try {
                await API.login(pwd);
                document.getElementById('loginModal').classList.add('hidden');
                document.getElementById('loginPasswordInput').value = '';
                await bootAppData();
            } catch (err) {
                U.toast(err.message || '密码错误', 'error');
            }
        };

        document.getElementById('passwordForm').onsubmit = async (e) => {
            e.preventDefault();
            const oldPwd = document.getElementById('oldPwdInput').value;
            const newPwd = document.getElementById('newPwdInput').value;
            const confirmPwd = document.getElementById('confirmPwdInput').value;
            if (newPwd !== confirmPwd) {
                U.toast('两次输入的新密码不一致', 'error');
                return;
            }
            try {
                const res = await API.updatePassword(oldPwd, newPwd);
                document.getElementById('oldPwdInput').value = '';
                document.getElementById('newPwdInput').value = '';
                document.getElementById('confirmPwdInput').value = '';
                document.getElementById('logoutBtn').classList.toggle('hidden', !res.hasPassword);
                U.toast(res.hasPassword ? '访问密码已更新' : '访问密码保护已关闭', 'ok');
            } catch (err) {
                U.toast(err.message, 'error');
            }
        };

        document.getElementById('logoutBtn').onclick = async () => {
            await API.logout();
            showLoginModal();
        };

        document.getElementById('appVersionBadge').onclick = () => switchView('settings');
        document.getElementById('checkUpdateBtn').onclick = () => triggerCheckUpdate();
        document.getElementById('applyUpdateBtn').onclick = () => triggerApplyUpdate();
        document.getElementById('updateConfigForm').onsubmit = async (e) => {
            e.preventDefault();
            try {
                const res = await API.saveUpdateConfig({
                    autoCheck: document.getElementById('updAutoCheck').checked,
                    repo: document.getElementById('updRepoInput').value.trim(),
                    proxyPrefix: document.getElementById('updProxyInput').value.trim()
                });
                renderUpdatePanel(res);
                U.toast('更新设置已保存', 'ok');
            } catch (err) {
                U.toast('保存更新设置失败: ' + err.message, 'error');
            }
        };

        document.querySelectorAll('[data-close-modal]').forEach(el => {
            el.onclick = () => document.getElementById(el.dataset.closeModal).classList.add('hidden');
        });

        window.addEventListener('resize', () => Charts.resizeAll());
    }
})();
