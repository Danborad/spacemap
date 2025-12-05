// app.js version 3.1
console.log("App.js Version: 3.1 - 文件夹点击修复版本");

// 全局变量
let currentScanData = null;
let currentPage = 1;
let itemsPerPage = 20;
let filteredFiles = [];
let duplicateFilteredFiles = [];
let dupCurrentPage = 1;
let dupItemsPerPage = 10;
let currentListMode = 'large';
let selectedFolders = [];
let selectedFilePaths = new Set();
let currentFileTypeFilter = 'all';
let currentFolderPath = null;
let folderNavigationStack = []; // 文件夹导航栈
let currentDisplayFolders = []; // 当前显示的文件夹数据
let currentYAxisNames = [];
let savedFolderPaths = []; // 保存的文件夹路径列表
let currentFolderIndex = 0; // 当前使用的文件夹路径索引
let scanHistory = {}; // 存储每个路径的扫描历史数据
let themeMode = 'auto';
let themeMedia = window.matchMedia('(prefers-color-scheme: dark)');
let authorizedPaths = [];
const FEEDBACK_EMAIL = '1948863412@qq.com';

// 页面加载完成后初始化
document.addEventListener('DOMContentLoaded', function() {
    initTheme();
    initCharts();
    initEventListeners();
    // loadScanResults();
    loadSavedFolders(); // 加载保存的文件夹路径
    // loadScanHistoryFromLocal(); // 加载扫描历史
    updateLastScanStatus();
    
    // 如果有保存的文件夹路径，更新按钮显示
    if (selectedFolders.length > 0) {
        updateFolderButton(selectedFolders[0].name);
    } else {
        updateFolderButton("选择文件夹");
    }
});

// 初始化图表
function initCharts() {
    const pieEl = document.getElementById('pieChart');
    if (pieEl) {
        const ctxPie = pieEl.getContext('2d');
        window.pieChart = new Chart(ctxPie, {
            type: 'doughnut',
            data: { 
                labels: ['视频', '图片', '文档', '其他'], 
                datasets: [{ 
                    data: [0,0,0,0], 
                    backgroundColor: ['#6366f1', '#f43f5e', '#f59e0b', '#cbd5e1'], 
                    borderWidth: 0, 
                    hoverOffset: 4 
                }] 
            },
            options: { 
                cutout: '70%', 
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                animations: { colors: false, numbers: false },
                plugins: { 
                    legend: { 
                        display: true, 
                        position: 'bottom', 
                        labels: { 
                            usePointStyle: true, 
                            padding: 20,
                            color: '#cbd5e1',
                            font: { family: "'Inter', sans-serif", size: 12 }
                        } 
                    } 
                } 
            }
        });
    }

    const barEl = document.getElementById('barChart');
    if (barEl) {
        const ctxBar = barEl.getContext('2d');
        const gradient = ctxBar.createLinearGradient(0, 0, 400, 0);
        gradient.addColorStop(0, '#3B82F6');
        gradient.addColorStop(1, '#06B6D4');

        const drawLeftLabelsPlugin = {
            id: 'drawLeftLabelsPlugin',
            afterDatasetsDraw(chart) {
                // Disabled in favor of DOM labels with icons (renderBarLabels)
            }
        };

        window.barChart = new Chart(ctxBar, {
            type: 'bar',
            data: { 
                labels: [], 
                datasets: [{ 
                    label: '占用空间 (GB)', 
                    data: [], 
                    backgroundColor: '#6366f1', 
                    borderRadius: 50, 
                    barPercentage: 0.7, 
                    categoryPercentage: 0.8 
                }] 
            },
            options: {
                indexAxis: 'y',
                maintainAspectRatio: false,
                responsive: true,
                animation: false,
                animations: { colors: false, numbers: false },
                layout: { padding: { left: 160, right: 6, top: 6, bottom: 6 } },
                scales: {
                    x: {
                        beginAtZero: true,
                        grid: { display: true, color: 'rgba(255, 255, 255, 0.1)', borderDash: [4, 4], drawBorder: false },
                        ticks: { color: '#94a3b8', font: { size: 10 } }
                    },
                    y: {
                        grid: { display: false },
                        ticks: {
                            color: '#cbd5e1',
                            font: { size: 11, family: "'Inter', sans-serif" },
                            autoSkip: false,
                            maxRotation: 0,
                            padding: 2,
                            crossAlign: 'near',
                            display: false
                        }
                    }
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(15, 23, 42, 0.9)',
                        titleColor: '#f1f5f9',
                        bodyColor: '#cbd5e1',
                        borderColor: 'rgba(255, 255, 255, 0.1)',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: false,
                        callbacks: {
                            label: function(context) {
                                const val = (context && context.parsed && typeof context.parsed.x === 'number') ? context.parsed.x : Number(context.raw);
                                const num = isNaN(val) ? 0 : val;
                                return num.toFixed(2) + ' GB';
                            }
                        }
                    }
                },
                onClick: (e, elements) => {
                    if (elements && elements.length > 0) {
                        const index = elements[0].index;
                        if (window.currentDisplayItems && window.currentDisplayItems[index]) {
                            const item = window.currentDisplayItems[index];
                            if (item.type === 'folder') drillDownFolder(item.name);
                        }
                    }
                }
            }
        , plugins: [drawLeftLabelsPlugin]});
        setTimeout(() => window.renderBarLabels(), 0);
    }
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    window.renderBarLabels = debounce(function() {
        try {
            const chart = window.barChart;
            const container = document.getElementById('barChartLabels');
            if (!chart || !container) return;
            container.style.zIndex = '20';
            const y = chart.scales && chart.scales.y;
            if (!y) return;
            const labels = chart.data && chart.data.labels ? chart.data.labels : [];
            const items = window.currentDisplayItems || [];
            const isDark = document.documentElement.classList.contains('dark');
            const color = isDark ? '#e5e7eb' : '#0f172a';
            container.innerHTML = '';
            
            const padLeft = (chart.options && chart.options.layout && chart.options.layout.padding && chart.options.layout.padding.left) || 160;
            const maxWidth = padLeft - 16;
            
            // Optimization: Use Canvas measureText instead of DOM measurement
            const ctx = chart.ctx;
            ctx.font = "11px 'Inter', sans-serif";
            
            function truncateByWidth(text) {
                const ellipsis = '...';
                if (ctx.measureText(text).width <= maxWidth) return text;
                
                let low = 0, high = text.length; let best = '';
                while (low < high) {
                    const mid = Math.floor((low + high) / 2);
                    const t = text.slice(0, mid) + ellipsis;
                    if (ctx.measureText(t).width <= maxWidth) { best = t; low = mid + 1; } else { high = mid; }
                }
                return best || text.slice(0, 1) + ellipsis;
            }

            for (let i = 0; i < labels.length; i++) {
                const label = String(labels[i] || '').replace(/^📁\s|^📄\s/, '');
                const yPos = y.getPixelForTick(i);
                const item = items[i];
                
                let iconClass = 'fa-folder';
                let iconColor = isDark ? '#6366f1' : '#4f46e5'; // Indigo for folder

                if (item && item.type === 'file') {
                    const ext = item.name.split('.').pop().toLowerCase();
                    const type = getFileTypeFromExtension(ext);
                    iconClass = getFileIcon(type);
                    if (typeof getThemeFileIconColor === 'function') {
                        iconColor = getThemeFileIconColor(type, true);
                    } else {
                         iconColor = isDark ? '#cbd5e1' : '#64748b';
                    }
                }

                const row = document.createElement('div');
                row.style.position = 'absolute';
                row.style.left = '0px';
                row.style.top = `${yPos - 10}px`;
                row.style.zIndex = '21';
                row.style.display = 'flex';
                row.style.alignItems = 'center';
                row.style.color = color;
                row.style.fontSize = '11px';
                row.style.whiteSpace = 'nowrap';
                
                const iconEl = document.createElement('i');
                iconEl.className = `fas ${iconClass}`;
                iconEl.style.marginRight = '6px';
                iconEl.style.color = iconColor;
                
                const textEl = document.createElement('span');
                textEl.textContent = truncateByWidth(label);
                
                row.appendChild(iconEl);
                row.appendChild(textEl);
                container.appendChild(row);
            }
        } catch(_) {}
    }, 50);

    const trendEl = document.getElementById('sizeTrendChart');
    if (trendEl) {
        const sizeTrendChart = echarts.init(trendEl, 'dark', { renderer: 'canvas' });
        sizeTrendChart.setOption({
            backgroundColor: 'transparent',
            tooltip: { trigger: 'axis', backgroundColor: 'rgba(15, 23, 42, 0.9)', borderColor: 'rgba(255,255,255,0.1)', textStyle: { color: '#cbd5e1' } },
            grid: { top: '14%', left: '3%', right: '4%', bottom: '3%', containLabel: true },
            animation: false,
            xAxis: { 
                type: 'category', 
                boundaryGap: false, 
                data: [],
                axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.1)' } },
                axisLabel: { color: '#94a3b8' }
            },
            yAxis: [{ 
                type: 'value', 
                position: 'left', 
                axisLabel: { formatter: '{value} GB', color: '#94a3b8' }, 
                splitLine: { lineStyle: { type: 'dashed', color: 'rgba(255, 255, 255, 0.1)' } } 
            }],
            series: [{ 
                name: '总大小 (GB)', 
                type: 'line', 
                smooth: true, 
                data: [], 
                lineStyle: { color: '#6366f1', width: 3 }, 
                symbol: 'none', 
                areaStyle: { 
                    color: new echarts.graphic.LinearGradient(0,0,0,1,[
                        {offset:0,color:'rgba(99, 102, 241, 0.3)'},
                        {offset:1,color:'rgba(99, 102, 241, 0)'}
                    ]) 
                } 
            }]
        });
        window.sizeTrendChart = sizeTrendChart;
    }

    window.addEventListener('resize', debounce(function() {
        if (window.pieChart) window.pieChart.resize();
        if (window.barChart) window.barChart.resize();
        if (window.sizeTrendChart) window.sizeTrendChart.resize();
    }, 200));
}

// 初始化事件监听器
function initEventListeners() {
    // 为表格行添加点击事件
    document.addEventListener('click', function(e) {
        if (e.target.closest('tbody tr') && !e.target.closest('button')) {
            const row = e.target.closest('tbody tr');
            row.classList.toggle('bg-blue-50');
        }
    });

    // 为操作按钮添加点击事件
    document.addEventListener('click', function(e) {
        if (e.target.closest('tbody button')) {
            e.stopPropagation();
            const button = e.target.closest('tbody button');
            const action = button.title;
            const fileName = button.closest('tr').querySelector('td:first-child span').textContent;
            const filePath = button.closest('tr').dataset.filePath;
            
            handleFileAction(action, filePath, fileName);
        }
    });

    // 为文件夹设置按钮添加点击事件
    document.addEventListener('click', function(e) {
        if (e.target.closest('#folderSettingsBtn')) {
            e.preventDefault();
            showFolderSettings();
        }
    });

    document.addEventListener('click', function(e) {
        if (e.target.closest('#themeToggleBtn')) {
            e.preventDefault();
            toggleThemeDropdown();
        }
        const item = e.target.closest('#themeDropdown [data-theme]');
        if (item) {
            const v = item.getAttribute('data-theme');
            setThemeMode(v);
            closeThemeDropdown();
        }
    });
    
    // 点击页面其他地方关闭文件夹下拉菜单
    document.addEventListener('click', function(e) {
        const dropdown = document.getElementById('folderDropdown');
        const button = document.getElementById('selectFolderBtn');
        
        if (dropdown && button && !button.contains(e.target) && !dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
        }
    });

    document.addEventListener('click', function(e) {
        const dd = document.getElementById('themeDropdown');
        const btn = document.getElementById('themeToggleBtn');
        if (dd && btn && !btn.contains(e.target) && !dd.contains(e.target)) {
            dd.classList.add('hidden');
        }
    });

    document.addEventListener('click', function(e) {
        const btn = e.target.closest('#feedbackBtn');
        if (btn) {
            e.preventDefault();
            const pop = document.getElementById('feedbackPopover');
            if (pop) pop.classList.toggle('hidden');
        }
    });

    document.addEventListener('click', function(e) {
        const emailBtn = e.target.closest('#feedbackEmailBtn');
        if (emailBtn) {
            e.preventDefault();
            copyFeedbackEmail();
            const pop = document.getElementById('feedbackPopover');
            if (pop) pop.classList.add('hidden');
        }
    });

    document.addEventListener('click', function(e) {
        const pop = document.getElementById('feedbackPopover');
        const btn = document.getElementById('feedbackBtn');
        if (pop && btn && !btn.contains(e.target) && !pop.contains(e.target)) {
            pop.classList.add('hidden');
        }
    });

    document.addEventListener('click', function(e) {
        if (e.target.closest('#exportBtn')) {
            e.preventDefault();
            exportReport('csv');
        }
    });

    const headerEl = document.querySelector('header.hero-gradient');
    if (headerEl) {
        headerEl.addEventListener('mousemove', function(e) {
            const rect = headerEl.getBoundingClientRect();
            const mx = ((e.clientX - rect.left) / rect.width) * 100 + '%';
            const my = ((e.clientY - rect.top) / rect.height) * 100 + '%';
            headerEl.style.setProperty('--mx', mx);
            headerEl.style.setProperty('--my', my);
        });
    }
}

