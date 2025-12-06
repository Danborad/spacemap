const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 7082;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVED_FOLDERS_FILE = path.join(DATA_DIR, 'saved-folders.json');
const SCAN_HISTORY_FILE = path.join(DATA_DIR, 'scan-history.json');

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/ui-demo', (req, res) => {
  res.sendFile(path.join(__dirname, 'fpk开发', 'ui.html'));
});

app.get('/api/allowed-paths', (req, res) => {
  const raw = process.env.TRIM_DATA_SHARE_PATHS || '';
  const arr = raw.split(':').filter(Boolean);
  const data = arr.map(p => ({ path: p, name: (p.split(/[\\\/]/).pop() || p) }));
  res.json({ success: true, data });
});

app.get('/api/authorized-content', async (req, res) => {
  try {
    const raw = process.env.TRIM_DATA_SHARE_PATHS || '';
    const roots = raw.split(':').filter(Boolean);
    const list = [];
    for (const base of roots) {
      try {
        const items = await fs.readdir(base, { withFileTypes: true });
        for (const it of items) {
          if (it.isDirectory()) {
            list.push({ path: path.join(base, it.name), name: it.name, base });
          }
        }
      } catch (e) { console.error('读取授权根目录失败:', base, e.message); }
    }
    res.json({ success: true, data: list });
  } catch (e) {
    res.status(500).json({ success: false, error: '读取授权内容失败' });
  }
});

app.get('/api/env', (req, res) => {
  // Try to read version from package.json
  let version = 'unknown';
  try {
    const pkg = require('./package.json');
    version = pkg.version || 'unknown';
  } catch (e) {}
  
  res.json({ 
    success: true, 
    data: { 
      TRIM_DATA_SHARE_PATHS: process.env.TRIM_DATA_SHARE_PATHS || '', 
      PORT: process.env.PORT || '',
      VERSION: version
    } 
  });
});

// 文件类型分类
function getFileType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const typeMap = {
        '.mp4': 'video', '.avi': 'video', '.mkv': 'video', '.mov': 'video', '.wmv': 'video', '.flv': 'video', '.webm': 'video', '.m4v': 'video',
        '.mp3': 'audio', '.wav': 'audio', '.flac': 'audio', '.aac': 'audio', '.ogg': 'audio', '.m4a': 'audio',
        '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.bmp': 'image', '.svg': 'image', '.webp': 'image',
        '.pdf': 'document', '.doc': 'document', '.docx': 'document', '.txt': 'document', '.rtf': 'document',
        '.zip': 'archive', '.rar': 'archive', '.7z': 'archive', '.tar': 'archive', '.gz': 'archive',
        '.exe': 'executable', '.msi': 'executable', '.deb': 'executable', '.rpm': 'executable',
        '.js': 'code', '.html': 'code', '.css': 'code', '.py': 'code', '.java': 'code', '.cpp': 'code', '.c': 'code', '.php': 'code'
    };
    return typeMap[ext] || 'other';
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function ensureDataFile(filePath, defaultValue) {
    try {
        await fs.stat(filePath);
    } catch (e) {
        try {
            await fs.mkdir(DATA_DIR, { recursive: true });
        } catch (_) {}
        await fs.writeFile(filePath, JSON.stringify(defaultValue));
    }
}

async function readJSON(filePath, defaultValue) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        return JSON.parse(data);
    } catch (e) {
        return defaultValue;
    }
}

async function writeJSON(filePath, value) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(value));
}

// 扫描目录（递归扫描所有文件）
async function scanDirectory(dirPath, maxDepth = 50, files = [], folders = []) {
    
    async function traverse(currentPath, depth) {
        if (depth >= maxDepth) return 0;
        
        let dirSize = 0;
        try {
            const items = await fs.readdir(currentPath, { withFileTypes: true });
            
            for (const item of items) {
                const fullPath = path.join(currentPath, item.name);
                
                try {
                    if (item.isDirectory()) {
                        // 递归扫描子文件夹
                        const subDirSize = await traverse(fullPath, depth + 1);
                        dirSize += subDirSize;
                        
                        // 添加当前文件夹信息
                        folders.push({
                            name: item.name,
                            path: fullPath,
                            size: subDirSize
                        });
                    } else if (item.isFile()) {
                        const stats = await fs.stat(fullPath);
                        dirSize += stats.size;
                        
                        files.push({
                            name: item.name,
                            path: fullPath,
                            size: stats.size,
                            type: getFileType(item.name),
                            modified: stats.mtime
                        });
                    }
                } catch (error) {
                    console.error(`Error processing ${fullPath}:`, error.message);
                }
            }
        } catch (error) {
            console.error(`Error reading directory ${currentPath}:`, error.message);
        }
        return dirSize;
    }

    const totalSize = await traverse(dirPath, 0);
    return { files, folders, totalSize };
}

