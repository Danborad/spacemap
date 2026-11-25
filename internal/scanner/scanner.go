package scanner

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"spacemap/internal/db"
)

const batchFlushSize = 2000

// ProgressSnapshot 描述当前正在运行的扫描进度，用于状态查询与 SSE 推送。
type ProgressSnapshot struct {
	Running        bool   `json:"running"`
	ScanID         int64  `json:"scanId"`
	RootPath       string `json:"rootPath"`
	CurrentPath    string `json:"currentPath"`
	ScannedFiles   int64  `json:"scannedFiles"`
	ScannedFolders int64  `json:"scannedFolders"`
	ScannedSize    int64  `json:"scannedSize"`
	UniqueSize     int64  `json:"uniqueSize"`
	HardlinkSaved  int64  `json:"hardlinkSaved"`
	ElapsedMs      int64  `json:"elapsedMs"`
	Status         string `json:"status"`
	Message        string `json:"message,omitempty"`
}

// Manager 管理文件扫描生命周期、硬链接去重及 SSE 实时进度订阅。
type Manager struct {
	database *db.DB

	mu          sync.Mutex
	running     bool
	cancelFn    context.CancelFunc
	keepPartial atomic.Bool
	progress    ProgressSnapshot
	subscribers map[chan ProgressSnapshot]struct{}
}

// NewManager 创建扫描管理器。
func NewManager(database *db.DB) *Manager {
	return &Manager{
		database:    database,
		subscribers: make(map[chan ProgressSnapshot]struct{}),
	}
}

// IsRunning 返回当前是否有扫描任务正在执行。
func (m *Manager) IsRunning() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.running
}

// Status 返回最新的扫描进度快照。
func (m *Manager) Status() ProgressSnapshot {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.progress
	if s.Running && s.ElapsedMs == 0 {
		// 由运行循环持续更新
	}
	return s
}

// Subscribe 订阅实时扫描进度事件流。
func (m *Manager) Subscribe() chan ProgressSnapshot {
	ch := make(chan ProgressSnapshot, 16)
	m.mu.Lock()
	m.subscribers[ch] = struct{}{}
	snap := m.progress
	m.mu.Unlock()
	ch <- snap
	return ch
}

// Unsubscribe 取消订阅进度流。
func (m *Manager) Unsubscribe(ch chan ProgressSnapshot) {
	m.mu.Lock()
	if _, ok := m.subscribers[ch]; ok {
		delete(m.subscribers, ch)
		close(ch)
	}
	m.mu.Unlock()
}

func (m *Manager) broadcast(snap ProgressSnapshot) {
	m.mu.Lock()
	m.progress = snap
	subs := make([]chan ProgressSnapshot, 0, len(m.subscribers))
	for ch := range m.subscribers {
		subs = append(subs, ch)
	}
	m.mu.Unlock()

	for _, ch := range subs {
		select {
		case ch <- snap:
		default:
			// 慢客户端跳过旧帧，防止阻塞扫描
		}
	}
}

// StartAsync 异步启动针对 rootPath 的全量扫描，返回创建的 scanID。
func (m *Manager) StartAsync(rootPath string, maxDepth int) (int64, error) {
	if maxDepth <= 0 {
		maxDepth = 64
	}
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return 0, errors.New("已有扫描任务正在运行，请等待完成或先取消")
	}
	ctx, cancel := context.WithCancel(context.Background())
	startedAt := time.Now()
	scanID, err := m.database.CreateScan(rootPath, startedAt.UnixMilli())
	if err != nil {
		cancel()
		m.mu.Unlock()
		return 0, fmt.Errorf("创建扫描记录失败: %w", err)
	}
	m.running = true
	m.cancelFn = cancel
	m.keepPartial.Store(false)
	m.progress = ProgressSnapshot{
		Running:     true,
		ScanID:      scanID,
		RootPath:    rootPath,
		CurrentPath: rootPath,
		Status:      "running",
	}
	m.mu.Unlock()

	m.broadcast(m.progress)
	go m.runScan(ctx, scanID, rootPath, maxDepth, startedAt)
	return scanID, nil
}

// ScanSync 同步执行一次扫描（适用于定时任务或单元测试）。
func (m *Manager) ScanSync(ctx context.Context, rootPath string, maxDepth int) (int64, error) {
	if maxDepth <= 0 {
		maxDepth = 64
	}
	m.mu.Lock()
	if m.running {
		m.mu.Unlock()
		return 0, errors.New("已有扫描任务正在运行")
	}
	scanCtx, cancel := context.WithCancel(ctx)
	startedAt := time.Now()
	scanID, err := m.database.CreateScan(rootPath, startedAt.UnixMilli())
	if err != nil {
		cancel()
		m.mu.Unlock()
		return 0, err
	}
	m.running = true
	m.cancelFn = cancel
	m.keepPartial.Store(false)
	m.progress = ProgressSnapshot{
		Running:     true,
		ScanID:      scanID,
		RootPath:    rootPath,
		CurrentPath: rootPath,
		Status:      "running",
	}
	m.mu.Unlock()

	m.broadcast(m.progress)
	err = m.runScan(scanCtx, scanID, rootPath, maxDepth, startedAt)
	return scanID, err
}