// 加载更多文件
function showMoreFiles() {
    if (currentListMode === 'large') {
        currentPage++;
        updateFileTable();
    } else {
        dupCurrentPage++;
        updateDuplicateTable();
    }
}

// 更新加载更多按钮状态
function updateLoadMoreButton(totalItems, currentCount) {
    const btn = document.getElementById('loadMoreBtn');
    if (!btn) return;
    
    if (currentCount >= totalItems) {
        btn.classList.add('hidden');
    } else {
        btn.classList.remove('hidden');
        btn.textContent = `加载更多 (${totalItems - currentCount})`;
    }
}


function initTheme() {
    const saved = localStorage.getItem('themeMode');
    themeMode = saved || 'auto';
    applyTheme();
    if (themeMedia) {
        themeMedia.onchange = function() {
            if (themeMode === 'auto') applyTheme();
        };
    }
}

function setThemeMode(mode) {
    themeMode = mode || 'auto';
    localStorage.setItem('themeMode', themeMode);
    applyTheme();
}

function applyTheme() {
    const isDark = themeMode === 'dark' || (themeMode === 'auto' && themeMedia && themeMedia.matches);
    document.documentElement.classList.toggle('dark', !!isDark);
    document.documentElement.classList.toggle('light', !isDark);
    const icon = document.getElementById('themeIcon');
    if (icon) {
        icon.className = `fas ${isDark ? 'fa-moon' : 'fa-sun'} text-lg`;
    }
    updateThemeDropdownActive();
    updateChartsTheme(!!isDark);
    try {
        if (window.barChart) {
            window.barChart.update();
        }
    } catch (_) {}
    
    // Refresh file list to update icon colors
    renderCurrentList();
}

function toggleThemeDropdown() {
    const dd = document.getElementById('themeDropdown');
    if (!dd) return;
    dd.classList.toggle('hidden');
    updateThemeDropdownActive();
}

function closeThemeDropdown() {
    const dd = document.getElementById('themeDropdown');
    if (dd) dd.classList.add('hidden');
}

function updateThemeDropdownActive() {
    const dd = document.getElementById('themeDropdown');
    if (!dd) return;
    dd.querySelectorAll('[data-theme]').forEach(el => {
        const active = el.getAttribute('data-theme') === themeMode;
        el.classList.toggle('font-semibold', active);
        el.classList.toggle('text-accent-primary', active);
        el.style.opacity = '1';
        el.disabled = false;
    });
}

async function copyFeedbackEmail() {
    const text = FEEDBACK_EMAIL;
    try {
        if (window.isSecureContext && navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
            showNotification('反馈邮箱已复制：' + text, 'success');
            return true;
        }
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    ta.remove();
    if (ok) {
        showNotification('反馈邮箱已复制：' + text, 'success');
        return true;
    }
    showNotification('反馈邮箱：' + text, 'info');
    return false;
}

function exportReport(type) {
    const url = type === 'json' ? '/api/export/json' : '/api/export/csv';
    try {
        const a = document.createElement('a');
        a.href = url;
        a.download = type === 'json' ? 'spacemap_report.json' : 'spacemap_report.csv';
        document.body.appendChild(a);
        a.click();
        a.remove();
        showNotification('报告已导出', 'success');
    } catch (_) {
        window.open(url, '_blank');
    }
}

// 切换文件夹下拉菜单
function toggleFolderDropdown() {
    const dropdown = document.getElementById('folderDropdown');
    if (!dropdown) return;
    if (dropdown.classList.contains('hidden')) {
        // 显示下拉菜单前，先更新下拉菜单内容
        updateFolderDropdown();
        dropdown.classList.remove('hidden');
    } else {
        dropdown.classList.add('hidden');
    }
}

// 更新文件夹下拉菜单内容
function updateFolderDropdown() {
    const dropdownContent = document.getElementById('folderDropdown');
    if (!dropdownContent) return;
    
    const folderListHtml = savedFolderPaths && savedFolderPaths.length > 0 ? 
        savedFolderPaths.map((folder, index) => `
            <div class="px-4 py-2 hover:bg-white/5 cursor-pointer flex items-center justify-between rounded-lg transition-colors" onclick="switchToFolderPath(${index})">
                <div class="flex items-center">
                    <i class="fas fa-folder text-accent-primary mr-3"></i>
                    <div>
                        <div class="text-sm font-medium text-gray-200">${folder.name}</div>
                        <div class="text-xs text-gray-400">${folder.path}</div>
                    </div>
                </div>
                ${index === currentFolderIndex ? '<i class="fas fa-check text-green-400"></i>' : ''}
            </div>
        `).join('') : 
        '<div class="px-4 py-2 text-gray-500 text-sm">暂无配置的路径</div>';
    
    dropdownContent.innerHTML = `
        <div class="max-h-60 overflow-y-auto custom-scrollbar">
            ${folderListHtml}
        </div>
        <div class="border-t border-white/10 p-2 mt-1">
            <button onclick="showFolderSettings(); toggleFolderDropdown();" class="w-full text-left px-3 py-2 text-sm text-accent-primary hover:bg-white/5 rounded-lg transition-colors flex items-center">
                <i class="fas fa-cog mr-2"></i>管理扫描路径
            </button>
        </div>
    `;
}

// 处理文件操作
function handleFileAction(action, filePath, fileName) {
    switch(action) {
        case '查看详情':
            showFileDetails(filePath);
            break;
        case '定位文件':
            locateFile(filePath);
            break;
        case '删除':
            deleteFile(filePath, fileName);
            break;
    }
}

// 显示文件详情
async function showFileDetails(filePath) {
    try {
        const response = await fetch(`/api/file-details?filePath=${encodeURIComponent(filePath)}`);
        const result = await response.json();
        
        if (result.success) {
            const file = result.data;
            const modal = document.getElementById('fileDetailModal');
            const content = document.getElementById('fileDetailContent');
            
            content.innerHTML = `
                <div class="space-y-6">
                    <div class="flex items-center space-x-4 p-4 bg-white/5 rounded-2xl">
                        <div class="w-12 h-12 rounded-xl bg-accent-primary/20 flex items-center justify-center">
                            <i class="fas fa-file text-2xl text-accent-primary"></i>
                        </div>
                        <div>
                            <h4 class="font-bold text-lg text-white">${file.name}</h4>
                            <p class="text-gray-400 text-sm break-all">${file.path}</p>
                        </div>
                    </div>
                    <div class="grid grid-cols-2 gap-6">
                        <div class="glass-panel p-4 bg-white/5 border-none">
                            <label class="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">文件大小</label>
                            <p class="text-gray-200 font-semibold">${file.sizeFormatted}</p>
                        </div>
                        <div class="glass-panel p-4 bg-white/5 border-none">
                            <label class="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">文件类型</label>
                            <p class="text-gray-200 font-semibold">${file.type}</p>
                        </div>
                        <div class="glass-panel p-4 bg-white/5 border-none">
                            <label class="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">扩展名</label>
                            <p class="text-gray-200 font-semibold">${file.extension || '无'}</p>
                        </div>
                        <div class="glass-panel p-4 bg-white/5 border-none">
                            <label class="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">MIME类型</label>
                            <p class="text-gray-200 font-semibold">${file.mimeType}</p>
                        </div>
                        <div class="glass-panel p-4 bg-white/5 border-none">
                            <label class="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">创建时间</label>
                            <p class="text-gray-200 font-semibold">${new Date(file.created).toLocaleString('zh-CN')}</p>
                        </div>
                        <div class="glass-panel p-4 bg-white/5 border-none">
                            <label class="text-xs font-medium text-gray-500 uppercase tracking-wider block mb-1">修改时间</label>
                            <p class="text-gray-200 font-semibold">${new Date(file.modified).toLocaleString('zh-CN')}</p>
                        </div>
                    </div>
                    <div class="flex justify-end pt-4">
                        <button onclick="locateFile('${file.path.replace(/\\/g, '\\\\')}')" class="glass-btn text-accent-cyan hover:bg-accent-cyan/10 border-accent-cyan/20">
                            <i class="fas fa-folder-open"></i> 在资源管理器中打开
                        </button>
                    </div>
                </div>`;
            
            modal.classList.remove('hidden');
        } else {
            showNotification('获取文件详情失败: ' + result.error, 'error');
        }
    } catch (error) {
        console.error('获取文件详情错误:', error);
        showNotification('获取文件详情失败', 'error');
    }
}

// 定位文件
function locateFile(filePath) {
    // 在Windows系统中打开文件所在文件夹
    if (navigator.platform.indexOf('Win') !== -1) {
        // 使用Windows的explorer命令
        const folderPath = filePath.substring(0, filePath.lastIndexOf('\\'));
        window.open(`file:///${folderPath.replace(/\\/g, '/')}`);
    } else {
        // 其他系统显示路径信息
        alert(`文件路径: ${filePath}`);
    }
}

// 删除文件
async function deleteFile(filePath, fileName) {
    if (!confirm(`确定要删除文件 "${fileName}" 吗？此操作不可撤销。`)) {
        return;
    }
    
    try {
        const response = await fetch('/api/file', {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ filePath })
        });
        
        const result = await response.json();
        
        if (result.success) {
            alert('文件删除成功');
            // 重新加载数据
            loadScanResults();
        } else {
            alert('删除文件失败: ' + result.error);
        }
    } catch (error) {
        console.error('删除文件错误:', error);
        alert('删除文件时发生错误');
    }
}

// 选择文件夹
function selectFolders() {
    const modal = document.getElementById('folderModal');
    loadAvailableFolders();
    if (modal) modal.classList.remove('hidden');
}

// 关闭文件夹选择模态框
function closeFolderModal() {
    const modal = document.getElementById('folderModal');
    if (modal) modal.classList.add('hidden');
}

// 显示文件夹设置（管理扫描路径）
function showFolderSettings() {
    loadFolderSettingsList();
    const modal = document.getElementById('folderSettingsModal');
    if (modal) {
        modal.classList.remove('hidden');
    } else {
        showNotification('设置面板暂未集成到此主题', 'info');
    }
}

// 关闭文件夹设置模态框
function closeFolderSettingsModal() {
    const modal = document.getElementById('folderSettingsModal');
    if (modal) modal.classList.add('hidden');
}

// 加载文件夹设置列表
function loadFolderSettingsList() {
    const container = document.getElementById('folderSettingsList');
    
    container.innerHTML = `
        <div class="mb-4">
            <label class="block text-sm font-medium text-text-primary mb-2">添加新的扫描路径</label>
            <div class="flex space-x-2">
                <input type="text" id="newFolderPath" class="flex-1 px-3 py-2 border border-gray-300 dark:border-[#2a3445] dark:bg-[#121a2b] dark:text-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary" placeholder="例如: C:\\Users\\YourName\\Documents">
                <button onclick="addNewFolderPath()" class="px-4 py-2 bg-primary text-white rounded-md hover:bg-primary/90 transition-colors">
                    <i class="fas fa-plus mr-1"></i>添加
                </button>
            </div>
            <p class="mt-1 text-sm text-text-secondary">支持多个路径，用逗号分隔</p>
        </div>
        
        <div class="mb-4">
            <label class="block text-sm font-medium text-text-primary mb-2">已配置的扫描路径</label>
            <div id="configuredFoldersList" class="space-y-2">
                ${savedFolderPaths.length > 0 ? savedFolderPaths.map((folder, index) => `
                    <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-[#121a2b] border border-gray-200 dark:border-[#2a3445] rounded-md">
                        <div class="flex items-center space-x-3">
                            <i class="fas fa-folder text-primary"></i>
                            <div>
                                <div class="text-sm font-medium">${folder.name}</div>
                                <div class="text-xs text-text-secondary">${folder.path}</div>
                            </div>
                        </div>
                        <div class="flex items-center space-x-2">
                            <button onclick="editFolderPath(${index})" class="text-blue-500 hover:text-blue-700" title="编辑">
                                <i class="fas fa-edit"></i>
                            </button>
                            <button onclick="deleteFolderPath(${index})" class="text-red-500 hover:text-red-700" title="删除">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                `).join('') : '<p class="text-text-tertiary text-sm p-3 text-center">暂无配置的扫描路径</p>'}
            </div>
        </div>
    `;
}

// 添加新的扫描路径
function addNewFolderPath() {
    const input = document.getElementById('newFolderPath');
    const path = input.value.trim();
    
    if (!path) {
        showNotification('请输入有效的文件夹路径', 'error');
        return;
    }
    
    // 支持多个路径，用逗号分隔
    const paths = path.split(',').map(p => p.trim()).filter(p => p);
    
    let addedCount = 0;
    paths.forEach(p => {
        // 从路径中提取名称
        const name = p.split(/[\/\\]/).pop() || p;
        // 检查是否已存在
        if (!savedFolderPaths.some(f => f.path === p)) {
            savedFolderPaths.push({ path: p, name: name });
            addedCount++;
        }
    });
    
    if (addedCount > 0) {
        // 保存到本地存储
        saveFolderPathsToLocal();
        // 清空输入框
        input.value = '';
        // 重新加载列表
        loadFolderSettingsList();
        showNotification(`已添加 ${addedCount} 个路径`, 'success');
    } else {
        showNotification('所有路径已存在，无需重复添加', 'info');
    }
}

// 编辑扫描路径
function editFolderPath(index) {
    const folder = savedFolderPaths[index];
    const container = document.getElementById('configuredFoldersList');
    if (!container) return;
    const row = container.children[index];
    if (!row) return;
    const current = folder.path;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'px-2 py-1 border border-gray-300 dark:border-[#2a3445] dark:bg-[#121a2b] dark:text-gray-200 rounded-md w-full';
    const ok = document.createElement('button');
    ok.textContent = '保存';
    ok.className = 'ml-2 px-3 py-1 bg-primary text-white rounded-md';
    const cancel = document.createElement('button');
    cancel.textContent = '取消';
    cancel.className = 'ml-2 px-3 py-1 bg-gray-100 dark:bg-[#1a2335] text-text-secondary dark:text-gray-300 rounded-md';
    const pathEl = row.querySelector('.text-xs.text-text-secondary');
    const actionEl = row.querySelector('.flex.items-center.space-x-2');
    const originalPath = pathEl.textContent;
    pathEl.textContent = '';
    pathEl.appendChild(input);
    actionEl.innerHTML = '';
    actionEl.appendChild(ok);
    actionEl.appendChild(cancel);
    ok.onclick = () => {
        const newPath = input.value.trim();
        if (!newPath) { showNotification('请输入有效路径', 'error'); return; }
        const newName = newPath.split(/[\/\\]/).pop() || newPath;
        if (!savedFolderPaths.some((f, i) => i !== index && f.path === newPath)) {
            savedFolderPaths[index] = { path: newPath, name: newName };
            saveFolderPathsToLocal();
            loadFolderSettingsList();
            showNotification('路径已更新', 'success');
        } else {
            showNotification('路径已存在', 'error');
        }
    };
    cancel.onclick = () => {
        pathEl.textContent = originalPath;
        loadFolderSettingsList();
    };
}

// 删除扫描路径
function deleteFolderPath(index) {
    if (confirm('确定要删除这个路径吗？')) {
        savedFolderPaths.splice(index, 1);
        saveFolderPathsToLocal();
        loadFolderSettingsList();
        showNotification('路径已删除', 'success');
    }
}

// 保存路径列表到本地存储
function saveFolderPathsToLocal() {
    try {
        localStorage.setItem('spacemap-saved-folder-paths', JSON.stringify(savedFolderPaths));
    } catch (error) {}
    saveFolderPathsToServer();
}

async function saveFolderPathsToServer() {
    try {
        await fetch('/api/saved-folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ folders: savedFolderPaths })
        });
    } catch (error) {}
}