// 扫描目录（仅直接子项，用于子文件夹显示）
async function scanDirectoryDirect(dirPath) {
    try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        const files = [];
        const folders = [];
        
        for (const item of items) {
            const fullPath = path.join(dirPath, item.name);
            
            try {
                if (item.isDirectory()) {
                    folders.push({
                        name: item.name,
                        path: fullPath,
                        size: 0 // 稍后通过 calculateFolderSize 计算
                    });
                } else if (item.isFile()) {
                    const stats = await fs.stat(fullPath);
                    files.push({
                        name: item.name,
                        path: fullPath,
                        size: stats.size,
                        type: getFileType(item.name),
                        modified: stats.mtime
                    });
                }
            } catch (error) {
                console.error(`Error processing ${fullPath}:`, error.message);
            }
        }
        
        return { files, folders };
    } catch (error) {
        console.error(`Error reading directory ${dirPath}:`, error.message);
        return { files: [], folders: [] };
    }
}

// 计算文件夹大小的函数（递归计算整个文件夹树的大小）
async function calculateFolderSize(dirPath) {
    try {
        const items = await fs.readdir(dirPath, { withFileTypes: true });
        let totalSize = 0;
        
        for (const item of items) {
            const fullPath = path.join(dirPath, item.name);
            
            try {
                if (item.isFile()) {
                    const stats = await fs.stat(fullPath);
                    totalSize += stats.size;
                } else if (item.isDirectory()) {
                    // 递归计算子文件夹的大小
                    const subFolderSize = await calculateFolderSize(fullPath);
                    totalSize += subFolderSize;
                }
            } catch (error) {
                console.error(`Error calculating size for ${fullPath}:`, error.message);
            }
        }
        
        return totalSize;
    } catch (error) {
        console.error(`Error calculating folder size for ${dirPath}:`, error.message);
        return 0;
    }
}