// Cancel 中止当前正在进行的扫描；keepPartial 为 true 时保留已扫描部分数据为部分快照。
func (m *Manager) Cancel(keepPartial bool) bool {
	m.mu.Lock()
	cancel := m.cancelFn
	running := m.running
	if running && cancel != nil {
		m.keepPartial.Store(keepPartial)
	}
	m.mu.Unlock()
	if running && cancel != nil {
		cancel()
		return true
	}
	return false
}

type scanAccumulator struct {
	scanID        int64
	rootPath      string
	maxDepth      int
	startedAt     time.Time
	seenInodes    map[string]struct{}
	folderBuf     []db.FolderItem
	fileBuf       []db.FileItem
	totalSize     int64
	uniqueSize    int64
	hardlinkSaved int64
	totalFiles    int64
	totalFolders  int64
	currentPath   string
	lastBroadcast time.Time
}

func (m *Manager) runScan(ctx context.Context, scanID int64, rootPath string, maxDepth int, startedAt time.Time) error {
	defer func() {
		m.mu.Lock()
		m.running = false
		m.cancelFn = nil
		m.mu.Unlock()
	}()

	acc := &scanAccumulator{
		scanID:        scanID,
		rootPath:      rootPath,
		maxDepth:      maxDepth,
		startedAt:     startedAt,
		seenInodes:    make(map[string]struct{}),
		folderBuf:     make([]db.FolderItem, 0, batchFlushSize),
		fileBuf:       make([]db.FileItem, 0, batchFlushSize),
		currentPath:   rootPath,
		lastBroadcast: startedAt,
	}

	_, _, scanErr := m.walkDir(ctx, acc, rootPath, "", 0)

	keepPartial := errors.Is(scanErr, context.Canceled) && m.keepPartial.Load()
	if scanErr == nil || keepPartial {
		if flushErr := m.flushBuffers(acc); flushErr != nil && scanErr == nil {
			scanErr = flushErr
		}
	}

	status := "completed"
	errMsg := ""
	if scanErr != nil {
		if keepPartial {
			status = "partial"
			errMsg = "用户取消扫描（已保留部分快照）"
		} else if errors.Is(scanErr, context.Canceled) {
			status = "cancelled"
			errMsg = "用户已取消扫描"
		} else {
			status = "failed"
			errMsg = scanErr.Error()
		}
	}

	_ = m.database.CompleteScan(
		scanID,
		rootPath,
		status,
		acc.totalSize,
		acc.uniqueSize,
		acc.hardlinkSaved,
		acc.totalFiles,
		acc.totalFolders,
		errMsg,
	)

	m.broadcast(ProgressSnapshot{
		Running:        false,
		ScanID:         scanID,
		RootPath:       rootPath,
		CurrentPath:    acc.currentPath,
		ScannedFiles:   acc.totalFiles,
		ScannedFolders: acc.totalFolders,
		ScannedSize:    acc.totalSize,
		UniqueSize:     acc.uniqueSize,
		HardlinkSaved:  acc.hardlinkSaved,
		ElapsedMs:      time.Since(startedAt).Milliseconds(),
		Status:         status,
		Message:        errMsg,
	})
	return scanErr
}