// 加载保存的路径列表
async function loadSavedFolderPaths() {
    try {
        const resp = await fetch('/api/saved-folders');
        if (resp.ok) {
            const r = await resp.json();
            if (r && r.success && Array.isArray(r.data)) {
                savedFolderPaths = r.data;
                localStorage.setItem('spacemap-saved-folder-paths', JSON.stringify(savedFolderPaths));
                return;
            }
        }
    } catch (error) {}
    try {
        const saved = localStorage.getItem('spacemap-saved-folder-paths');
        if (saved) {
            savedFolderPaths = JSON.parse(saved);
        } else {
            savedFolderPaths = [];
        }
    } catch (error) {
        savedFolderPaths = [];
    }
}

// 更新切换文件夹按钮显示
function updateFolderButton(folderName) {
    const button = document.getElementById('selectFolderBtn');
    const span = button.querySelector('span');
    span.textContent = folderName || '切换文件夹';
}

// 切换到已配置的扫描路径
function switchToFolderPath(index) {
    const selectedFolder = savedFolderPaths[index];
    if (selectedFolder) {
        selectedFolders = [selectedFolder];
        currentFolderIndex = index; // 更新当前路径索引
        saveFoldersToLocalStorage();
        toggleFolderDropdown(); // 关闭下拉菜单
        
        // 更新切换文件夹按钮显示当前文件夹名称
        updateFolderButton(selectedFolder.name);
        
        // 启用重新扫描按钮
        enableButtons();
        
        showNotification(`已切换到: ${selectedFolder.name}`, 'success');
        // 服务器读取该路径历史
        fetch(`/api/last-scan?path=${encodeURIComponent(selectedFolder.path)}`)
            .then(r => r.json())
            .then(r => {
                const last = r && r.success ? r.data : null;
                if (last && last.data) {
                    currentScanData = last.data;
                    updateAllDisplays();
                    showNotification(`已加载上次的扫描记录 (${new Date(last.timestamp).toLocaleString()})`, 'info');
                } else {
                    currentScanData = null;
                    clearAllDisplays();
                    showNotification('暂无该路径的扫描记录，点击"重新扫描"开始首次扫描', 'info');
                }
            }).catch(() => {
                currentScanData = null;
                clearAllDisplays();
                showNotification('读取历史失败，请重新扫描', 'error');
            });
    }
}

// 导出路径列表
function exportFolderPaths() {
    const dataStr = JSON.stringify(savedFolderPaths, null, 2);
    const dataBlob = new Blob([dataStr], { type: 'application/json' });
    
    const link = document.createElement('a');
    link.href = URL.createObjectURL(dataBlob);
    link.download = `spacemap_folder_paths_${new Date().toISOString().split('T')[0]}.json`;
    link.click();
    
    showNotification('路径列表已导出', 'success');
}

// 导入路径列表
function importFolderPaths(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const importedPaths = JSON.parse(e.target.result);
            
            // 验证导入的数据格式
            if (!Array.isArray(importedPaths)) {
                throw new Error('Invalid format');
            }
            
            // 合并导入的路径，去重
            let addedCount = 0;
            importedPaths.forEach(pathInfo => {
                if (pathInfo.path && pathInfo.name && 
                    !savedFolderPaths.some(f => f.path === pathInfo.path)) {
                    savedFolderPaths.push({ path: pathInfo.path, name: pathInfo.name });
                    addedCount++;
                }
            });
            
            if (addedCount > 0) {
                saveFolderPathsToLocal();
                loadFolderSettingsList();
                showNotification(`成功导入 ${addedCount} 个路径`, 'success');
            } else {
                showNotification('没有新的路径需要导入', 'info');
            }
        } catch (error) {
            console.error('导入路径失败:', error);
            showNotification('导入失败，文件格式不正确', 'error');
        }
    };
    reader.readAsText(file);
    
    // 清空文件选择
    event.target.value = '';
}

let lastStatusMessage = '上次更新：尚未扫描';
let notificationTimeout = null;

function updateLastScanStatus() {
    const statusEl = document.getElementById('lastUpdatedText');
    if (!statusEl) return;
    
    const timeStr = new Date().toLocaleString();
    lastStatusMessage = `上次更新：${timeStr}`;
    
    if (!notificationTimeout) {
        statusEl.textContent = lastStatusMessage;
        statusEl.className = 'text-xs text-gray-500 dark:text-white/70 transition-colors duration-300';
    }
}

// 显示通知消息 (Status Bar)
function showNotification(message, type = 'info') {
    const statusEl = document.getElementById('lastUpdatedText');
    if (!statusEl) {
        console.log('Notification:', message);
        return;
    }

    if (notificationTimeout) {
        clearTimeout(notificationTimeout);
        notificationTimeout = null;
    }

    statusEl.textContent = message;
    statusEl.className = 'text-xs transition-colors duration-300 font-medium ' + (
        type === 'error' ? 'text-red-500' :
        type === 'success' ? 'text-green-500' :
        'text-blue-500'
    );

    notificationTimeout = setTimeout(() => {
        statusEl.className = 'text-xs text-gray-500 dark:text-white/70 transition-colors duration-300';
        statusEl.textContent = lastStatusMessage;
        notificationTimeout = null;
    }, 3000);
}

// 加载可用文件夹
async function loadAvailableFolders() {
    const container = document.getElementById('availableFolders');
    
    // 创建手动输入路径的界面
    container.innerHTML = `
        <div class="mb-4">
            <label class="block text-sm font-medium text-text-primary mb-2">请输入要分析的文件夹路径</label>
            <input type="text" id="manualFolderPath" class="w-full px-3 py-2 border border-gray-300 dark:border-[#2a3445] dark:bg-[#121a2b] dark:text-gray-200 rounded-md focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary" placeholder="例如: C:\\Users\\YourName\\Documents 或 /home/user/documents">
            <p class="mt-1 text-sm text-text-secondary">支持多个路径，用逗号分隔</p>
        </div>
        <div class="mb-4">
            <button onclick="addManualFolder()" class="w-full px-4 py-2 bg-primary text-white rounded-md hover:bg-primary/90 transition-colors">
                <i class="fas fa-plus mr-2"></i>添加路径
            </button>
        </div>
        <div class="mb-4">
            <label class="block text-sm font-medium text-text-primary mb-2">系统已授权访问的文件夹</label>
            <div id="authorizedFolderList" class="space-y-2"></div>
        </div>
        <div class="mb-4">
            <label class="block text-sm font-medium text-text-primary mb-2">已添加的路径</label>
            <div id="manualFoldersList" class="space-y-2">
                ${selectedFolders.map((folder, index) => `
                    <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-[#121a2b] border border-gray-200 dark:border-[#2a3445] rounded-md">
                        <div class="flex items-center space-x-2">
                            <i class="fas fa-folder text-primary"></i>
                            <div>
                                <div class="text-sm font-medium">${folder.name}</div>
                                <div class="text-xs text-text-secondary">${folder.path}</div>
                            </div>
                        </div>
                        <button onclick="removeSelectedFolder(${index})" class="text-red-500 hover:text-red-700">
                            <i class="fas fa-times"></i>
                        </button>
                    </div>
                `).join('') || '<p class="text-text-tertiary text-sm p-3 text-center">暂无已添加的路径</p>'}
            </div>
        </div>
    `;
    try {
        const r = await fetch('/api/allowed-paths').then(x => x.json()).catch(() => ({ success: false }));
        const list = (r && r.success && Array.isArray(r.data)) ? r.data : [];
        authorizedPaths = list;
        const box = document.getElementById('authorizedFolderList');
        if (box) {
            box.innerHTML = list.length ? list.map((f, idx) => `
                <div class="flex items-center justify-between p-3 bg-gray-50 dark:bg-[#121a2b] border border-gray-200 dark:border-[#2a3445] rounded-md">
                    <div class="flex items-center space-x-2">
                        <i class="fas fa-folder text-primary"></i>
                        <div>
                            <div class="text-sm font-medium">${f.name}</div>
                            <div class="text-xs text-text-secondary">${f.path}</div>
                        </div>
                    </div>
                    <button onclick="addAuthorizedFolder('${encodeURIComponent(f.path)}')" class="text-blue-500 hover:text-blue-700">
                        <i class="fas fa-plus"></i>
                    </button>
                </div>
            `).join('') : '<p class="text-text-tertiary text-sm p-3 text-center">暂无已授权的文件夹，请到应用设置中添加</p>';
        }
    } catch (_) {}
}

function addAuthorizedFolder(encPath) {
    const p = decodeURIComponent(encPath);
    const name = p.split(/[\/\\]/).pop() || p;
    if (!selectedFolders.some(f => f.path === p)) {
        selectedFolders.push({ path: p, name });
        saveFoldersToLocalStorage();
        loadAvailableFolders();
        enableButtons();
    }
}

// 加载保存的文件夹路径
async function loadSavedFolders() {
    try {
        // 默认不自动加载上次选择的文件夹，以免出现未扫描的文件夹显示
        // const savedFolders = localStorage.getItem('spacemap-selected-folders');
        // if (savedFolders) {
        //     selectedFolders = JSON.parse(savedFolders);
        //     if (selectedFolders.length > 0 && savedFolderPaths.length > 0) {
        //         const currentPath = selectedFolders[0].path;
        //         const index = savedFolderPaths.findIndex(folder => folder.path === currentPath);
        //         if (index !== -1) {
        //             currentFolderIndex = index;
        //         }
        //     }
        //     if (selectedFolders.length > 0) {
        //         enableButtons();
        //     }
        // }
        
        // 确保初始状态为空，显示"选择文件夹"
        selectedFolders = [];
        
        await loadSavedFolderPaths();
        await loadAllowedPaths();
    } catch (error) {
        selectedFolders = [];
        savedFolderPaths = [];
        currentFolderIndex = 0;
    }
}

// 加载Docker环境变量配置的允许路径
async function loadAllowedPaths() {
    try {
        const response = await fetch('/api/allowed-paths');
        if (response.ok) {
            const result = await response.json();
            if (result.success && Array.isArray(result.data)) {
                let added = false;
                result.data.forEach(p => {
                    // 检查是否已存在（根据路径）
                    if (!savedFolderPaths.some(f => f.path === p.path)) {
                        savedFolderPaths.push(p);
                        added = true;
                    }
                });
                
                // 如果有新增路径，保存并更新
                if (added) {
                    saveFolderPathsToLocal();
                    console.log('自动添加了Docker环境变量配置的路径:', result.data);
                }
            }
        }
    } catch (error) {
        console.error('加载允许路径失败:', error);
    }
}

// 保存文件夹路径到本地存储
function saveFoldersToLocalStorage() {
    try {
        localStorage.setItem('spacemap-selected-folders', JSON.stringify(selectedFolders));
    } catch (error) {
        console.error('保存文件夹路径到本地存储失败:', error);
    }
}

// 添加手动输入的文件夹
function addManualFolder() {
    const input = document.getElementById('manualFolderPath');
    const path = input.value.trim();
    
    if (!path) {
        alert('请输入有效的文件夹路径');
        return;
    }
    
    // 支持多个路径，用逗号分隔
    const paths = path.split(',').map(p => p.trim()).filter(p => p);
    
    let addedCount = 0;
    paths.forEach(p => {
        // 从路径中提取名称
        const name = p.split(/[\/\\]/).pop() || p;
        // 检查是否已存在
        if (!selectedFolders.some(f => f.path === p)) {
            selectedFolders.push({ path: p, name: name });
            addedCount++;
        }
    });
    
    if (addedCount > 0) {
        // 保存到本地存储
        saveFoldersToLocalStorage();
        // 清空输入框
        input.value = '';
        // 重新加载文件夹列表
        loadAvailableFolders();
        
        // 启用重新扫描按钮
        enableButtons();
    } else {
        alert('所有路径已存在，无需重复添加');
    }
}

// 移除已选择的文件夹
function removeSelectedFolder(index) {
    selectedFolders.splice(index, 1);
    // 保存到本地存储
    saveFoldersToLocalStorage();
    // 重新加载文件夹列表
    loadAvailableFolders();
    
    // 如果没有已选择的文件夹，禁用按钮
    if (selectedFolders.length === 0) {
        const rescanBtn = document.getElementById('rescanBtn');
        const exportBtn = document.getElementById('exportBtn');
        if (rescanBtn) rescanBtn.disabled = true;
        if (exportBtn) exportBtn.disabled = true;
    }
}

// 开始扫描
async function startScan() {
    console.log('开始扫描，已选择文件夹:', selectedFolders);
    
    if (selectedFolders.length === 0) {
        alert('请至少选择一个文件夹');
        return;
    }
    
    closeFolderModal();
    showScanStatus(true);
    
    try {
        const paths = selectedFolders.map(f => f.path);
        console.log('发送扫描请求，路径:', paths);
        
        const response = await fetch('/api/scan', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                paths: paths,
                maxDepth: 50  // 完整扫描
            })
        });
        
        const result = await response.json();
        console.log('扫描结果:', result);
        
        if (result.success) {
            currentScanData = result.data;
            try {
                if (result.data && Array.isArray(result.data.unauthorized) && result.data.unauthorized.length) {
                    showNotification('部分路径未授权，已跳过: ' + result.data.unauthorized.join(', '), 'error');
                }
                updateUI(result.data);
            } catch (e) {
                console.error('更新界面时发生错误:', e);
                showNotification('界面更新出现异常，已继续显示可用内容', 'error');
            }
            showScanStatus(false);
            enableButtons();
            
            // 保存扫描结果到历史记录
            try { saveScanToHistory(); } catch (e) { console.warn('保存扫描历史失败:', e); }
            try { updateTrendChart(); } catch (e) { console.warn('更新趋势图失败:', e); }
        } else {
            alert('扫描失败: ' + result.error);
            showScanStatus(false);
        }
    } catch (error) {
        console.error('扫描错误:', error);
        showNotification('扫描过程中发生错误：' + (error && error.message ? error.message : '未知错误'), 'error');
        showScanStatus(false);
    }
}