// 单个文件夹扫描API（用于子文件夹展示，仅显示直接子项）
app.post('/api/scan-subfolders', async (req, res) => {
  const { folderPath, limit = 10 } = req.body;
  
  if (!folderPath) {
    return res.status(400).json({ error: 'Folder path is required' });
  }
  
  try {
    console.log(`扫描子文件夹: ${folderPath}`);
    const result = await scanDirectoryDirect(folderPath);
    const allFolders = result.folders;
    const allFiles = result.files;
    
    console.log(`找到 ${allFolders.length} 个文件夹, ${allFiles.length} 个文件`);
    
    // 安全地计算每个文件夹的大小
    const foldersWithSize = await Promise.all(
      allFolders.map(async folder => {
        try {
          const size = await calculateFolderSize(folder.path);
          return {
            ...folder,
            size: size || 0
          };
        } catch (error) {
          console.error(`Error calculating size for ${folder.path}:`, error.message);
          return {
            ...folder,
            size: 0
          };
        }
      })
    );
    
    // 排序并限制结果
    const sortedFolders = foldersWithSize
      .sort((a, b) => b.size - a.size)
      .slice(0, limit);
    
    const sortedFiles = allFiles
      .sort((a, b) => b.size - a.size)
      .slice(0, limit * 2);
    
    // 格式化输出
    const formattedFolders = sortedFolders.map(folder => ({
      name: folder.name,
      path: folder.path,
      size: folder.size,
      formattedSize: formatFileSize(folder.size)
    }));
    
    const formattedFiles = sortedFiles.map(file => ({
      name: file.name,
      path: file.path,
      size: file.size,
      formattedSize: formatFileSize(file.size),
      type: file.type,
      modified: file.modified
    }));
    
    console.log(`返回结果: ${formattedFolders.length} 个文件夹, ${formattedFiles.length} 个文件`);
    
    res.json({
      folderSizes: formattedFolders,
      files: formattedFiles,
      allFolders: foldersWithSize,
      allFiles: allFiles
    });
  } catch (error) {
    console.error('子文件夹扫描错误:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/saved-folders', async (req, res) => {
  try {
    await ensureDataFile(SAVED_FOLDERS_FILE, []);
    const list = await readJSON(SAVED_FOLDERS_FILE, []);
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: '读取保存的路径失败' });
  }
});

app.post('/api/saved-folders', async (req, res) => {
  try {
    const { folders } = req.body;
    if (!Array.isArray(folders)) {
      return res.status(400).json({ success: false, error: '无效数据' });
    }
    const uniq = [];
    const seen = new Set();
    folders.forEach(f => {
      if (f && f.path) {
        if (!seen.has(f.path)) {
          seen.add(f.path);
          const name = f.name || (f.path.split(/[\\\/]/).pop() || f.path);
          uniq.push({ path: f.path, name });
        }
      }
    });
    await writeJSON(SAVED_FOLDERS_FILE, uniq);
    res.json({ success: true, data: uniq });
  } catch (error) {
    res.status(500).json({ success: false, error: '保存路径失败' });
  }
});

// 扫描API（多路径扫描）
app.post('/api/scan', async (req, res) => {
  try {
    const { paths, maxDepth = 50 } = req.body;
    
    if (!paths || !Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ success: false, error: '请提供有效的目录路径' });
    }
    
    let allFiles = [];
    let allFolders = [];
    let totalSize = 0;
    
    const normalize = (s) => String(s || '').replace(/\\/g, '/');
    const isReadableDir = async (p) => {
      try {
        const st = await fs.stat(p);
        if (!st.isDirectory()) return false;
        await fs.readdir(p);
        return true;
      } catch (_) {
        return false;
      }
    };
    const unauthorized = [];
    for (const dirPath of paths) {
      if (!(await isReadableDir(dirPath))) {
        unauthorized.push(dirPath);
        continue;
      }
      try {
        console.log(`开始扫描路径: ${dirPath}`);
        // 直接传入 allFiles 和 allFolders 进行填充，避免大数组合并开销
        const result = await scanDirectory(dirPath, maxDepth, allFiles, allFolders);
        
        totalSize += result.totalSize;
        
        console.log(`路径 ${dirPath} 扫描完成: ${result.files.length} 个文件 (累计), ${result.folders.length} 个文件夹 (累计), 总大小 ${formatFileSize(result.totalSize)}`);
      } catch (error) {
        console.error(`Error scanning ${dirPath}:`, error.message);
      }
    }
    
    // 按文件类型分类
    const fileTypes = {};
    allFiles.forEach(file => {
      fileTypes[file.type] = (fileTypes[file.type] || 0) + 1;
    });
    
    // 按大小排序文件夹
    allFolders.sort((a, b) => b.size - a.size);
    
    // 按大小排序文件
    allFiles.sort((a, b) => b.size - a.size);
    
    console.log(`整体扫描完成: 总计 ${allFiles.length} 个文件, ${allFolders.length} 个文件夹, 总大小 ${formatFileSize(totalSize)}`);
    
    const data = {
      totalFiles: allFiles.length,
      totalFolders: allFolders.length,
      totalSize,
      averageFileSize: allFiles.length > 0 ? totalSize / allFiles.length : 0,
      fileTypes,
      folderSizes: allFolders.slice(0, 50),
      largeFiles: allFiles.slice(0, 100),
      allFiles,
      allFolders: allFolders
    };
    if (unauthorized.length) {
      console.log('未授权路径，已跳过扫描:', unauthorized);
      data.unauthorized = unauthorized;
    }
    global.scanResults = data;
    try {
      await ensureDataFile(SCAN_HISTORY_FILE, {});
      const allHist = await readJSON(SCAN_HISTORY_FILE, {});
      const time = Date.now();

      // Create lightweight history data (remove large arrays)
      const { allFiles, allFolders, largeFiles, ...historyData } = data;

      if (Array.isArray(paths)) {
        for (const p of paths) {
          const list = Array.isArray(allHist[p]) ? allHist[p] : [];
          list.push({ timestamp: time, data: historyData });
          if (list.length > 100) list.splice(0, list.length - 100);
          allHist[p] = list;
        }
        await writeJSON(SCAN_HISTORY_FILE, allHist);
      }
    } catch (_) {}
    res.json({ success: true, message: '扫描完成', data });
  } catch (error) {
    console.error('扫描错误:', error);
    res.status(500).json({ success: false, error: '扫描过程中发生错误' });
  }
});

// 按文件夹过滤大文件API
app.post('/api/filter-files-by-folder', async (req, res) => {
    try {
        const { folderPath, allFiles } = req.body;
        
        if (!folderPath || !allFiles) {
            return res.status(400).json({ success: false, error: '请提供有效的参数' });
        }
        
        // 过滤出指定文件夹内的文件
        const base = String(folderPath || '');
        const prefix = base + path.sep;
        const filteredFiles = allFiles.filter(file => {
            const p = String((file && file.path) || '');
            return p.startsWith(prefix) || p === base;
        });
        
        // 按大小排序
        filteredFiles.sort((a, b) => b.size - a.size);
        
        res.json({
            success: true,
            data: {
                files: filteredFiles,
                count: filteredFiles.length
            }
        });
    } catch (error) {
        console.error('过滤文件错误:', error);
        res.status(500).json({ success: false, error: '过滤文件时发生错误' });
    }
});

