const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const mime = require('mime-types');

const app = express();
const PORT = process.env.PORT || 7082;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SAVED_FOLDERS_FILE = path.join(DATA_DIR, 'saved-folders.json');
const SCAN_HISTORY_FILE = path.join(DATA_DIR, 'scan-history.json');
const PASSWORD_FILE = path.join(DATA_DIR, 'password.json');
const SESSION_COOKIE = 'spacemap_session';
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const sessions = new Map();

// 中间件
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (!origin) return next();
  try {
    const originUrl = new URL(origin);
    if (originUrl.host === req.get('host')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
      return next();
    }
  } catch (_) {}
  return res.status(403).json({ success: false, error: '跨域请求被拒绝' });
});
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use('/api', async (req, res, next) => {
  if (req.path.startsWith('/auth/') || req.path === '/env') return next();
  try {
    const data = await readJSON(PASSWORD_FILE, { password: '' });
    if (!passwordIsSet(data) || requestHasValidSession(req)) return next();
    return res.status(401).json({ success: false, error: '未登录或登录已过期' });
  } catch (e) {
    return res.status(500).json({ success: false, error: '鉴权失败' });
  }
});

app.get('/api/allowed-paths', (req, res) => {
  const arr = getConfiguredRoots();
  const data = arr.map(p => ({ path: p, name: (p.split(/[\\\/]/).pop() || p) }));
  res.json({ success: true, data });
});

app.get('/api/authorized-content', async (req, res) => {
  try {
    const roots = await getAuthorizedRootRealPaths();
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
      VERSION: version
    } 
  });
});

// Auth APIs
app.get('/api/auth/status', async (req, res) => {
    try {
        await ensureDataFile(PASSWORD_FILE, { password: '' });
        const data = await readJSON(PASSWORD_FILE, { password: '' });
        res.json({ success: true, hasPassword: passwordIsSet(data), authenticated: requestHasValidSession(req) });
    } catch (e) {
        res.status(500).json({ success: false, error: 'Failed to check auth status' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { password } = req.body;
        const data = await readJSON(PASSWORD_FILE, { password: '' });
        if (verifyPassword(data, password)) {
            createSession(res);
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, error: '密码错误' });
        }
    } catch (e) {
        res.status(500).json({ success: false, error: '登录失败' });
    }
});

app.post('/api/auth/password', async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const data = await readJSON(PASSWORD_FILE, { password: '' });
        
        if (passwordIsSet(data) && !verifyPassword(data, oldPassword)) {
            return res.status(401).json({ success: false, error: '旧密码错误' });
        }
        
        await writeJSON(PASSWORD_FILE, newPassword ? hashPassword(newPassword) : { password: '' });
        createSession(res);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: '密码更新失败' });
    }
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