// 重新扫描
function rescanFolders() {
    console.log('rescanFolders 被调用');
    console.log('selectedFolders 状态:', selectedFolders);
    console.log('selectedFolders 长度:', selectedFolders.length);
    
    if (selectedFolders.length === 0) {
        console.log('selectedFolders 为空，弹出提示');
        alert('没有可重新扫描的文件夹');
        return;
    }
    
    console.log('调用 startScan 开始重新扫描');
    startScan();
}

// 显示扫描状态
function showScanStatus(show) {
    const status = document.getElementById('scanStatus');
    if (!status) return;
    if (show) {
        status.classList.remove('hidden');
    } else {
        status.classList.add('hidden');
    }
}

// 启用按钮
function enableButtons() {
    console.log('enableButtons 被调用，启用重新扫描和导出按钮');
    const rescanBtn = document.getElementById('rescanBtn');
    
    if (rescanBtn) {
        rescanBtn.disabled = false;
        console.log('重新扫描按钮已启用');
    } else {
        console.error('找不到重新扫描按钮元素');
    }
}

// 更新UI
function updateUI(data) {
    // 保存完整数据到全局变量
    currentScanData = data;
    console.log('updateUI: 保存完整数据到 currentScanData:', currentScanData);
    console.log('updateUI: allFiles 数量:', data.allFiles?.length);
    console.log('updateUI: allFiles 内容:', data.allFiles);
    
    // 更新概览卡片
    document.getElementById('totalFiles').textContent = data.totalFiles.toLocaleString();
    document.getElementById('totalFolders').textContent = data.totalFolders.toLocaleString();
    document.getElementById('totalSize').textContent = formatBytes(data.totalSize);
    document.getElementById('averageSize').textContent = formatBytes((() => { try { const list = Array.isArray(data.allFiles) ? data.allFiles : []; if (!list.length) return 0; let max = 0; for (let i=0;i<list.length;i++){ const s=list[i].size||0; if (s>max) max=s;} return max; } catch(_) { return 0; } })());
    
    // 更新图表
    try { updateFileTypeChart(); } catch (e) { console.error('更新文件类型图表失败:', e); }
    try { updateFolderSizeChart(); } catch (e) { console.error('更新文件夹大小图表失败:', e); }
    try { updateTrendChart(); } catch (e) { console.error('更新趋势图失败:', e); }
    
    // 更新文件列表
    filteredFiles = data.largeFiles || [];
    renderCurrentList();
}

// 更新文件类型图表
function updateFileTypeChart() {
    if (!currentScanData || !window.pieChart) return;
    const filter = document.getElementById('fileTypeFilter').value;
    let fileTypes = {};
    if (currentFolderPath && currentScanData.allFiles) {
        const allFilesInCurrentPath = currentScanData.allFiles.filter(file => {
            const fp = String(file.path || '').replace(/\\/g, '/');
            const cp = String(currentFolderPath || '').replace(/\\/g, '/');
            return fp.startsWith(cp + '/') || fp === cp;
        });
        allFilesInCurrentPath.forEach(file => {
            const ext = file.name.split('.').pop()?.toLowerCase() || 'unknown';
            const type = getFileTypeFromExtension(ext);
            fileTypes[type] = (fileTypes[type] || 0) + 1;
        });
    } else {
        fileTypes = currentScanData.fileTypes || {};
    }
    const groups = ['视频','图片','文档','其他'];
    let values = [fileTypes.video||0, fileTypes.image||0, fileTypes.document||0, (fileTypes.other||0)+(fileTypes.audio||0)+(fileTypes.archive||0)+(fileTypes.code||0)];
    if (filter !== 'all') {
        const mapping = { image:'图片', video:'视频', document:'文档', other:'其他', audio:'其他', archive:'其他', code:'其他' };
        const target = mapping[filter] || '其他';
        values = groups.map(g => g===target ? values[groups.indexOf(g)] : 0);
    }
    window.pieChart.data.labels = groups;
    window.pieChart.data.datasets[0].data = values;
    window.pieChart.update();
}

// 更新文件夹大小图表
function updateFolderSizeChart() {
    if (!currentScanData || !window.barChart) return;
    const limit = parseInt(document.getElementById('folderSizeFilter').value);
    const roots = selectedFolders && selectedFolders.length ? selectedFolders.map(f => f.path) : [];
    const allFolders = currentScanData.allFolders || [];
    const allFiles = currentScanData.allFiles || [];
    function isDirectChild(childPath, parentPath) {
        const child = String(childPath || '');
        const parent = String(parentPath || '');
        if (!child || !parent) return false;
        if (!child.startsWith(parent)) return false;
        if (child.length <= parent.length) return false;
        const nextChar = child[parent.length];
        if (nextChar !== '\\' && nextChar !== '/') return false;
        let rest = child.slice(parent.length + 1);
        if (!rest) return false;
        return !(/[\\\/]/.test(rest));
    }
    let displayItems = [];
    if (roots.length) {
        roots.forEach(root => {
            allFolders.forEach(f => { if (isDirectChild(f.path, root)) { displayItems.push({ name: f.name, displayName: f.name.length>15?f.name.substring(0,15)+'...':f.name, type:'folder', path:f.path, size:f.size }); } });
            allFiles.forEach(file => { if (isDirectChild(file.path, root)) { displayItems.push({ name:file.name, displayName:file.name&&file.name.length>15?file.name.substring(0,15)+'...':(file.name||''), type:'file', path:file.path, size:file.size }); } });
        });
    } else {
        displayItems = (currentScanData.folderSizes || []).map(f => ({ name:f.name, displayName:f.name.length>15?f.name.substring(0,15)+'...':f.name, type:'folder', path:f.path, size:f.size }));
    }
    displayItems.sort((a,b) => b.size - a.size);
    const actualItems = displayItems.slice(0, Math.min(limit, displayItems.length));
    const names = actualItems.map(i => (i.type === 'folder' ? '📁 ' : '📄 ') + i.displayName);
    const sizes = actualItems.map(i => (i.size / (1024 * 1024 * 1024)));
    currentDisplayItems = actualItems.map(d => ({ name: d.name, displayName: d.displayName, type: d.type, path: d.path, size: d.size }));
    currentDisplayFolders = actualItems.filter(i => i.type==='folder').map(i => ({ name:i.name, path:i.path, size:i.size }));
    window.currentDisplayItems = currentDisplayItems;
    window.barChart.data.labels = names.map(x => String(x));
    window.barChart.data.datasets[0].data = sizes.map(x => Number(x) || 0);
    window.barChart.update();
    setTimeout(() => { if (window.renderBarLabels) window.renderBarLabels(); }, 0);
}

// 保存扫描结果到历史记录
function saveScanToHistory() {
    if (!currentScanData || !selectedFolders.length) return;
    
    const historyKey = selectedFolders[0].path;
    const scanRecord = {
        timestamp: Date.now(),
        data: { ...currentScanData } // 深拷贝数据
    };
    
    // 初始化该路径的历史记录（如果不存在）
    if (!scanHistory[historyKey]) {
        scanHistory[historyKey] = [];
    }
    
    // 添加新的扫描记录
    scanHistory[historyKey].push(scanRecord);
    
    // 限制历史记录数量（保留最近50次扫描）
    if (scanHistory[historyKey].length > 50) {
        scanHistory[historyKey] = scanHistory[historyKey].slice(-50);
    }
    
    // 保存到本地存储
    saveScanHistoryToLocal();
    
    console.log(`保存扫描历史: ${historyKey}`, scanRecord);
}

// 更新所有显示
function updateAllDisplays() {
    if (!currentScanData) return;
    
    // 更新概览卡片
    document.getElementById('totalFiles').textContent = currentScanData.totalFiles.toLocaleString();
    document.getElementById('totalFolders').textContent = currentScanData.totalFolders.toLocaleString();
    document.getElementById('totalSize').textContent = formatBytes(currentScanData.totalSize);
    // 中心文本已移除
    (function(){ try { const list = Array.isArray(currentScanData.allFiles) ? currentScanData.allFiles : []; let m=0; for (let i=0;i<list.length;i++){ const s=list[i].size||0; if (s>m) m=s; } document.getElementById('averageSize').textContent = formatBytes(m); } catch(_) { document.getElementById('averageSize').textContent = '0 B'; } })();
    
    // 更新图表
    updateFileTypeChart();
    updateFolderSizeChart();
    updateTrendChart();
    
    // 更新文件列表
    filteredFiles = currentScanData.largeFiles || [];
    renderCurrentList();
    
    // 启用按钮
    enableButtons();
    
    // 更新上次扫描时间
    updateLastScanStatus();
}

// 清空所有显示
function clearAllDisplays() {
    // 清空概览卡片
    document.getElementById('totalFiles').textContent = '0';
    document.getElementById('totalFolders').textContent = '0';
    document.getElementById('totalSize').textContent = '0 B';
    document.getElementById('averageSize').textContent = '0 B';
    
    // 清空图表
    if (window.pieChart) { window.pieChart.data.datasets[0].data = [0,0,0,0]; window.pieChart.update(); }
    if (window.barChart) { window.barChart.data.labels = []; window.barChart.data.datasets[0].data = []; window.barChart.update(); }
    if (window.sizeTrendChart) {
        window.sizeTrendChart.setOption({ 
            xAxis: { data: [] }, 
            series: [{ data: [] }, { data: [] }] 
        });
    }
    
    // 清空文件列表
    filteredFiles = [];
    updateFileTable();
    
    
}

// 保存扫描历史到本地存储
function saveScanHistoryToLocal() {
    try {
        localStorage.setItem('spacemap-scan-history', JSON.stringify(scanHistory));
        renderTimeline();
    } catch (error) {
        console.error('保存扫描历史失败:', error);
    }
}