func (m *Manager) walkDir(ctx context.Context, acc *scanAccumulator, dirPath, parentPath string, depth int) (size int64, fileCount int64, err error) {
	if ctx.Err() != nil {
		return 0, 0, ctx.Err()
	}
	if depth > acc.maxDepth {
		return 0, 0, nil
	}

	acc.currentPath = dirPath
	m.maybeBroadcast(acc)

	entries, readErr := os.ReadDir(dirPath)
	if readErr != nil {
		// 单个目录无权限读取时不中断全局扫描
		return 0, 0, nil
	}

	var dirSize int64
	var dirFiles int64
	var directSubFolders int64
	var walkErr error

	for _, ent := range entries {
		if ctx.Err() != nil {
			walkErr = ctx.Err()
			break
		}
		// 跳过符号链接，防止循环引用与跨目录重复计算
		if ent.Type()&os.ModeSymlink != 0 {
			continue
		}

		name := ent.Name()
		fullPath := filepath.Join(dirPath, name)

		if ent.IsDir() {
			directSubFolders++
			acc.totalFolders++
			subSize, subFiles, subErr := m.walkDir(ctx, acc, fullPath, dirPath, depth+1)
			dirSize += subSize
			dirFiles += subFiles
			if subErr != nil {
				walkErr = subErr
				break
			}
			continue
		}

		info, statErr := os.Lstat(fullPath)
		if statErr != nil || !info.Mode().IsRegular() {
			continue
		}

		fileSize := info.Size()
		inodeKey := ""
		isDuplicateLink := false
		if st, ok := info.Sys().(*syscall.Stat_t); ok && st != nil {
			inodeKey = fmt.Sprintf("%d:%d", st.Dev, st.Ino)
			if st.Nlink > 1 {
				if _, seen := acc.seenInodes[inodeKey]; seen {
					isDuplicateLink = true
				} else {
					acc.seenInodes[inodeKey] = struct{}{}
				}
			}
		}

		acc.totalFiles++
		acc.totalSize += fileSize
		if isDuplicateLink {
			acc.hardlinkSaved += fileSize
		} else {
			acc.uniqueSize += fileSize
		}

		dirSize += fileSize
		dirFiles++

		ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(name)), ".")
		acc.fileBuf = append(acc.fileBuf, db.FileItem{
			Path:       fullPath,
			ParentPath: dirPath,
			Name:       name,
			Ext:        ext,
			FileType:   ClassifyFile(name),
			Size:       fileSize,
			Mtime:      info.ModTime().Unix(),
			InodeKey:   inodeKey,
		})

		if len(acc.fileBuf)+len(acc.folderBuf) >= batchFlushSize {
			if flushErr := m.flushBuffers(acc); flushErr != nil {
				return 0, 0, flushErr
			}
		}
		m.maybeBroadcast(acc)
	}

	if walkErr != nil && !(errors.Is(walkErr, context.Canceled) && m.keepPartial.Load()) {
		return 0, 0, walkErr
	}

	if depth > 0 {
		acc.folderBuf = append(acc.folderBuf, db.FolderItem{
			Path:        dirPath,
			ParentPath:  parentPath,
			Name:        filepath.Base(dirPath),
			Depth:       depth,
			Size:        dirSize,
			FileCount:   dirFiles,
			FolderCount: directSubFolders,
		})
		if len(acc.fileBuf)+len(acc.folderBuf) >= batchFlushSize {
			if flushErr := m.flushBuffers(acc); flushErr != nil {
				return 0, 0, flushErr
			}
		}
	}

	return dirSize, dirFiles, walkErr
}

func (m *Manager) flushBuffers(acc *scanAccumulator) error {
	if len(acc.folderBuf) == 0 && len(acc.fileBuf) == 0 {
		return nil
	}
	err := m.database.InsertScanBatch(acc.scanID, acc.folderBuf, acc.fileBuf)
	acc.folderBuf = acc.folderBuf[:0]
	acc.fileBuf = acc.fileBuf[:0]
	return err
}

func (m *Manager) maybeBroadcast(acc *scanAccumulator) {
	now := time.Now()
	if now.Sub(acc.lastBroadcast) < 250*time.Millisecond {
		return
	}
	acc.lastBroadcast = now
	m.broadcast(ProgressSnapshot{
		Running:        true,
		ScanID:         acc.scanID,
		RootPath:       acc.rootPath,
		CurrentPath:    acc.currentPath,
		ScannedFiles:   acc.totalFiles,
		ScannedFolders: acc.totalFolders,
		ScannedSize:    acc.totalSize,
		UniqueSize:     acc.uniqueSize,
		HardlinkSaved:  acc.hardlinkSaved,
		ElapsedMs:      now.Sub(acc.startedAt).Milliseconds(),
		Status:         "running",
	})
}

// ClassifyFile 根据扩展名归类文件类型。
func ClassifyFile(filename string) string {
	ext := strings.ToLower(filepath.Ext(filename))
	switch ext {
	case ".mp4", ".avi", ".mkv", ".mov", ".wmv", ".flv", ".webm", ".m4v", ".3gp", ".ts", ".mts", ".m2ts", ".rmvb", ".vob", ".iso":
		return "video"
	case ".mp3", ".wav", ".flac", ".aac", ".ogg", ".m4a", ".wma", ".aiff", ".ape", ".opus":
		return "audio"
	case ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".svg", ".webp", ".tiff", ".tif", ".ico", ".heic", ".raw", ".cr2", ".nef", ".arw", ".psd":
		return "image"
	case ".pdf", ".doc", ".docx", ".txt", ".rtf", ".odt", ".md", ".wps", ".xls", ".xlsx", ".csv", ".ppt", ".pptx", ".epub", ".mobi":
		return "document"
	case ".zip", ".rar", ".7z", ".tar", ".gz", ".bz2", ".xz", ".zst", ".tgz", ".dmg":
		return "archive"
	case ".js", ".jsx", ".tsx", ".html", ".css", ".scss", ".py", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".php", ".json", ".xml", ".yaml", ".yml", ".sql", ".sh":
		return "code"
	default:
		return "other"
	}
}