function parseCookieHeader(header) {
    return String(header || '').split(';').reduce((acc, part) => {
        const idx = part.indexOf('=');
        if (idx > -1) {
            acc[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
        }
        return acc;
    }, {});
}

function getConfiguredRoots() {
    return (process.env.TRIM_DATA_SHARE_PATHS || '')
        .split(':')
        .map(p => p.trim())
        .filter(Boolean);
}

async function getAuthorizedRootRealPaths() {
    const roots = [];
    for (const root of getConfiguredRoots()) {
        try {
            const realPath = await fs.realpath(path.resolve(root));
            const st = await fs.stat(realPath);
            if (st.isDirectory()) roots.push(realPath);
        } catch (e) {
            console.error('授权根目录不可用:', root, e.message);
        }
    }
    return roots;
}

function isPathInsideRoot(target, root) {
    const rel = path.relative(root, target);
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

async function resolveAuthorizedPath(inputPath, options = {}) {
    if (typeof inputPath !== 'string' || !inputPath.trim() || inputPath.includes('\0')) {
        const err = new Error('无效路径');
        err.status = 400;
        throw err;
    }

    const roots = await getAuthorizedRootRealPaths();
    if (!roots.length) {
        const err = new Error('未配置授权扫描路径');
        err.status = 403;
        throw err;
    }

    const realPath = await fs.realpath(path.resolve(inputPath));
    const root = roots.find(r => isPathInsideRoot(realPath, r));
    if (!root) {
        const err = new Error('路径不在授权范围内');
        err.status = 403;
        throw err;
    }

    const stats = await fs.stat(realPath);
    if (options.directory && !stats.isDirectory()) {
        const err = new Error('路径不是目录');
        err.status = 400;
        throw err;
    }
    if (options.file && !stats.isFile()) {
        const err = new Error('路径不是文件');
        err.status = 400;
        throw err;
    }

    return { path: realPath, stats, root };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    const passwordHash = crypto.scryptSync(String(password || ''), salt, 64).toString('hex');
    return { passwordHash, salt };
}

function passwordIsSet(data) {
    return !!(data && (data.passwordHash || data.password));
}

function verifyPassword(data, password) {
    if (!passwordIsSet(data)) return true;
    if (data.passwordHash && data.salt) {
        const candidate = hashPassword(password, data.salt).passwordHash;
        try {
            return crypto.timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(data.passwordHash, 'hex'));
        } catch (_) {
            return false;
        }
    }
    return data.password === password;
}

function createSession(res) {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MAX_AGE_MS);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`);
}

function requestHasValidSession(req) {
    const cookies = parseCookieHeader(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const expires = token ? sessions.get(token) : null;
    if (!expires || expires < Date.now()) {
        if (token) sessions.delete(token);
        return false;
    }
    sessions.set(token, Date.now() + SESSION_MAX_AGE_MS);
    return true;
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
    const resolved = await resolveAuthorizedPath(folderPath, { directory: true });
    console.log(`扫描子文件夹: ${resolved.path}`);
    const result = await scanDirectoryDirect(resolved.path);
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
    res.status(error.status || 500).json({ error: error.message });
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
    for (const f of folders) {
      if (f && f.path) {
        try {
          const resolved = await resolveAuthorizedPath(f.path, { directory: true });
          if (!seen.has(resolved.path)) {
            seen.add(resolved.path);
            const name = f.name || (resolved.path.split(/[\\\/]/).pop() || resolved.path);
            uniq.push({ path: resolved.path, name });
          }
        } catch (_) {}
      }
    }
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
    const scannedPaths = [];
    
    const unauthorized = [];
    for (const dirPath of paths) {
      try {
        const resolved = await resolveAuthorizedPath(dirPath, { directory: true });
        await fs.readdir(resolved.path);
        scannedPaths.push(resolved.path);
        console.log(`开始扫描路径: ${resolved.path}`);
        // 直接传入 allFiles 和 allFolders 进行填充，避免大数组合并开销
        const result = await scanDirectory(resolved.path, maxDepth, allFiles, allFolders);
        
        totalSize += result.totalSize;
        
        console.log(`路径 ${resolved.path} 扫描完成: ${result.files.length} 个文件 (累计), ${result.folders.length} 个文件夹 (累计), 总大小 ${formatFileSize(result.totalSize)}`);
      } catch (error) {
        unauthorized.push(dirPath);
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

      // Keep all data for history to enable client-side drill-down
      const historyData = data;

      if (scannedPaths.length) {
        for (const p of scannedPaths) {
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

async function deleteFilesByPaths(paths) {
  const scan = global.scanResults || { allFiles: [] };
  const allowed = new Set((scan.allFiles || []).map(f => f.path));
  const appDir = await fs.realpath(__dirname).catch(() => __dirname);
  const deleted = [];
  const failed = [];

  for (const p of paths) {
    try {
      const resolved = await resolveAuthorizedPath(p, { file: true });
      if (!allowed.has(resolved.path)) {
        failed.push({ path: p, error: '不在扫描结果中' });
        continue;
      }
      if (isPathInsideRoot(resolved.path, appDir)) {
        failed.push({ path: p, error: '拒绝删除应用目录内文件' });
        continue;
      }
      await fs.unlink(resolved.path);
      deleted.push(resolved.path);
    } catch (e) {
      failed.push({ path: p, error: e.message });
    }
  }

  return { deleted, failed };
}

app.post('/api/delete-files', async (req, res) => {
  try {
    const paths = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
    if (!paths.length) {
      return res.status(400).json({ success: false, error: '请提供要删除的文件路径列表' });
    }
    res.json({ success: true, data: await deleteFilesByPaths(paths) });
  } catch (error) {
    res.status(500).json({ success: false, error: '批量删除时发生错误' });
  }
});

app.delete('/api/file', async (req, res) => {
  try {
    const filePath = req.body && req.body.filePath;
    if (!filePath) {
      return res.status(400).json({ success: false, error: '请提供要删除的文件路径' });
    }
    res.json({ success: true, data: await deleteFilesByPaths([filePath]) });
  } catch (error) {
    res.status(500).json({ success: false, error: '删除文件时发生错误' });
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
        const filePath = req.query.path || req.query.filePath;
        const resolved = await resolveAuthorizedPath(filePath, { file: true });
        const extension = path.extname(resolved.path).replace(/^\./, '').toLowerCase();
        const type = getFileType(resolved.path);
        res.json({
            success: true,
            data: {
                name: path.basename(resolved.path),
                path: resolved.path,
                size: resolved.stats.size,
                sizeFormatted: formatFileSize(resolved.stats.size),
                type,
                extension,
                mimeType: mime.lookup(resolved.path) || 'application/octet-stream',
                modified: resolved.stats.mtime,
                created: resolved.stats.birthtime
            }
        });
    } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message || '获取文件详情时发生错误' });
    }
});

// 导出CSV
app.get('/api/export/csv', (req, res) => {
  const result = global.scanResults || {};
  const lines = [];
  const csvEscape = (value) => {
    const text = String(value == null ? '' : value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  lines.push('Section,Name,Path,Size,Type,Modified,Formatted');
  (result.folderSizes || []).forEach(f => {
    lines.push(['Folder', f.name, f.path, f.size, '', '', formatFileSize(f.size)].map(csvEscape).join(','));
  });
  (result.largeFiles || []).forEach(file => {
    lines.push(['File', file.name, file.path, file.size, file.type || '', file.modified || '', formatFileSize(file.size)].map(csvEscape).join(','));
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

function summarizeScanRecord(record) {
  const data = (record && record.data) || {};
  return {
    timestamp: record && record.timestamp,
    data: {
      totalFiles: data.totalFiles || 0,
      totalFolders: data.totalFolders || 0,
      totalSize: data.totalSize || 0,
      averageFileSize: data.averageFileSize || 0,
      fileTypes: data.fileTypes || {}
    }
  };
}

function getDirectChildFoldersFromSnapshot(data, rootPath) {
  if (!rootPath || !Array.isArray(data && data.allFolders)) return null;
  return data.allFolders
    .filter(item => isDirectChildPath(item.path, rootPath))
    .sort((a, b) => (b.size || 0) - (a.size || 0))
    .slice(0, 50);
}

function createDisplaySnapshot(data, rootPath) {
  if (!data) return null;
  const directFolders = getDirectChildFoldersFromSnapshot(data, rootPath);
  return {
    totalFiles: data.totalFiles || 0,
    totalFolders: data.totalFolders || 0,
    totalSize: data.totalSize || 0,
    averageFileSize: data.averageFileSize || 0,
    fileTypes: data.fileTypes || {},
    folderSizes: directFolders || (Array.isArray(data.folderSizes)
      ? data.folderSizes
      : (Array.isArray(data.allFolders) ? data.allFolders.slice(0, 50) : [])),
    largeFiles: Array.isArray(data.largeFiles)
      ? data.largeFiles
      : (Array.isArray(data.allFiles) ? data.allFiles.slice(0, 100) : [])
  };
}

function createDisplayRecord(record, rootPath) {
  if (!record) return null;
  return {
    timestamp: record.timestamp,
    data: createDisplaySnapshot(record.data, rootPath)
  };
}

function summarizeHistoryCollection(history) {
  const out = {};
  Object.entries(history || {}).forEach(([folderPath, records]) => {
    out[folderPath] = Array.isArray(records) ? records.map(summarizeScanRecord) : [];
  });
  return out;
}

app.get('/api/scan-history', async (req, res) => {
  try {
    await ensureDataFile(SCAN_HISTORY_FILE, {});
    const all = await readJSON(SCAN_HISTORY_FILE, {});
    const folderPath = req.query.path;
    const summaryOnly = req.query.summary === '1' || req.query.summary === 'true';
    if (folderPath) {
      const list = all[folderPath] || [];
      res.json({ success: true, data: summaryOnly ? list.map(summarizeScanRecord) : list });
    } else {
      res.json({ success: true, data: summaryOnly ? summarizeHistoryCollection(all) : all });
    }
  } catch (error) {
    res.status(500).json({ success: false, error: '读取扫描历史失败' });
  }
});

app.get('/api/scan-history-record', async (req, res) => {
  try {
    await ensureDataFile(SCAN_HISTORY_FILE, {});
    const all = await readJSON(SCAN_HISTORY_FILE, {});
    const folderPath = req.query.path;
    const timestamp = Number(req.query.timestamp);
    const list = folderPath ? (all[folderPath] || []) : [];
    const record = list.find(item => Number(item && item.timestamp) === timestamp) || null;
    res.json({ success: true, data: record });
  } catch (error) {
    res.status(500).json({ success: false, error: '读取历史快照失败' });
  }
});

function isDirectChildPath(childPath, parentPath) {
  const child = String(childPath || '').replace(/\\/g, '/');
  const parent = String(parentPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!child || !parent || child === parent || !child.startsWith(parent + '/')) return false;
  const rel = child.slice(parent.length + 1);
  return !!rel && !rel.includes('/');
}

function findLatestHistoryRecordForFolder(history, folderPath, preferredScanPath) {
  if (!history || !folderPath) return null;
  if (preferredScanPath && Array.isArray(history[preferredScanPath])) {
    const list = history[preferredScanPath];
    return list.length ? list[list.length - 1] : null;
  }

  let latest = null;
  Object.entries(history).forEach(([scanRoot, records]) => {
    if (!Array.isArray(records) || !records.length) return;
    const root = String(scanRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const folder = String(folderPath || '').replace(/\\/g, '/');
    if (folder === root || folder.startsWith(root + '/')) {
      const candidate = records[records.length - 1];
      if (!latest || Number(candidate.timestamp || 0) > Number(latest.timestamp || 0)) {
        latest = candidate;
      }
    }
  });
  return latest;
}

app.get('/api/folder-children', async (req, res) => {
  try {
    const folderPath = req.query.path;
    const scanPath = req.query.scanPath;
    const limit = Math.max(1, Math.min(Number(req.query.limit || 100), 500));
    const resolved = await resolveAuthorizedPath(folderPath, { directory: true });

    await ensureDataFile(SCAN_HISTORY_FILE, {});
    const all = await readJSON(SCAN_HISTORY_FILE, {});
    const record = findLatestHistoryRecordForFolder(all, resolved.path, scanPath);
    const data = record && record.data ? record.data : {};
    const allFolders = Array.isArray(data.allFolders) ? data.allFolders : [];
    const allFiles = Array.isArray(data.allFiles) ? data.allFiles : [];

    const subFolders = allFolders
      .filter(item => isDirectChildPath(item.path, resolved.path))
      .sort((a, b) => (b.size || 0) - (a.size || 0));

    const directFiles = allFiles
      .filter(item => isDirectChildPath(item.path, resolved.path))
      .sort((a, b) => (b.size || 0) - (a.size || 0));

    const folderFiles = allFiles
      .filter(item => {
        const fp = String(item.path || '').replace(/\\/g, '/');
        const cp = String(resolved.path || '').replace(/\\/g, '/').replace(/\/+$/, '');
        return fp === cp || fp.startsWith(cp + '/');
      })
      .sort((a, b) => (b.size || 0) - (a.size || 0));

    res.json({
      success: true,
      data: {
        path: resolved.path,
        subFolders: subFolders.slice(0, limit),
        directFiles: directFiles.slice(0, limit),
        folderFiles: folderFiles.slice(0, 100),
        totalSubFolders: subFolders.length,
        totalDirectFiles: directFiles.length,
        totalFiles: folderFiles.length
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({ success: false, error: error.message || '读取文件夹子项失败' });
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
    const exists = list.some(item => Number(item && item.timestamp) === Number(record.timestamp));
    if (!exists) {
      list.push(record);
    }
    if (list.length > 100) list.splice(0, list.length - 100);
    all[folderPath] = list;
    await writeJSON(SCAN_HISTORY_FILE, all);
    res.json({ success: true, data: list });
  } catch (error) {
    res.status(500).json({ success: false, error: '保存扫描历史失败' });
  }
});

// 获取文件
app.get('/api/file', async (req, res) => {
    try {
        const resolved = await resolveAuthorizedPath(req.query.path, { file: true });
        res.sendFile(resolved.path);
    } catch (error) {
        res.status(error.status || 500).json({ success: false, error: error.message || '获取文件失败' });
    }
});

app.listen(PORT, () => {
    console.log(`服务器运行在端口 ${PORT}`);
});
app.get('/api/last-scan', async (req, res) => {
  try {
    await ensureDataFile(SCAN_HISTORY_FILE, {});
    const all = await readJSON(SCAN_HISTORY_FILE, {});
    const p = req.query.path;
    const full = req.query.full === '1' || req.query.full === 'true';
    const list = p ? (all[p] || []) : [];
    const last = list.length ? list[list.length - 1] : null;
    res.json({ success: true, data: full ? last : createDisplayRecord(last, p) });
  } catch (e) {
    res.status(500).json({ success: false, error: '读取最近扫描失败' });
  }
});