// 从本地存储加载扫描历史
function loadScanHistoryFromLocal() {
    try {
        const saved = localStorage.getItem('spacemap-scan-history');
        if (saved) {
            scanHistory = JSON.parse(saved);
        }
        renderTimeline();
    } catch (error) {
        console.error('加载扫描历史失败:', error);
        scanHistory = {};
    }
}
function updateTrendChart(period = 'week') {
    if (!window.sizeTrendChart) return;
    
    if (!selectedFolders.length) {
        return;
    }
    
    const historyKey = selectedFolders[0].path;
    fetch(`/api/scan-history?path=${encodeURIComponent(historyKey)}`)
      .then(r => r.json())
      .then(r => {
        const historyData = (r && r.success && Array.isArray(r.data)) ? r.data : [];
        if (historyData.length === 0) {
          window.sizeTrendChart.setOption({ 
              xAxis: { data: [] }, 
              series: [{ data: [] }],
              graphic: [{
                  type: 'text',
                  left: 'center',
                  top: 'middle',
                  style: {
                      text: '暂无扫描历史\n点击"重新扫描"开始记录',
                      textAlign: 'center',
                      fill: '#94a3b8',
                      fontSize: 14
                  }
              }]
          });
          const scp0 = document.getElementById('sizeChangePill'); if (scp0) { scp0.textContent = '+0%'; scp0.className = 'text-xs font-bold px-2 py-1 rounded-lg bg-white/10 text-gray-400'; }
          const fcp0 = document.getElementById('fileCountChangePill'); if (fcp0) { fcp0.textContent = '0%'; fcp0.className = 'text-xs font-bold px-2 py-1 rounded-lg bg-white/10 text-gray-400'; }
          const fldp0 = document.getElementById('folderCountChangePill'); if (fldp0) { fldp0.textContent = '0%'; fldp0.className = 'text-xs font-bold px-2 py-1 rounded-lg bg-white/10 text-gray-400'; }
          return;
        }

        const dates = historyData.map(r => new Date(r.timestamp).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }));
        const totalSizes = historyData.map(r => (r.data.totalSize / (1024 * 1024 * 1024)).toFixed(2));
        
        window.sizeTrendChart.setOption({
            backgroundColor: 'transparent',
            tooltip: { 
                trigger: 'axis', 
                backgroundColor: 'rgba(15, 23, 42, 0.9)', 
                borderColor: 'rgba(255,255,255,0.1)', 
                textStyle: { color: '#cbd5e1' } 
            },
            grid: { top: '15%', left: '3%', right: '4%', bottom: '3%', containLabel: true },
            xAxis: { 
                data: dates, 
                axisLine: { lineStyle: { color: 'rgba(255, 255, 255, 0.1)' } },
                axisLabel: { color: '#94a3b8', rotate: 0, fontSize: 10 }
            },
            yAxis: { 
                type: 'value', 
                name: '总大小 (GB)', 
                nameTextStyle: { color: '#94a3b8' },
                axisLabel: { formatter: '{value} GB', color: '#94a3b8' },
                splitLine: { lineStyle: { type: 'dashed', color: 'rgba(255, 255, 255, 0.1)' } }
            },
            series: [{ 
                name: '总大小 (GB)', 
                type: 'line', 
                smooth: true, 
                showSymbol: historyData.length === 1,
                symbol: 'circle',
                symbolSize: 8,
                data: totalSizes, 
                lineStyle: { color: '#6366f1', width: 3 }, 
                areaStyle: { 
                    color: new echarts.graphic.LinearGradient(0,0,0,1,[
                        {offset:0,color:'rgba(99, 102, 241, 0.3)'},
                        {offset:1,color:'rgba(99, 102, 241, 0)'}
                    ]) 
                } 
            }],
            graphic: [] // Clear graphic
        });

        const last = historyData[historyData.length - 1].data;
        const prev = historyData.length >= 2 ? historyData[historyData.length - 2].data : null;
        
        function pct(now, before) { if (!before || before === 0) return 0; return ((now - before) / before) * 100; }
        
        const scVal = pct(last.totalSize, prev ? prev.totalSize : 0);
        const fcVal = pct(last.totalFiles, prev ? prev.totalFiles : 0);
        const fdcVal = pct(last.totalFolders, prev ? prev.totalFolders : 0);
        
        const formatPill = (elId, val) => {
            const el = document.getElementById(elId);
            if (!el) return;
            const sign = val > 0 ? '+' : '';
            el.textContent = `${sign}${val.toFixed(1)}%`;
            if (val > 0) el.className = 'text-xs font-bold px-2 py-1 rounded-lg bg-red-500/20 text-red-400';
            else if (val < 0) el.className = 'text-xs font-bold px-2 py-1 rounded-lg bg-green-500/20 text-green-400';
            else el.className = 'text-xs font-bold px-2 py-1 rounded-lg bg-white/10 text-gray-300';
        };

        formatPill('sizeChangePill', scVal);
        formatPill('fileCountChangePill', fcVal);
        formatPill('folderCountChangePill', fdcVal);
      })
      .catch((e) => { console.error(e); });
}

function renderFolderLabels(names) {
    const chartEl = document.getElementById('folderSizeChart');
    const labelsEl = document.getElementById('folderSizeLabels');
    if (!chartEl || !labelsEl) return;
    const chart = window.folderSizeChart;
    const list = names && names.length ? names : currentYAxisNames;
    if (!chart || !list || !list.length) { labelsEl.innerHTML = ''; return; }
    labelsEl.innerHTML = '';
    list.forEach((n) => {
        const y = chart.convertToPixel({ yAxisIndex: 0 }, n);
        const item = document.createElement('div');
        item.style.position = 'absolute';
        item.style.left = '0px';
        item.style.top = `${y - 10}px`;
        item.style.height = '20px';
        item.style.display = 'flex';
        item.style.alignItems = 'center';
        item.style.whiteSpace = 'nowrap';
        item.style.maxWidth = '120px'; // 限制最大宽度
        item.style.textOverflow = 'ellipsis';
        item.style.overflow = 'hidden';
        
        const clean = n.replace(/^📁\s/, '').replace(/^📄\s/, '');
        const src = (window.currentDisplayItems || []).find(d => d.displayName === clean || d.name === clean);
        
        let icon = '<i class="fas fa-folder text-indigo-500 mr-1"></i>';
        if (src && src.type === 'file') {
            const ext = src.name.split('.').pop();
            const fileType = getFileTypeFromExtension(ext);
            const iconClass = getFileIcon(fileType);
            const colorMap = {
                 'video': 'text-indigo-500',
                 'image': 'text-rose-500',
                 'audio': 'text-violet-500',
                 'document': 'text-amber-500',
                 'spreadsheet': 'text-emerald-500',
                 'presentation': 'text-orange-500',
                 'archive': 'text-sky-500',
                 'code': 'text-teal-500'
             };
             const colorClass = colorMap[fileType] || 'text-slate-400';
            icon = `<i class="fas ${iconClass} ${colorClass} mr-1"></i>`;
        }
        
        let displayName = clean;
        if (displayName.length > 10) displayName = displayName.substring(0, 10) + '...';
        item.innerHTML = icon + `<span>${displayName}</span>`;
        item.title = src ? src.name : clean;
        labelsEl.appendChild(item);
    });
}

function updateChartsTheme(isDark) {
    try {
        // Dark Mode: Slate 900/800 base, Light Mode: White base
        const gridColor = isDark ? '#1e293b' : '#e2e8f0'; // Slate 800 vs Slate 200
        const axisLabelColor = isDark ? '#94a3b8' : '#64748b'; // Slate 400 vs Slate 500
        const textColor = isDark ? '#cbd5e1' : '#475569'; // Slate 300 vs Slate 600
        
        // Reference Palette from User Image
        // Video: Indigo (#6366f1), Image: Pink/Rose (#f43f5e), Document: Amber (#f59e0b), Other: Slate (#cbd5e1)
        const chartColors = ['#6366f1', '#f43f5e', '#f59e0b', '#cbd5e1']; 

        if (window.pieChart) {
            if (window.pieChart.options.plugins && window.pieChart.options.plugins.legend) {
                 window.pieChart.options.plugins.legend.labels.color = textColor;
            }
            if (window.pieChart.data.datasets[0]) {
                window.pieChart.data.datasets[0].backgroundColor = chartColors;
                window.pieChart.data.datasets[0].borderColor = isDark ? '#0f1523' : '#ffffff';
                window.pieChart.data.datasets[0].borderWidth = isDark ? 0 : 2;
            }
            window.pieChart.update();
        }

        if (window.barChart) {
            // Solid color for bars as per reference
            const barColor = '#6366f1';

            if (window.barChart.data.datasets[0]) {
                window.barChart.data.datasets[0].backgroundColor = barColor;
            }

            if (window.barChart.options.scales.x) {
                 window.barChart.options.scales.x.ticks = window.barChart.options.scales.x.ticks || {};
                 window.barChart.options.scales.x.ticks.color = axisLabelColor;
                 window.barChart.options.scales.x.grid = window.barChart.options.scales.x.grid || {};
                 window.barChart.options.scales.x.grid.color = gridColor;
            }
            if (window.barChart.options.scales.y) {
                 window.barChart.options.scales.y.ticks = window.barChart.options.scales.y.ticks || {};
                 window.barChart.options.scales.y.ticks.color = axisLabelColor;
                 window.barChart.options.scales.y.grid = window.barChart.options.scales.y.grid || {};
                 window.barChart.options.scales.y.grid.color = gridColor;
            }
            window.barChart.update();
        }

        if (window.sizeTrendChart) {
            const lineColor = '#6366f1';
            const areaStart = 'rgba(99, 102, 241, 0.3)';
            const areaEnd = 'rgba(99, 102, 241, 0)';
            
            const area = { 
                type: 'linear', x: 0, y: 0, x2: 0, y2: 1, 
                colorStops: [ { offset: 0, color: areaStart }, { offset: 1, color: areaEnd } ] 
            };
            
            window.sizeTrendChart.setOption({
                xAxis: { 
                    splitLine: { lineStyle: { color: gridColor } },
                    axisLabel: { color: axisLabelColor },
                    axisLine: { lineStyle: { color: gridColor } }
                },
                yAxis: [{ 
                    splitLine: { lineStyle: { color: gridColor } }, 
                    axisLabel: { color: axisLabelColor } 
                }],
                series: [{ 
                    lineStyle: { color: lineColor }, 
                    itemStyle: { color: lineColor }, 
                    areaStyle: { color: area } 
                }],
                tooltip: {
                    backgroundColor: isDark ? 'rgba(15, 23, 42, 0.9)' : 'rgba(255, 255, 255, 0.95)',
                    borderColor: isDark ? 'rgba(255,255,255,0.1)' : '#e2e8f0',
                    textStyle: { color: textColor },
                    extraCssText: isDark ? '' : 'box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1);'
                }
            });
        }
    } catch (_) {}
}

// 生成趋势日期
function generateTrendDates(period) {
    const dates = [];
    const now = new Date();
    
    for (let i = 6; i >= 0; i--) {
        const date = new Date(now);
        if (period === 'week') {
            date.setDate(date.getDate() - i);
        } else if (period === 'month') {
            date.setDate(date.getDate() - i * 7);
        } else if (period === 'year') {
            date.setMonth(date.getMonth() - i);
        }
        dates.push(date.toISOString().split('T')[0]);
    }
    
    return dates;
}

// 生成趋势数据
function generateTrendData(length, baseValue) {
    const data = [];
    for (let i = 0; i < length; i++) {
        const variation = (Math.random() - 0.5) * 0.1; // ±5% 变化
        data.push((baseValue * (1 + variation)).toFixed(2));
    }
    return data;
}

