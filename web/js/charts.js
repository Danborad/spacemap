window.SpaceCharts = (function() {
    const U = window.SpaceUtils;
    const instances = {};

    function getThemeColors() {
        const dark = document.documentElement.getAttribute('data-theme') !== 'light';
        return {
            dark,
            text: dark ? '#f4f4f5' : '#09090b',
            sub: dark ? '#a1a1aa' : '#52525b',
            muted: dark ? '#71717a' : '#71717a',
            grid: dark ? '#25262e' : '#e4e4e7',
            tooltipBg: dark ? '#17171d' : '#ffffff',
            tooltipBorder: dark ? '#393a46' : '#cbd5e1',
            accent: dark ? '#3b82f6' : '#2563eb',
            teal: dark ? '#2dd4bf' : '#0d9488'
        };
    }

    function getTonePalette(dark) {
        if (dark) {
            return [
                { bg: 'rgba(59, 130, 246, 0.16)', border: 'rgba(59, 130, 246, 0.45)', accent: '#60a5fa' },
                { bg: 'rgba(45, 212, 191, 0.14)', border: 'rgba(45, 212, 191, 0.40)', accent: '#2dd4bf' },
                { bg: 'rgba(129, 140, 248, 0.15)', border: 'rgba(129, 140, 248, 0.40)', accent: '#a5b4fc' },
                { bg: 'rgba(251, 191, 36, 0.13)', border: 'rgba(251, 191, 36, 0.38)', accent: '#fbbf24' },
                { bg: 'rgba(148, 163, 184, 0.12)', border: 'rgba(148, 163, 184, 0.30)', accent: '#94a3b8' }
            ];
        }
        return [
            { bg: 'rgba(37, 99, 235, 0.10)', border: 'rgba(37, 99, 235, 0.35)', accent: '#2563eb' },
            { bg: 'rgba(13, 148, 136, 0.10)', border: 'rgba(13, 148, 136, 0.32)', accent: '#0d9488' },
            { bg: 'rgba(99, 102, 241, 0.10)', border: 'rgba(99, 102, 241, 0.32)', accent: '#6366f1' },
            { bg: 'rgba(217, 119, 6, 0.10)', border: 'rgba(217, 119, 6, 0.32)', accent: '#d97706' },
            { bg: 'rgba(100, 116, 139, 0.08)', border: 'rgba(100, 116, 139, 0.25)', accent: '#64748b' }
        ];
    }

    function ensureChart(domId) {
        const el = document.getElementById(domId);
        if (!el || typeof echarts === 'undefined') return null;
        if (!instances[domId]) {
            instances[domId] = echarts.init(el);
        }
        return instances[domId];
    }

    function resizeAll() {
        Object.values(instances).forEach(ch => {
            try { ch.resize(); } catch (_) {}
        });
    }

    function renderFolderChart(domId, items, mode, activePath, onSelectItem, onDrillItem) {
        const chart = ensureChart(domId);
        if (!chart) return;
        const theme = getThemeColors();
        const tones = getTonePalette(theme.dark);
        const list = (items || []).filter(it => (it.size || 0) >= 0);

        chart.off('click');
        chart.off('dblclick');

        if (!list.length) {
            chart.setOption({
                title: {
                    text: '当前目录为空',
                    left: 'center',
                    top: 'middle',
                    textStyle: { color: theme.muted, fontSize: 13, fontWeight: 'normal' }
                },
                xAxis: { show: false },
                yAxis: { show: false },
                series: []
            }, true);
            return;
        }

        const totalSum = list.reduce((s, x) => s + (x.size || 0), 0) || 1;

        if (mode === 'treemap') {
            chart.setOption({
                tooltip: {
                    backgroundColor: theme.tooltipBg,
                    borderColor: theme.tooltipBorder,
                    textStyle: { color: theme.text, fontSize: 12 },
                    formatter: params => {
                        const d = params.data || {};
                        const kind = d.kind === 'folder' ? '目录（双击可进入）' : '文件';
                        const pct = (((d.rawSize || 0) / totalSum) * 100).toFixed(1);
                        return `<strong>${U.escapeHtml(d.name)}</strong><br/>${kind}<br/>占用：${U.formatBytes(d.rawSize)} (${pct}%)`;
                    }
                },
                series: [{
                    type: 'treemap',
                    left: 0,
                    right: 0,
                    top: 0,
                    bottom: 0,
                    roam: false,
                    nodeClick: false,
                    breadcrumb: { show: false },
                    label: {
                        show: true,
                        position: 'insideTopLeft',
                        padding: [10, 12],
                        formatter: params => {
                            const d = params.data || {};
                            const pct = (((d.rawSize || 0) / totalSum) * 100).toFixed(1);
                            const prefix = d.kind === 'folder' ? '/' : '';
                            return `{name|${prefix}${d.name}}  {pct|${pct}%}\n{size|${U.formatBytes(d.rawSize)}}`;
                        },
                        rich: {
                            name: { color: theme.text, fontSize: 12, fontWeight: 700, lineHeight: 20 },
                            pct: { color: theme.sub, fontSize: 11, fontFamily: 'ui-monospace, monospace' },
                            size: { color: theme.text, fontSize: 16, fontWeight: 800, fontFamily: 'ui-monospace, monospace', lineHeight: 28 }
                        }
                    },
                    upperLabel: { show: false },
                    itemStyle: {
                        gapWidth: 6,
                        borderRadius: 10
                    },
                    data: list.map((it, idx) => {
                        const t = tones[idx % tones.length];
                        const isSelected = activePath && it.path === activePath;
                        return {
                            name: it.name,
                            value: Math.max(it.size || 0, 1),
                            rawSize: it.size || 0,
                            path: it.path,
                            kind: it.kind,
                            itemStyle: {
                                color: t.bg,
                                borderColor: isSelected ? theme.accent : t.border,
                                borderWidth: isSelected ? 2 : 1,
                                borderRadius: 10
                            }
                        };
                    })
                }]
            }, true);
        } else {
            const reversed = list.slice().reverse();
            chart.setOption({
                tooltip: {
                    trigger: 'axis',
                    axisPointer: { type: 'shadow' },
                    backgroundColor: theme.tooltipBg,
                    borderColor: theme.tooltipBorder,
                    textStyle: { color: theme.text, fontSize: 12 },
                    formatter: params => {
                        const p = params && params[0];
                        if (!p) return '';
                        const d = p.data || {};
                        const pct = (((d.value || 0) / totalSum) * 100).toFixed(1);
                        return `<strong>${U.escapeHtml(d.fullName || p.name)}</strong><br/>占用：${U.formatBytes(d.value)} (${pct}%)`;
                    }
                },
                grid: { left: 10, right: 26, top: 8, bottom: 16, containLabel: true },
                xAxis: {
                    type: 'value',
                    splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
                    axisLabel: { color: theme.muted, fontSize: 11, formatter: val => U.formatBytes(val) }
                },
                yAxis: {
                    type: 'category',
                    data: reversed.map(it => {
                        const prefix = it.kind === 'folder' ? '/' : '';
                        const shortName = it.name.length > 22 ? it.name.slice(0, 22) + '...' : it.name;
                        return prefix + shortName;
                    }),
                    axisLine: { lineStyle: { color: theme.grid } },
                    axisLabel: { color: theme.text, fontSize: 12, fontFamily: 'ui-monospace, monospace' }
                },
                series: [{
                    type: 'bar',
                    barMaxWidth: 20,
                    data: reversed.map((it, idx) => {
                        const tone = tones[(reversed.length - 1 - idx) % tones.length];
                        const isSelected = activePath && it.path === activePath;
                        return {
                            value: it.size || 0,
                            fullName: it.name,
                            path: it.path,
                            kind: it.kind,
                            itemStyle: {
                                color: isSelected ? theme.accent : tone.accent,
                                borderRadius: [0, 5, 5, 0]
                            }
                        };
                    })
                }]
            }, true);
        }

        let clickTimer = null;
        let lastClickPath = null;
        let lastClickTime = 0;

        function handleItemClick(data) {
            if (!data || !data.path) return;
            const now = Date.now();
            const timeDiff = now - lastClickTime;
            const isSameTarget = lastClickPath === data.path;

            // 1. 若在 380ms 内连续点击同一个目录，或已连续点击同一个目标，立即触发双击下钻
            if (isSameTarget && timeDiff < 380) {
                if (clickTimer) {
                    clearTimeout(clickTimer);
                    clickTimer = null;
                }
                lastClickTime = 0;
                lastClickPath = null;
                if (typeof onDrillItem === 'function') {
                    onDrillItem(data);
                }
                return;
            }

            // 2. 记录本次点击目标与时间
            lastClickTime = now;
            lastClickPath = data.path;

            // 3. 延时 220ms 触发单击选中（留出双击识别窗口，避免单击立刻重绘图表打断双击手势）
            if (clickTimer) {
                clearTimeout(clickTimer);
            }
            clickTimer = setTimeout(() => {
                clickTimer = null;
                if (typeof onSelectItem === 'function') {
                    onSelectItem(data);
                }
            }, 220);
        }

        chart.on('click', params => {
            if (params && params.data) {
                handleItemClick(params.data);
            }
        });
        chart.on('dblclick', params => {
            if (clickTimer) {
                clearTimeout(clickTimer);
                clickTimer = null;
            }
            lastClickTime = 0;
            lastClickPath = null;
            if (params && params.data && typeof onDrillItem === 'function') {
                onDrillItem(params.data);
            }
        });
    }

    function renderTrendChart(domId, scans) {
        const chart = ensureChart(domId);
        if (!chart) return;
        const theme = getThemeColors();

        const completed = (scans || [])
            .filter(s => s.status === 'completed')
            .slice()
            .sort((a, b) => a.startedAt - b.startedAt);

        if (!completed.length) {
            chart.setOption({
                title: {
                    text: '暂无已完成的历史趋势数据',
                    left: 'center',
                    top: 'middle',
                    textStyle: { color: theme.muted, fontSize: 13, fontWeight: 'normal' }
                },
                xAxis: { show: false },
                yAxis: { show: false },
                series: []
            }, true);
            return;
        }

        const xLabels = completed.map(s =>
            new Date(s.startedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
        );

        chart.setOption({
            tooltip: {
                trigger: 'axis',
                backgroundColor: theme.tooltipBg,
                borderColor: theme.tooltipBorder,
                textStyle: { color: theme.text, fontSize: 12 },
                formatter: params => {
                    const p = params && params[0];
                    if (!p) return '';
                    const rec = completed[p.dataIndex];
                    return `<strong>${p.axisValue}</strong><br/>实际占用：${U.formatBytes(rec.uniqueSize)}<br/>硬链接省：${U.formatBytes(rec.hardlinkSaved)}<br/>文件数：${rec.totalFiles.toLocaleString()}`;
                }
            },
            grid: { left: 14, right: 20, top: 20, bottom: 20, containLabel: true },
            xAxis: {
                type: 'category',
                boundaryGap: false,
                data: xLabels,
                axisLine: { lineStyle: { color: theme.grid } },
                axisLabel: { color: theme.muted, fontSize: 11 }
            },
            yAxis: {
                type: 'value',
                splitLine: { lineStyle: { color: theme.grid, type: 'dashed' } },
                axisLabel: { color: theme.muted, formatter: val => U.formatBytes(val) }
            },
            series: [{
                name: '实际占用',
                type: 'line',
                smooth: true,
                symbol: 'circle',
                symbolSize: 7,
                data: completed.map(s => s.uniqueSize),
                lineStyle: {
                    width: 3,
                    color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                        { offset: 0, color: theme.accent },
                        { offset: 1, color: theme.teal }
                    ])
                },
                itemStyle: { color: theme.teal },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: 'rgba(59, 130, 246, 0.25)' },
                        { offset: 1, color: 'rgba(45, 212, 191, 0)' }
                    ])
                }
            }]
        }, true);
    }

    return {
        resizeAll,
        renderFolderChart,
        renderTrendChart
    };
})();