// 获取扫描结果
app.get('/api/scan-results', (req, res) => {
    res.json({ success: true, data: global.scanResults || null });
});

app.post('/api/delete-files', async (req, res) => {
  try {
    const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
    if (!paths.length) {
      return res.status(400).json({ success: false, error: '请提供要删除的文件路径列表' });
    }
    const scan = global.scanResults || { allFiles: [] };
    const allowed = new Set((scan.allFiles || []).map(f => f.path));
    const deleted = [];
    const failed = [];
    for (const p of paths) {
      try {
        if (!allowed.has(p)) { failed.push({ path: p, error: '不在扫描结果中' }); continue; }
        const st = await fs.stat(p).catch(() => null);
        if (!st || !st.isFile()) { failed.push({ path: p, error: '不存在或不是文件' }); continue; }
        if (p.startsWith(__dirname)) { failed.push({ path: p, error: '拒绝删除应用目录内文件' }); continue; }
        await fs.unlink(p);
        deleted.push(p);
      } catch (e) {
        failed.push({ path: p, error: e.message });
      }
    }
    res.json({ success: true, data: { deleted, failed } });
  } catch (error) {
    res.status(500).json({ success: false, error: '批量删除时发生错误' });
  }
});

// 搜索文件
app.get('/api/search', async (req, res) => {
    try {
        const { q, type, size } = req.query;
        // 这里可以实现搜索逻辑
        res.json({ success: true, data: [] });
    } catch (error) {
        res.status(500).json({ success: false, error: '搜索时发生错误' });
    }
});

// 获取文件详情
app.get('/api/file-details', async (req, res) => {
    try {
        const { path: filePath } = req.query;
        const stats = await fs.stat(filePath);
        res.json({
            success: true,
            data: {
                name: path.basename(filePath),
                path: filePath,
                size: stats.size,
                modified: stats.mtime,
                created: stats.birthtime
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: '获取文件详情时发生错误' });
    }
});

// 导出CSV
app.get('/api/export/csv', (req, res) => {
  const result = global.scanResults || {};
  const lines = [];
  lines.push('Section,Name,Path,Size,Type,Modified,Formatted');
  (result.folderSizes || []).forEach(f => {
    lines.push(['Folder', f.name, f.path, f.size, '', '', formatFileSize(f.size)].map(v => String(v).replace(/"/g, '""')).join(','));
  });
  (result.largeFiles || []).forEach(file => {
    lines.push(['File', file.name, file.path, file.size, file.type || '', file.modified || '', formatFileSize(file.size)].map(v => String(v).replace(/"/g, '""')).join(','));
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="spacemap_report.csv"');
  res.send(lines.join('\n'));
});

// 导出JSON
app.get('/api/export/json', (req, res) => {
  const result = global.scanResults || {};
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="spacemap_report.json"');
  res.send(JSON.stringify(result, null, 2));
});

app.get('/api/scan-history', async (req, res) => {
  try {
    await ensureDataFile(SCAN_HISTORY_FILE, {});
    const all = await readJSON(SCAN_HISTORY_FILE, {});
    const folderPath = req.query.path;
    if (folderPath) {
      res.json({ success: true, data: all[folderPath] || [] });
    } else {
      res.json({ success: true, data: all });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: '读取扫描历史失败' });
  }
});

app.post('/api/scan-history', async (req, res) => {
  try {
    const folderPath = req.body.path;
    const record = req.body.record || { timestamp: Date.now(), data: req.body.data };
    if (!folderPath || !record || !record.data) {
      return res.status(400).json({ success: false, error: '无效数据' });
    }
    await ensureDataFile(SCAN_HISTORY_FILE, {});
    const all = await readJSON(SCAN_HISTORY_FILE, {});
    const list = Array.isArray(all[folderPath]) ? all[folderPath] : [];
    list.push(record);
    if (list.length > 100) list.splice(0, list.length - 100);
    all[folderPath] = list;
    await writeJSON(SCAN_HISTORY_FILE, all);
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: '保存扫描历史失败' });
  }
});

// 获取文件
app.get('/api/file', (req, res) => {
    const { path: filePath } = req.query;
    res.sendFile(filePath);
});

app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
});
app.get('/api/last-scan', async (req, res) => {
  try {
    await ensureDataFile(SCAN_HISTORY_FILE, {});
    const all = await readJSON(SCAN_HISTORY_FILE, {});
    const p = req.query.path;
    const list = p ? (all[p] || []) : [];
    const last = list.length ? list[list.length - 1] : null;
    res.json({ success: true, data: last });
  } catch (e) {
    res.status(500).json({ success: false, error: '读取最近扫描失败' });
  }
});