// 更新文件表格
function updateFileTable() {
    console.log('updateFileTable 被调用');
    console.log('filteredFiles 数量:', filteredFiles.length);
    
    const tbody = document.getElementById('fileTableBody');
    if (!tbody) return;
    
    // Calculate range for "Load More" style (accumulate items)
    const endIndex = currentPage * itemsPerPage;
    const pageFiles = filteredFiles.slice(0, endIndex);
    
    console.log('显示文件数量:', pageFiles.length);
    
    if (pageFiles.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="px-5 py-8 text-center text-gray-500">
                    <i class="fas fa-search text-4xl mb-2 block"></i>
                    没有找到匹配的文件
                </td>
            </tr>
        `;
        updateLoadMoreButton(0, 0);
        return;
    }
    
    tbody.innerHTML = pageFiles.map(file => {
        // Get icon color
        const isDark = document.documentElement.classList.contains('dark');
        const color = getThemeFileIconColor(file.type, true);
        const isSelected = selectedFilePaths.has(file.path);
        
        // Determine styles based on theme
        let iconContainerStyle = '';
        let iconStyle = '';
        
        if (isDark) {
            // Dark Mode: Transparent bg, Colored Icon
            iconContainerStyle = 'background-color: rgba(255,255,255,0.05)';
            iconStyle = `color: ${color} !important`;
        } else {
            // Light Mode: Solid Colored bg, White Icon
            iconContainerStyle = `background-color: ${color} !important; box-shadow: 0 2px 4px rgba(0,0,0,0.15)`;
            iconStyle = 'color: #ffffff !important';
        }

        return `
        <tr class="border-t border-white/5 hover:bg-white/5 transition-colors group" data-file-path="${file.path}">
            <td class="px-3 py-2 w-12 text-center">
                <input type="checkbox" class="file-select rounded border-gray-600 bg-gray-800 text-accent-primary focus:ring-offset-0 focus:ring-1 focus:ring-accent-primary" data-file-path="${file.path}" onchange="toggleFileSelection(this)" ${isSelected ? 'checked' : ''}>
            </td>
            <td class="px-3 py-2">
                <div class="flex items-center">
                    <div class="w-6 h-6 rounded-lg flex items-center justify-center mr-2 transition-colors" style="${iconContainerStyle}">
                        <i class="fas ${getFileIcon(file.type)}" style="${iconStyle}"></i>
                    </div>
                    <span class="text-xs font-medium text-gray-200 truncate max-w-[200px]" title="${file.name}">
                        ${file.name || '未知文件'}
                    </span>
                </div>
            </td>
            <td class="px-3 py-2">
                <div class="text-xs text-gray-500 truncate max-w-[300px]" title="${file.path}">${file.path}</div>
            </td>
            <td class="px-3 py-2 font-mono text-xs text-gray-300">
                ${formatBytes(file.size)}
            </td>
            <td class="px-3 py-2">
                <span class="bg-white/5 text-gray-400 text-xs px-2 py-1 rounded-md border border-white/5">
                    ${getFileTypeName(file.type)}
                </span>
            </td>
            <td class="px-3 py-2 text-right">
                <button class="text-gray-500 hover:text-red-400 transition-colors p-2 rounded-lg hover:bg-white/5" title="删除" onclick="deleteFile('${file.path}','${file.name}')">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        </tr>
    `}).join('');
    
    updateLoadMoreButton(filteredFiles.length, pageFiles.length);
    refreshSelectAllState();
    updateBulkDeleteButton();
}

// 更新分页
function updatePagination() {
    const totalPages = Math.ceil(filteredFiles.length / itemsPerPage);
    const pagination = document.getElementById('pagination');
    const pageInfo = document.getElementById('pageInfo');
    const paginationButtons = document.getElementById('paginationButtons');
    if (!pagination || totalPages <= 1) { if (pagination) pagination.classList.add('hidden'); return; }
    pagination.classList.remove('hidden');
    const startIndex = (currentPage - 1) * itemsPerPage + 1;
    const endIndex = Math.min(currentPage * itemsPerPage, filteredFiles.length);
    if (pageInfo) { pageInfo.textContent = `显示 ${startIndex} 至 ${endIndex}，共 ${filteredFiles.length} 条`; pageInfo.className = "text-sm text-gray-400"; }
    
    let buttons = '';
    
    // 上一页按钮
    buttons += `
        <button onclick="changePage(${currentPage - 1})" 
                class="w-8 h-8 flex items-center justify-center rounded border border-white/10 text-gray-400 hover:border-accent-primary hover:text-accent-primary transition-colors ${currentPage === 1 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5'}"
                ${currentPage === 1 ? 'disabled' : ''}>
            <i class="fas fa-chevron-left text-xs"></i>
        </button>
    `;
    
    // 页码按钮
    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
            buttons += `
                <button onclick="changePage(${i})" 
                        class="w-8 h-8 flex items-center justify-center rounded border ${i === currentPage ? 'border-accent-primary bg-accent-primary text-white shadow-lg shadow-accent-primary/20' : 'border-white/10 text-gray-400 hover:border-accent-primary hover:text-accent-primary hover:bg-white/5'} transition-all">
                    ${i}
                </button>
            `;
        } else if (i === currentPage - 3 || i === currentPage + 3) {
            buttons += '<span class="px-2 text-gray-500">...</span>';
        }
    }
    
    // 下一页按钮
    buttons += `
        <button onclick="changePage(${currentPage + 1})" 
                class="w-8 h-8 flex items-center justify-center rounded border border-white/10 text-gray-400 hover:border-accent-primary hover:text-accent-primary transition-colors ${currentPage === totalPages ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white/5'}"
                ${currentPage === totalPages ? 'disabled' : ''}>
            <i class="fas fa-chevron-right text-xs"></i>
        </button>
    `;
    
    if (paginationButtons) paginationButtons.innerHTML = buttons;
}

// 切换页面
function changePage(page) {
    const totalPages = Math.ceil(filteredFiles.length / itemsPerPage);
    if (page >= 1 && page <= totalPages) {
        currentPage = page;
        updateFileTable();
    }
}

// 搜索文件
function searchFiles() {
    // 搜索功能已移除
}

// 筛选文件
function filterFiles() {
    const inputEl = document.getElementById('searchInput');
    const searchQuery = inputEl ? (inputEl.value || '').toLowerCase() : '';
    const sizeFilter = document.getElementById('sizeFilter').value;
    
    if (!currentScanData || !currentScanData.largeFiles) {
        return;
    }
    
    let files = currentScanData.largeFiles;
    
    // 按搜索关键词筛选
    if (searchQuery) {
        files = files.filter(file => 
            file.name.toLowerCase().includes(searchQuery) ||
            file.path.toLowerCase().includes(searchQuery)
        );
    }
    
    // 按大小筛选
    if (sizeFilter !== 'all') {
        const minSize = parseInt(sizeFilter) * 1024 * 1024; // MB to bytes
        files = files.filter(file => file.size >= minSize);
    }
    
    filteredFiles = files;
    currentPage = 1;
    updateFileTable();
}


// 加载扫描结果
async function loadScanResults() {
    try {
        const response = await fetch('/api/scan-results');
        const resp = await response.json();
        const data = resp && resp.success ? resp.data : null;
        if (data && data.totalFiles > 0) {
            currentScanData = data;
            updateUI(data);
            enableButtons();
        }
    } catch (error) {
        console.error('加载扫描结果错误:', error);
    }
}

// 关闭文件详情模态框
function closeFileDetailModal() {
    document.getElementById('fileDetailModal').classList.add('hidden');
}

function showFileDetailModal(file) {
    const modal = document.getElementById('fileDetailModal');
    const content = document.getElementById('fileDetailContent');
    if (!modal || !content || !file) return;
    const typeName = getFileTypeName(file.type);
    content.innerHTML = `
        <div class="space-y-3">
            <div class="flex items-center space-x-3">
                <i class="fas ${getFileIcon(file.type)} ${getFileTypeColor(file.type)}"></i>
                <div class="text-lg font-semibold">${file.name || '未知文件'}</div>
            </div>
            <div class="text-sm text-text-secondary">${file.path || ''}</div>
            <div class="text-sm">大小：${formatBytes(file.size || 0)}</div>
            <div class="text-sm">类型：${typeName}</div>
        </div>
    `;
    modal.classList.remove('hidden');
}

// 显示帮助
function showHelp() {
    alert('存储空间器使用说明:\n\n1. 点击"选择文件夹"按钮选择要扫描的路径\n2. 设置扫描深度后开始扫描\n3. 查看概览统计和可视化图表\n4. 在大文件列表中查看详细信息\n5. 支持搜索、筛选和导出功能');
}

// 显示设置
function showSettings() {
    alert('设置功能开发中...');
}

// 工具函数
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function getThemeFileIconColor(type, raw = false) {
    const isDark = document.documentElement.classList.contains('dark');
    // Updated to match Reference Image Palette
    const lightColors = {
        'video': '#6366f1',        // Indigo (Primary Blue/Purple)
        'image': '#f43f5e',        // Rose/Pink
        'document': '#f59e0b',     // Amber/Yellow
        'audio': '#8b5cf6',        // Violet (Complementary)
        'spreadsheet': '#10b981',  // Emerald (Green)
        'presentation': '#f97316', // Orange
        'archive': '#0ea5e9',      // Sky Blue
        'code': '#14b8a6',         // Teal
        'other': '#64748b'         // Slate 500
    };
    
    // Neon / Bright Colors for Dark Mode (slightly brighter versions if needed, or same)
    const darkColors = {
        'video': '#818cf8',        // Indigo-400
        'image': '#fb7185',        // Rose-400
        'document': '#fbbf24',     // Amber-400
        'audio': '#a78bfa',        // Violet-400
        'spreadsheet': '#34d399',  // Emerald-400
        'presentation': '#fb923c', // Orange-400
        'archive': '#38bdf8',      // Sky-400
        'code': '#2dd4bf',         // Teal-400
        'other': '#94a3b8'         // Slate-400
    };

    const colors = isDark ? darkColors : lightColors;
    const color = colors[type] || colors['other'];
    
    if (raw) return color;
    // Force !important for inline styles just in case
    return color + ' !important';
}

function getFileTypeName(type) {
    const typeNames = {
        'image': '图片',
        'video': '视频',
        'audio': '音频',
        'document': '文档',
        'spreadsheet': '表格',
        'presentation': '演示文稿',
        'archive': '压缩包',
        'code': '代码',
        'other': '其他'
    };
    return typeNames[type] || '其他';
}

function getFileTypeColor(type) {
    const colors = {
        'image': 'text-rose-500',
        'video': 'text-indigo-500',
        'audio': 'text-violet-500',
        'document': 'text-amber-500',
        'spreadsheet': 'text-emerald-500',
        'presentation': 'text-orange-500',
        'archive': 'text-sky-500',
        'code': 'text-teal-500',
        'other': 'text-slate-400'
    };
    return colors[type] || 'text-slate-400';
}

function getFileTypeFromExtension(ext) {
    if (!ext) return 'other';
    const e = ext.toLowerCase();
    const typeMap = {
        // Video
        'mp4': 'video', 'avi': 'video', 'mkv': 'video', 'mov': 'video', 'wmv': 'video', 'flv': 'video', 
        'webm': 'video', 'm4v': 'video', '3gp': 'video', 'ts': 'video', 'mts': 'video', 'm2ts': 'video',
        
        // Audio
        'mp3': 'audio', 'wav': 'audio', 'flac': 'audio', 'aac': 'audio', 'ogg': 'audio', 'm4a': 'audio', 
        'wma': 'audio', 'aiff': 'audio', 'ape': 'audio',
        
        // Image
        'jpg': 'image', 'jpeg': 'image', 'png': 'image', 'gif': 'image', 'bmp': 'image', 'svg': 'image', 
        'webp': 'image', 'tiff': 'image', 'ico': 'image', 'heic': 'image', 'raw': 'image', 'psd': 'image',
        
        // Document
        'pdf': 'document', 'doc': 'document', 'docx': 'document', 'txt': 'document', 'rtf': 'document', 
        'odt': 'document', 'md': 'document', 'wps': 'document',
        
        // Spreadsheet
        'xls': 'spreadsheet', 'xlsx': 'spreadsheet', 'csv': 'spreadsheet', 'ods': 'spreadsheet',
        
        // Presentation
        'ppt': 'presentation', 'pptx': 'presentation', 'odp': 'presentation', 'key': 'presentation',
        
        // Archive
        'zip': 'archive', 'rar': 'archive', '7z': 'archive', 'tar': 'archive', 'gz': 'archive', 
        'bz2': 'archive', 'iso': 'archive', 'dmg': 'archive',
        
        // Code
        'js': 'code', 'html': 'code', 'css': 'code', 'py': 'code', 'java': 'code', 'cpp': 'code', 
        'c': 'code', 'php': 'code', 'json': 'code', 'xml': 'code', 'sql': 'code', 'sh': 'code', 
        'bat': 'code', 'go': 'code', 'rs': 'code', 'ts': 'code', 'vue': 'code', 'jsx': 'code', 'tsx': 'code',
        
        // Executable/System
        'exe': 'other', 'msi': 'other', 'deb': 'other', 'rpm': 'other', 'dll': 'other', 'sys': 'other'
    };
    return typeMap[e] || 'other';
}

function getFileIcon(type) {
    const icons = {
        'image': 'fa-file-image',
        'video': 'fa-file-video',
        'audio': 'fa-file-audio',
        'document': 'fa-file-word',
        'spreadsheet': 'fa-file-excel',
        'presentation': 'fa-file-powerpoint',
        'archive': 'fa-file-archive',
        'code': 'fa-file-code',
        'other': 'fa-file'
    };
    return icons[type] || 'fa-file';
}

// 按文件类型筛选文件
function filterFilesByType(fileType) {
    currentFileTypeFilter = fileType;
    
    // 更新文件类型筛选器
    document.getElementById('fileTypeFilter').value = fileType;
    
    // 筛选文件
    filterFiles();
    
    // 更新表格标题
    const title = fileType === 'all' ? '大文件列表' : `${getFileTypeName(fileType)}文件列表`;
    const fileListTitleEl = document.getElementById('fileListTitle');
    if (fileListTitleEl) fileListTitleEl.textContent = title;
}

// 按文件夹过滤文件
async function filterFilesByFolder(folderName) {
    console.log('filterFilesByFolder 被调用，文件夹名称:', folderName);
    console.log('currentScanData:', currentScanData);
    
    if (!currentScanData) return;
    
    try {
        // 找到对应的文件夹路径
        const folder = currentScanData.folderSizes.find(f => f.name === folderName);
        console.log('找到的文件夹:', folder);
        
        if (!folder) {
            console.error('未找到文件夹:', folderName);
            console.error('可用的文件夹:', currentScanData.folderSizes.map(f => f.name));
            return;
        }
        
        console.log('文件夹路径:', folder.path);
        console.log('所有文件数量:', currentScanData.allFiles?.length);
        
        // 显示前几个文件的路径，用于调试
        if (currentScanData.allFiles && currentScanData.allFiles.length > 0) {
            console.log('前5个文件路径示例:');
            currentScanData.allFiles.slice(0, 5).forEach((file, index) => {
                console.log(`${index + 1}. ${file.name} - ${file.path}`);
            });
        }
        
        // 过滤出该文件夹内的文件
        const folderFiles = (currentScanData.allFiles || []).filter(file => {
            const fp = String(file.path || '').replace(/\\/g, '/');
            const cp = String(folder.path || '').replace(/\\/g, '/');
            const isInFolder = fp.startsWith(cp + '/') || fp === cp;
            return isInFolder;
        });
        
        // 如果没找到文件，尝试其他匹配方式
        if (folderFiles.length === 0) {
            console.log('尝试其他匹配方式...');
            const alternativeFiles = (currentScanData.allFiles || []).filter(file => {
                const fp = String(file.path || '').replace(/\\/g, '/');
                const cp = String(folder.path || '').replace(/\\/g, '/');
                const isInFolder = fp.startsWith(cp) || fp.includes(cp);
                return isInFolder;
            });
            if (alternativeFiles.length > 0) {
                alternativeFiles.sort((a, b) => b.size - a.size);
                filteredFiles = alternativeFiles;
                updateFileTable();
            }
            console.log('宽松匹配找到的文件数量:', alternativeFiles.length);
        }
        
        console.log('过滤后的文件数量:', folderFiles.length);
        
        // 按大小排序
        folderFiles.sort((a, b) => b.size - a.size);
        
        // 更新文件列表
        filteredFiles = folderFiles;
        updateFileTable();
        
        // 更新表格标题
        const title = `文件夹 "${folderName}" 内的文件 (${folderFiles.length} 个)`;
        const fileListTitleEl2 = document.getElementById('fileListTitle');
        if (fileListTitleEl2) fileListTitleEl2.textContent = title;
        
        console.log('文件列表更新完成，标题:', title);
        
    } catch (error) {
        console.error('过滤文件夹文件错误:', error);
        showNotification('过滤文件时发生错误', 'error');
    }
}

// Show notification - moved to top
// function showNotification(message, type = 'info') { ... }

// 显示文件详情
function showFileDetails(fileRef) {
    const currentFolderFiles = (currentScanData.allFiles || []).filter(file => {
        const fp = String(file.path || '').replace(/\\/g, '/');
        const cp = String(currentFolderPath || '').replace(/\\/g, '/');
        return fp.startsWith(cp + '/') || fp === cp;
    });
    let file = null;
    if (fileRef) {
        const ref = String(fileRef);
        const isPath = ref.includes('/') || ref.includes('\\');
        if (isPath) {
            const norm = ref.replace(/\\/g, '/');
            file = currentFolderFiles.find(f => (f.path || '').replace(/\\/g, '/') === norm);
        }
        if (!file) {
            file = currentFolderFiles.find(f => f.name === ref);
        }
    }
    if (file) {
        showFileDetailModal(file);
    } else {
        // 最后一层文件点击不提示错误，静默处理
    }
}

// 文件夹钻取功能
function drillDownFolder(folderName) {
    console.log('drillDownFolder 被调用，查找文件夹:', folderName);
    console.log('currentDisplayFolders:', currentDisplayFolders);
    console.log('currentScanData.folderSizes:', currentScanData?.folderSizes);
    
    // 查找文件夹：从多个数据源中查找
    let folder = null;
    
    // 1. 优先从当前显示的文件夹中查找
    if (currentDisplayFolders && currentDisplayFolders.length > 0) {
        folder = currentDisplayFolders.find(f => f.name === folderName);
        console.log('在 currentDisplayFolders 中找到的文件夹:', folder);
    }
    
    // 2. 如果没找到，从原始数据中查找
    if (!folder && currentScanData && currentScanData.folderSizes) {
        folder = currentScanData.folderSizes.find(f => f.name === folderName);
        console.log('在 currentScanData.folderSizes 中找到的文件夹:', folder);
    }
    
    // 3. 如果还是没找到，从所有文件夹数据中查找（包括子文件夹）
    if (!folder && currentScanData && currentScanData.allFolders) {
        folder = currentScanData.allFolders.find(f => f.name === folderName);
        console.log('在 currentScanData.allFolders 中找到的文件夹:', folder);
    }
    
    // 4. 最后尝试从当前路径下的所有文件夹中查找
    if (!folder && currentFolderPath) {
        // 从当前扫描数据中查找当前路径下的文件夹
        const currentPathFolders = (currentScanData.folderSizes || []).filter(f => {
            const fp = String(f.path || '');
            const cp = String(currentFolderPath || '');
            return fp.startsWith(cp + '/') || fp === cp;
        });
        folder = currentPathFolders.find(f => f.name === folderName);
        console.log('在当前路径下找到的文件夹:', folder);
    }
    
    if (!folder) {
        console.error('未找到文件夹:', folderName);
        console.error('可用的文件夹名称:', currentDisplayFolders.map(f => f.name));
        return;
    }
    
    // 将当前状态推入导航栈
    folderNavigationStack.push({
        folderPath: currentFolderPath,
        folderSizes: currentDisplayFolders.length > 0 ? currentDisplayFolders : currentScanData.folderSizes,
        chartTitle: ((document.querySelector('#barChart').closest('.glass') || document.querySelector('#barChart').closest('.card'))?.querySelector('h3')?.textContent) || '文件夹大小排名',
        filteredFiles: filteredFiles,
        fileTableTitle: (document.getElementById('fileListTitle')?.textContent) || '大文件列表'
    });
    
    // 设置当前文件夹路径
    currentFolderPath = folder.path;
    
    // 同时过滤文件和扫描子文件夹
    filterFilesByFolder(folderName);
    scanSubFolders(folder.path);
}

// 扫描子文件夹
async function scanSubFolders(folderPath) {
    try {
        showScanStatus(true);
        
        console.log('开始扫描子文件夹:', folderPath);
        
        const response = await fetch('/api/scan-subfolders', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                folderPath: folderPath,
                limit: parseInt(document.getElementById('folderSizeFilter').value)
            })
        });
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const result = await response.json();
        console.log('扫描子文件夹返回结果:', result);
        
        if (result.folderSizes !== undefined) {
            // 更新文件夹大小图表显示子文件夹
            updateFolderSizeChartWithSubFolders(result.folderSizes, result.files);
            showScanStatus(false);
        } else {
            throw new Error(result.error || '未知错误');
        }
    } catch (error) {
        console.error('扫描子文件夹错误:', error);
        alert('扫描子文件夹失败: ' + error.message);
        showScanStatus(false);
    }
}

// 更新文件夹大小图表显示子文件夹
function updateFolderSizeChartWithSubFolders(subFolders, directFiles) {
    const limit = parseInt(document.getElementById('folderSizeFilter').value);
    
    // 保存当前显示的数据，用于点击判断
    currentDisplayFolders = subFolders || [];
    
    let names;
    let sizes;
    let currentDisplayItems = [];
    let chartTitle = '';
    
    // 合并真实的子文件夹和直接文件（包括压缩包）
    let displayItems = [];
    
    // 添加真实的子文件夹
    if (subFolders && subFolders.length > 0) {
        subFolders.forEach(folder => {
            displayItems.push({
                name: folder.name,
                displayName: folder.name.length > 15 ? folder.name.substring(0, 15) + '...' : folder.name,
                size: folder.size,
                type: 'folder',
                path: folder.path
            });
        });
    }
    
    // 添加直接文件（包括压缩包）
    if (directFiles && directFiles.length > 0) {
        directFiles.forEach(file => {
            displayItems.push({
                name: file.name,
                displayName: file.name.length > 15 ? file.name.substring(0, 15) + '...' : file.name,
                size: file.size,
                type: 'file',
                path: file.path
            });
        });
    }
    
    // 按大小排序
    displayItems.sort((a, b) => b.size - a.size);
    
    const actualDisplayItems = displayItems.slice(0, Math.min(limit, displayItems.length));
    if (actualDisplayItems.length > 0) {
        names = actualDisplayItems.map(item => (item.type === 'folder' ? '📁 ' : '📄 ') + item.displayName);
        sizes = actualDisplayItems.map(item => (item.size / (1024 * 1024 * 1024)));
        currentDisplayItems = actualDisplayItems.map(d => ({ name: d.name, displayName: d.displayName, type: d.type, path: d.path, size: d.size }));
        currentDisplayFolders = actualDisplayItems.filter(i => i.type==='folder').map(i => ({ name:i.name, path:i.path, size:i.size }));
    } else {
        // 如果没有任何内容，显示提示信息
        names = ['此文件夹为空'];
        sizes = [0];
        currentDisplayItems = [{ name: '此文件夹为空', type: 'empty', path: '', size: 0 }];
    }
    
    // 设置图表标题，显示实际项目数量
    const folderName = String(currentFolderPath || '').split(/[\\\/]/).pop();
    chartTitle = `项目大小排名 - ${folderName} (共${displayItems.length}个，显示${actualDisplayItems.length}个)`;
    
    console.log('子文件夹数量:', subFolders ? subFolders.length : 0);
    console.log('直接文件数量:', directFiles ? directFiles.length : 0);
    console.log('子文件夹列表:', subFolders ? subFolders.map(f => f.name) : []);
    console.log('直接文件列表:', directFiles ? directFiles.map(f => f.name) : []);
    console.log('实际显示项目数量:', actualDisplayItems.length);
    console.log('显示的项目名称:', actualDisplayItems.map(d => d.name));
    console.log('显示的项目类型:', actualDisplayItems.map(d => d.type));
    
    // 保存显示项目
    window.currentDisplayItems = currentDisplayItems;
    
    console.log('显示项目:', currentDisplayItems);
    
    // 更新 Chart.js 数据
    if (window.barChart) {
        window.barChart.data.labels = names.map(x => String(x));
        window.barChart.data.datasets[0].data = sizes.map(x => Number(x) || 0);
        window.barChart.update();
        setTimeout(() => { if (window.renderBarLabels) window.renderBarLabels(); }, 0);
    }
    
    // 更新图表标题和添加返回按钮
    const chartEl = document.querySelector('#barChart');
    if (chartEl) {
        const chartContainer = chartEl.closest('.glass') || chartEl.closest('.card') || chartEl.parentElement;
        const chartTitleElement = chartContainer && chartContainer.querySelector('h3');
        if (chartTitleElement) {
            chartTitleElement.innerHTML = `
                <div class="flex items-center justify-between">
                    <span>${chartTitle}</span>
                    <button onclick="goBackToParentFolder()" class="flex items-center px-3 py-1 bg-gray-100 text-gray-600 text-sm rounded-md hover:bg-gray-200 transition-colors">
                        <i class="fas fa-arrow-left mr-1"></i>
                        返回上级
                    </button>
                </div>
            `;
        }
    }

    if (directFiles && directFiles.length) {
        const sorted = directFiles.slice().sort((a, b) => b.size - a.size);
        filteredFiles = sorted;
        renderCurrentList();
        if (currentListMode === 'duplicates') updateDuplicateTable();
        const fileTableTitle = document.getElementById('fileListTitle');
        if (fileTableTitle) {
            fileTableTitle.textContent = `文件夹 "${folderName}" 内的大文件 (${sorted.length} 个)`;
        }
    }
}

// 返回上级文件夹
function goBackToParentFolder() {
    if (folderNavigationStack.length === 0) {
        // 如果没有导航历史，重新加载原始数据
        updateFolderSizeChart();
        const chartEl = document.querySelector('#barChart');
        if (chartEl) {
            const chartTitle = chartEl.closest('.card').querySelector('h3');
            if (chartTitle) chartTitle.innerHTML = '文件夹大小排名';
        }
        currentFolderPath = null;
        return;
    }
    
    // 从导航栈中恢复上一个状态
    const previousState = folderNavigationStack.pop();
    currentFolderPath = previousState.folderPath;
    
    // 恢复图表数据
    const limit = parseInt(document.getElementById('folderSizeFilter').value);
    const allFolders = previousState.folderSizes.sort((a, b) => b.size - a.size);
    // 只取实际存在的文件夹数量
    const folders = allFolders.slice(0, Math.min(limit, allFolders.length));
    
    // Format names consistent with other charts
    const names = folders.map(f => {
        let displayName = f.name;
        if (displayName.length > 15) displayName = displayName.substring(0, 15) + '...';
        return (f.type === 'file' ? '📄 ' : '📁 ') + displayName;
    });
    const sizes = folders.map(f => (f.size / (1024 * 1024 * 1024)));
    currentDisplayItems = folders.map(f => ({ name: f.name, type: 'folder', path: f.path, size: f.size }));
    window.currentDisplayItems = currentDisplayItems;
    
    if (window.barChart) {
        window.barChart.data.labels = names.map(x => String(x));
        window.barChart.data.datasets[0].data = sizes.map(x => Number(x) || 0);
        window.barChart.update();
        setTimeout(() => { if (window.renderBarLabels) window.renderBarLabels(); }, 0);
    }
    
    // 恢复图表标题
    const chartEl = document.querySelector('#barChart');
    if (chartEl) {
        const chartTitle = (chartEl.closest('.glass') || chartEl.closest('.card') || chartEl.parentElement).querySelector('h3');
        if (chartTitle) {
            if (currentFolderPath) {
                const folderName = currentFolderPath.split(/[\\\/]/).pop();
                chartTitle.innerHTML = `
                    <div class="flex items-center justify-between">
                        <span>文件夹大小排名 - ${folderName}</span>
                        <button onclick="goBackToParentFolder()" class="flex items-center px-3 py-1 bg-gray-100 text-gray-600 text-sm rounded-md hover:bg-gray-200 transition-colors">
                            <i class="fas fa-arrow-left mr-1"></i>
                            返回上级
                        </button>
                    </div>
                `;
            } else {
                chartTitle.innerHTML = '文件夹大小排名';
            }
        }
    }
    
    // 恢复文件列表状态
    if (previousState.filteredFiles) {
        filteredFiles = previousState.filteredFiles;
        renderCurrentList();
    }
    
    // 恢复文件列表标题
    if (previousState.fileTableTitle) {
        const fileTableTitle = document.getElementById('fileListTitle');
        fileTableTitle.textContent = previousState.fileTableTitle;
    }
}
// 导出功能已移除
function computeDuplicateFiles() {
    const filesAll = (currentScanData && Array.isArray(currentScanData.allFiles)) ? currentScanData.allFiles : [];
    let scopeFiles = filesAll;
    if (currentFolderPath) {
        const cp = String(currentFolderPath || '').replace(/\\/g,'/');
        scopeFiles = filesAll.filter(f => {
            const fp = String(f.path || '').replace(/\\/g,'/');
            return fp.startsWith(cp + '/') || fp === cp;
        });
    }
    const groups = new Map();
    for (const f of scopeFiles) {
        const key = `${(f.name||'').toLowerCase()}|${f.size||0}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }
    const dups = [];
    groups.forEach(list => { if (list.length > 1) dups.push(...list); });
    dups.sort((a,b) => b.size - a.size);
    return dups;
}

function updateDuplicateTable() {
    duplicateFilteredFiles = computeDuplicateFiles();
    const tbody = document.getElementById('fileTableBody');
    const summary = document.getElementById('listSummary');
    
    // Hide old pagination if it exists
    const pagination = document.getElementById('pagination');
    if (pagination) pagination.classList.add('hidden');

    if (!tbody) return;
    
    if (!duplicateFilteredFiles.length) {
        tbody.innerHTML = `
            <tr>
                <td colspan="6" class="px-5 py-8 text-center text-gray-500">
                    <i class="fas fa-copy text-4xl mb-2 block"></i>
                    暂无重复文件
                </td>
            </tr>
        `;
        if (summary) summary.textContent = '';
        updateLoadMoreButton(0, 0);
        return;
    }
    
    if (summary) {
        const groupsSet = new Set();
        duplicateFilteredFiles.forEach(f => groupsSet.add(`${(f.name||'').toLowerCase()}|${f.size||0}`));
        summary.textContent = `重复组 ${groupsSet.size} 组，文件 ${duplicateFilteredFiles.length} 个`;
    }
    
    // Use cumulative pagination for "Load More" style
    const endIndex = dupCurrentPage * dupItemsPerPage;
    const pageFiles = duplicateFilteredFiles.slice(0, endIndex);
    
    tbody.innerHTML = pageFiles.map(file => {
        // Get icon color
        const isDark = document.documentElement.classList.contains('dark');
        const color = getThemeFileIconColor(file.type, true);
        const isSelected = selectedFilePaths.has(file.path);
        
        // Determine styles based on theme
        let iconContainerStyle = '';
        let iconStyle = '';
        
        if (isDark) {
            // Dark Mode: Transparent bg, Colored Icon
            iconContainerStyle = 'background-color: rgba(255,255,255,0.05)';
            iconStyle = `color: ${color} !important`;
        } else {
            // Light Mode: Solid Colored bg, White Icon
            iconContainerStyle = `background-color: ${color} !important; box-shadow: 0 2px 4px rgba(0,0,0,0.15)`;
            iconStyle = 'color: #ffffff !important';
        }

        return `
        <tr class="border-t border-white/5 hover:bg-white/5 transition-colors group" data-file-path="${file.path}">
            <td class="px-3 py-2 w-12 text-center">
                <input type="checkbox" class="file-select rounded border-gray-600 bg-gray-800 text-accent-primary focus:ring-offset-0 focus:ring-1 focus:ring-accent-primary" data-file-path="${file.path}" onchange="toggleFileSelection(this)" ${isSelected ? 'checked' : ''}>
            </td>
            <td class="px-3 py-2">
                <div class="flex items-center">
                    <div class="w-6 h-6 rounded-lg flex items-center justify-center mr-2 transition-colors" style="${iconContainerStyle}">
                        <i class="fas ${getFileIcon(file.type)}" style="${iconStyle}"></i>
                    </div>
                    <span class="text-xs font-medium text-gray-200 truncate max-w-[200px]" title="${file.name}">
                        ${file.name || '未知文件'}
                    </span>
                </div>
            </td>
            <td class="px-3 py-2">
                <div class="text-xs text-gray-500 truncate max-w-[300px]" title="${file.path}">${file.path}</div>
            </td>
            <td class="px-3 py-2 font-mono text-xs text-gray-300">
                ${formatBytes(file.size)}
            </td>
            <td class="px-3 py-2">
                <span class="bg-white/5 text-gray-400 text-xs px-2 py-1 rounded-md border border-white/5">
                    ${getFileTypeName(file.type)}
                </span>
            </td>
            <td class="px-3 py-2 text-right">
                <button class="text-gray-500 hover:text-red-400 transition-colors p-2 rounded-lg hover:bg-white/5" title="删除" onclick="deleteFile('${file.path}','${file.name}')">
                    <i class="fas fa-trash-alt"></i>
                </button>
            </td>
        </tr>
    `}).join('');
    
    updateLoadMoreButton(duplicateFilteredFiles.length, pageFiles.length);
    refreshSelectAllState();
    updateBulkDeleteButton();
}

function changeDupPage(page) {
    const totalPages = Math.ceil(duplicateFilteredFiles.length / dupItemsPerPage);
    if (page >= 1 && page <= totalPages) { dupCurrentPage = page; updateDuplicateTable(); }
}
function renderCurrentList() {
    const titleEl = document.getElementById('fileListTitle');
    const sizeFilterEl = document.getElementById('sizeFilter');
    const summaryEl = document.getElementById('listSummary');
    if (currentListMode === 'large') {
        if (titleEl) titleEl.textContent = '大文件列表';
        if (sizeFilterEl) sizeFilterEl.style.display = '';
        if (summaryEl) summaryEl.textContent = '';
        updateFileTable();
    } else {
        if (titleEl) titleEl.textContent = '重复文件列表';
        if (sizeFilterEl) sizeFilterEl.style.display = 'none';
        updateDuplicateTable();
    }
}

function switchListMode() {
    const sel = document.getElementById('listMode');
    currentListMode = sel ? sel.value : 'large';
    currentPage = 1;
    dupCurrentPage = 1;
    renderCurrentList();
}

function toggleFileSelection(cb) {
    const p = cb && cb.dataset ? cb.dataset.filePath : '';
    if (!p) return;
    if (cb.checked) selectedFilePaths.add(p); else selectedFilePaths.delete(p);
    updateBulkDeleteButton();
    refreshSelectAllState();
}

function toggleTheme() {
    themeMode = (themeMode === 'dark' ? 'light' : 'dark');
    localStorage.setItem('themeMode', themeMode);
    applyTheme();
}

function toggleDuplicateMode(mode) {
    currentListMode = mode;
    
    // Update button styles
    const btnLarge = document.getElementById('btn-large');
    const btnDup = document.getElementById('btn-dup');
    
    const activeClass = "px-4 py-1.5 rounded-md text-xs font-semibold transition-all bg-white text-indigo-600 shadow-sm ring-1 ring-black/5 dark:bg-accent-primary dark:text-white dark:shadow-lg dark:shadow-accent-primary/20 dark:ring-0";
    const inactiveClass = "px-4 py-1.5 rounded-md text-xs font-medium transition-all text-slate-500 hover:text-slate-900 hover:bg-white/50 dark:text-gray-400 dark:hover:text-white dark:hover:bg-white/5";
    
    if (btnLarge && btnDup) {
        if (mode === 'large') {
            btnLarge.className = activeClass;
            btnDup.className = inactiveClass;
        } else {
            btnDup.className = activeClass;
            btnLarge.className = inactiveClass;
        }
    }
    
    renderCurrentList();
}

function renderTimeline() {
    const container = document.getElementById('timelineContainer');
    if (!container) return;
    
    if (!scanHistory || Object.keys(scanHistory).length === 0) {
        container.innerHTML = '<div class="text-sm text-slate-500">暂无历史记录</div>';
        return;
    }

    // Collect all history items
    let allHistory = [];
    Object.keys(scanHistory).forEach(path => {
        if (Array.isArray(scanHistory[path])) {
            scanHistory[path].forEach(record => {
                allHistory.push({ path, ...record });
            });
        }
    });

    // Sort by timestamp desc
    allHistory.sort((a, b) => b.timestamp - a.timestamp);
    
    // Take top 10
    allHistory = allHistory.slice(0, 10);

    const html = allHistory.map((item, index) => {
        const date = new Date(item.timestamp);
        const timeStr = date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const sizeStr = formatBytes(item.data.totalSize);
        
        return `
            <div class="relative">
                <div class="absolute -left-[25px] top-1 w-4 h-4 rounded-full bg-indigo-500 border-4 border-white dark:border-slate-800"></div>
                <div class="mb-1 flex justify-between items-center">
                    <span class="text-xs font-bold text-indigo-500 bg-indigo-50 dark:bg-indigo-900/30 px-2 py-0.5 rounded">${timeStr}</span>
                    <span class="text-xs text-slate-400">${sizeStr}</span>
                </div>
                <div class="text-sm font-medium text-slate-700 dark:text-slate-200">${item.path}</div>
                <div class="text-xs text-slate-500 mt-1">
                    ${item.data.totalFiles.toLocaleString()} 个文件 · ${item.data.totalFolders.toLocaleString()} 个文件夹
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html || '<div class="text-sm text-slate-500">暂无历史记录</div>';
}

function toggleSelectAll(master) {
    const tbody = document.getElementById('fileTableBody');
    const boxes = tbody ? Array.from(tbody.querySelectorAll('input.file-select')) : [];
    boxes.forEach(cb => {
        cb.checked = master.checked;
        const p = cb.dataset.filePath;
        if (master.checked) selectedFilePaths.add(p); else selectedFilePaths.delete(p);
    });
    updateBulkDeleteButton();
}

function refreshSelectAllState() {
    const tbody = document.getElementById('fileTableBody');
    const boxes = tbody ? Array.from(tbody.querySelectorAll('input.file-select')) : [];
    const master = document.getElementById('selectAllFiles') || document.getElementById('selectAll');
    if (master) master.checked = boxes.length > 0 && boxes.every(cb => cb.checked);
}

function updateBulkDeleteButton() {
    const btn = document.getElementById('bulkDeleteBtn');
    if (!btn) return;
    const count = selectedFilePaths.size;
    btn.disabled = count === 0;
    btn.textContent = count ? `删除选中 (${count})` : '删除选中 (0)';
    btn.classList.toggle('hidden', count === 0);
}

async function bulkDeleteSelected() {
    const paths = Array.from(selectedFilePaths);
    if (!paths.length) return;
    try {
        const resp = await fetch('/api/delete-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths }) });
        const result = await resp.json();
        if (result && result.success) {
            const ok = Array.isArray(result.data && result.data.deleted) ? result.data.deleted : [];
            const fail = Array.isArray(result.data && result.data.failed) ? result.data.failed : [];
            const okSet = new Set(ok);
            selectedFilePaths = new Set(paths.filter(p => !okSet.has(p)));
            if (currentScanData && Array.isArray(currentScanData.allFiles)) {
                currentScanData.allFiles = currentScanData.allFiles.filter(f => !okSet.has(f.path));
                const lf = currentScanData.allFiles.slice().sort((a,b) => b.size - a.size);
                currentScanData.largeFiles = lf.slice(0, 100);
                currentScanData.totalFiles = currentScanData.allFiles.length;
                currentScanData.totalSize = currentScanData.allFiles.reduce((s,f) => s + (f.size || 0), 0);
                const ft = {};
                currentScanData.allFiles.forEach(f => { ft[f.type] = (ft[f.type] || 0) + 1; });
                currentScanData.fileTypes = ft;
            }
            renderCurrentList();
            updateFileTypeChart();
            showNotification(`删除成功 ${ok.length} 个，失败 ${fail.length} 个`, fail.length ? 'error' : 'success');
        } else {
            showNotification((result && result.error) || '删除失败', 'error');
        }
    } catch (e) {
        showNotification('删除接口调用失败', 'error');
    }
    updateBulkDeleteButton();
    refreshSelectAllState();
}
    
