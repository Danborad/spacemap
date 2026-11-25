package db

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const MaxDetailedScansPerRoot = 5

// DB 封装 SQLite 数据库操作。
type DB struct {
	conn *sql.DB
}

// SavedFolder 保存的路径项。
type SavedFolder struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// ScanRecord 扫描任务记录摘要。
type ScanRecord struct {
	ID            int64  `json:"id"`
	RootPath      string `json:"rootPath"`
	StartedAt     int64  `json:"startedAt"`
	FinishedAt    int64  `json:"finishedAt"`
	Status        string `json:"status"`
	TotalSize     int64  `json:"totalSize"`
	UniqueSize    int64  `json:"uniqueSize"`
	HardlinkSaved int64  `json:"hardlinkSaved"`
	TotalFiles    int64  `json:"totalFiles"`
	TotalFolders  int64  `json:"totalFolders"`
	ErrorMsg      string `json:"errorMsg,omitempty"`
	HasDetails    bool   `json:"hasDetails"`
}

// FolderItem 目录扫描结果行。
type FolderItem struct {
	Path        string `json:"path"`
	ParentPath  string `json:"parentPath"`
	Name        string `json:"name"`
	Depth       int    `json:"depth"`
	Size        int64  `json:"size"`
	FileCount   int64  `json:"fileCount"`
	FolderCount int64  `json:"folderCount"`
}

// FileItem 文件扫描结果行。
type FileItem struct {
	ID          int64  `json:"id,omitempty"`
	Path        string `json:"path"`
	ParentPath  string `json:"parentPath"`
	Name        string `json:"name"`
	Ext         string `json:"ext"`
	FileType    string `json:"type"`
	Size        int64  `json:"size"`
	Mtime       int64  `json:"mtime"`
	InodeKey    string `json:"inodeKey,omitempty"`
	PartialHash string `json:"partialHash,omitempty"`
	FullHash    string `json:"fullHash,omitempty"`
}

// TypeStat 按类型的统计结果。
type TypeStat struct {
	Type  string `json:"type"`
	Count int64  `json:"count"`
	Size  int64  `json:"size"`
}

// Open 初始化 SQLite 数据库并自动执行建表与旧 JSON 配置迁移。
func Open(dataDir string) (*DB, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, fmt.Errorf("创建数据目录失败: %w", err)
	}
	dbPath := filepath.Join(dataDir, "spacemap.db")
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)", dbPath)
	conn, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	// SQLite 单写入连接池设置避免并发锁冲突
	conn.SetMaxOpenConns(4)
	conn.SetMaxIdleConns(2)

	d := &DB{conn: conn}
	if err := d.migrateSchema(); err != nil {
		_ = conn.Close()
		return nil, err
	}
	d.migrateLegacyJSON(dataDir)
	return d, nil
}

// Close 关闭数据库连接。
func (d *DB) Close() error {
	if d == nil || d.conn == nil {
		return nil
	}
	return d.conn.Close()
}

// Conn 返回底层 sql.DB（仅用于内部高级事务或测试）。
func (d *DB) Conn() *sql.DB {
	return d.conn
}

func (d *DB) migrateSchema() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS settings (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS sessions (
			token TEXT PRIMARY KEY,
			expires_at INTEGER NOT NULL
		);`,
		`CREATE TABLE IF NOT EXISTS scans (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			root_path TEXT NOT NULL,
			started_at INTEGER NOT NULL,
			finished_at INTEGER NOT NULL DEFAULT 0,
			status TEXT NOT NULL,
			total_size INTEGER NOT NULL DEFAULT 0,
			unique_size INTEGER NOT NULL DEFAULT 0,
			hardlink_saved INTEGER NOT NULL DEFAULT 0,
			total_files INTEGER NOT NULL DEFAULT 0,
			total_folders INTEGER NOT NULL DEFAULT 0,
			error_msg TEXT NOT NULL DEFAULT ''
		);`,
		`CREATE INDEX IF NOT EXISTS idx_scans_root_finished ON scans(root_path, finished_at DESC);`,
		`CREATE TABLE IF NOT EXISTS scan_folders (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			scan_id INTEGER NOT NULL,
			path TEXT NOT NULL,
			parent_path TEXT NOT NULL,
			name TEXT NOT NULL,
			depth INTEGER NOT NULL DEFAULT 0,
			size INTEGER NOT NULL DEFAULT 0,
			file_count INTEGER NOT NULL DEFAULT 0,
			folder_count INTEGER NOT NULL DEFAULT 0,
			FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
		);`,
		`CREATE INDEX IF NOT EXISTS idx_folders_scan_parent ON scan_folders(scan_id, parent_path);`,
		`CREATE INDEX IF NOT EXISTS idx_folders_scan_parent_size ON scan_folders(scan_id, parent_path, size DESC);`,
		`CREATE INDEX IF NOT EXISTS idx_folders_scan_size ON scan_folders(scan_id, size DESC);`,
		`CREATE INDEX IF NOT EXISTS idx_folders_scan_path ON scan_folders(scan_id, path);`,
		`CREATE TABLE IF NOT EXISTS scan_type_stats (
			scan_id INTEGER NOT NULL,
			file_type TEXT NOT NULL,
			file_count INTEGER NOT NULL DEFAULT 0,
			total_size INTEGER NOT NULL DEFAULT 0,
			PRIMARY KEY(scan_id, file_type),
			FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
		);`,
		`CREATE TABLE IF NOT EXISTS scan_files (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			scan_id INTEGER NOT NULL,
			path TEXT NOT NULL,
			parent_path TEXT NOT NULL,
			name TEXT NOT NULL,
			ext TEXT NOT NULL DEFAULT '',
			file_type TEXT NOT NULL DEFAULT 'other',
			size INTEGER NOT NULL DEFAULT 0,
			mtime INTEGER NOT NULL DEFAULT 0,
			inode_key TEXT NOT NULL DEFAULT '',
			partial_hash TEXT NOT NULL DEFAULT '',
			full_hash TEXT NOT NULL DEFAULT '',
			FOREIGN KEY(scan_id) REFERENCES scans(id) ON DELETE CASCADE
		);`,
		`CREATE INDEX IF NOT EXISTS idx_files_scan_parent ON scan_files(scan_id, parent_path);`,
		`CREATE INDEX IF NOT EXISTS idx_files_scan_parent_size ON scan_files(scan_id, parent_path, size DESC);`,
		`CREATE INDEX IF NOT EXISTS idx_files_scan_size ON scan_files(scan_id, size DESC);`,
		`CREATE INDEX IF NOT EXISTS idx_files_scan_mtime ON scan_files(scan_id, mtime ASC);`,
		`CREATE INDEX IF NOT EXISTS idx_files_scan_type ON scan_files(scan_id, file_type);`,
		`CREATE INDEX IF NOT EXISTS idx_files_scan_path ON scan_files(scan_id, path);`,
	}
	for _, s := range stmts {
		if _, err := d.conn.Exec(s); err != nil {
			return fmt.Errorf("初始化表结构失败: %w", err)
		}
	}
	// 将上次进程异常中断残留的 running 记录标记为 failed
	_, _ = d.conn.Exec(`UPDATE scans SET status='failed', error_msg='服务异常重启导致中断', finished_at=? WHERE status='running'`, time.Now().UnixMilli())
	go d.warmScanTypeStatsCache()
	return nil
}

func (d *DB) migrateLegacyJSON(dataDir string) {
	// 迁移 saved-folders.json
	if existing, _ := d.GetSetting("saved_folders"); existing == "" {
		legacyFoldersPath := filepath.Join(dataDir, "saved-folders.json")
		if b, err := os.ReadFile(legacyFoldersPath); err == nil {
			var list []SavedFolder
			if json.Unmarshal(b, &list) == nil && len(list) > 0 {
				_ = d.SaveFolders(list)
			}
		}
	}

	// 迁移 password.json（兼容旧版明文 password 或 scrypt passwordHash+salt）
	if existing, _ := d.GetSetting("auth_config"); existing == "" {
		legacyPwdPath := filepath.Join(dataDir, "password.json")
		if b, err := os.ReadFile(legacyPwdPath); err == nil {
			var raw map[string]string
			if json.Unmarshal(b, &raw) == nil {
				if raw["passwordHash"] != "" && raw["salt"] != "" {
					payload, _ := json.Marshal(map[string]string{
						"scheme": "scrypt-node-hex",
						"hash":   raw["passwordHash"],
						"salt":   raw["salt"],
					})
					_ = d.SetSetting("auth_config", string(payload))
				} else if raw["password"] != "" {
					payload, _ := json.Marshal(map[string]string{
						"scheme": "legacy-plain",
						"plain":  raw["password"],
					})
					_ = d.SetSetting("auth_config", string(payload))
				}
			}
		}
	}
}

// GetSetting 读取配置键值。
func (d *DB) GetSetting(key string) (string, error) {
	var val string
	err := d.conn.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&val)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return val, err
}

// SetSetting 写入或更新配置键值。
func (d *DB) SetSetting(key, value string) error {
	_, err := d.conn.Exec(
		`INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	return err
}

// GetSavedFolders 返回保存的扫描路径列表。
func (d *DB) GetSavedFolders() ([]SavedFolder, error) {
	raw, err := d.GetSetting("saved_folders")
	if err != nil || raw == "" {
		return []SavedFolder{}, err
	}
	var list []SavedFolder
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return []SavedFolder{}, nil
	}
	return list, nil
}

// SaveFolders 保存用户选择的扫描路径列表。
func (d *DB) SaveFolders(folders []SavedFolder) error {
	b, err := json.Marshal(folders)
	if err != nil {
		return err
	}
	return d.SetSetting("saved_folders", string(b))
}

// UpsertSession 创建或刷新会话过期时间。
func (d *DB) UpsertSession(token string, expiresAtMs int64) error {
	_, err := d.conn.Exec(
		`INSERT INTO sessions(token, expires_at) VALUES(?, ?) ON CONFLICT(token) DO UPDATE SET expires_at = excluded.expires_at`,
		token, expiresAtMs,
	)
	return err
}

// GetSessionExpiry 查询会话过期时间，不存在则返回 0。
func (d *DB) GetSessionExpiry(token string) (int64, error) {
	var exp int64
	err := d.conn.QueryRow(`SELECT expires_at FROM sessions WHERE token = ?`, token).Scan(&exp)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return exp, err
}

// DeleteSession 删除会话。
func (d *DB) DeleteSession(token string) error {
	_, err := d.conn.Exec(`DELETE FROM sessions WHERE token = ?`, token)
	return err
}

// ClearExpiredSessions 清理已过期会话。
func (d *DB) ClearExpiredSessions(nowMs int64) {
	_, _ = d.conn.Exec(`DELETE FROM sessions WHERE expires_at < ?`, nowMs)
}

// ClearAllSessions 清除全部会话（密码修改后触发重新认证）。
func (d *DB) ClearAllSessions() {
	_, _ = d.conn.Exec(`DELETE FROM sessions`)
}

// CreateScan 插入一条运行中的扫描任务。
func (d *DB) CreateScan(rootPath string, startedAtMs int64) (int64, error) {
	res, err := d.conn.Exec(
		`INSERT INTO scans(root_path, started_at, status) VALUES(?, ?, 'running')`,
		rootPath, startedAtMs,
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// InsertScanBatch 在单事务内批量写入扫描文件夹和文件明细。
func (d *DB) InsertScanBatch(scanID int64, folders []FolderItem, files []FileItem) error {
	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if len(folders) > 0 {
		stmt, errStmt := tx.Prepare(`INSERT INTO scan_folders(scan_id, path, parent_path, name, depth, size, file_count, folder_count) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`)
		if errStmt != nil {
			err = errStmt
			return err
		}
		for _, f := range folders {
			if _, errExec := stmt.Exec(scanID, f.Path, f.ParentPath, f.Name, f.Depth, f.Size, f.FileCount, f.FolderCount); errExec != nil {
				_ = stmt.Close()
				err = errExec
				return err
			}
		}
		_ = stmt.Close()
	}

	if len(files) > 0 {
		type aggBucket struct {
			count int64
			size  int64
		}
		typeAgg := make(map[string]aggBucket, 8)
		stmt, errStmt := tx.Prepare(`INSERT INTO scan_files(scan_id, path, parent_path, name, ext, file_type, size, mtime, inode_key) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`)
		if errStmt != nil {
			err = errStmt
			return err
		}
		for _, f := range files {
			if _, errExec := stmt.Exec(scanID, f.Path, f.ParentPath, f.Name, f.Ext, f.FileType, f.Size, f.Mtime, f.InodeKey); errExec != nil {
				_ = stmt.Close()
				err = errExec
				return err
			}
			b := typeAgg[f.FileType]
			b.count++
			b.size += f.Size
			typeAgg[f.FileType] = b
		}
		_ = stmt.Close()

		for fType, b := range typeAgg {
			if _, errAgg := tx.Exec(`
				INSERT INTO scan_type_stats(scan_id, file_type, file_count, total_size)
				VALUES(?, ?, ?, ?)
				ON CONFLICT(scan_id, file_type) DO UPDATE SET
					file_count = file_count + excluded.file_count,
					total_size = total_size + excluded.total_size`,
				scanID, fType, b.count, b.size,
			); errAgg != nil {
				err = errAgg
				return err
			}
		}
	}

	err = tx.Commit()
	return err
}

// CompleteScan 更新扫描结果；取消/失败任务的明细在后台异步分批清理，避免同步 DELETE 阻塞响应。
func (d *DB) CompleteScan(scanID int64, rootPath string, status string, totalSize, uniqueSize, hardlinkSaved, totalFiles, totalFolders int64, errMsg string) error {
	nowMs := time.Now().UnixMilli()
	_, err := d.conn.Exec(
		`UPDATE scans SET finished_at=?, status=?, total_size=?, unique_size=?, hardlink_saved=?, total_files=?, total_folders=?, error_msg=? WHERE id=?`,
		nowMs, status, totalSize, uniqueSize, hardlinkSaved, totalFiles, totalFolders, errMsg, scanID,
	)
	if err != nil {
		return err
	}
	if status == "completed" || status == "partial" {
		go func() {
			_ = d.pruneOldScanDetails(rootPath, MaxDetailedScansPerRoot)
		}()
	} else {
		// 取消或失败的任务在后台分批删除已落盘明细，确保前端秒级完成取消且不长时锁表
		go d.purgeScanDetailsBatch(scanID)
	}
	return nil
}

func (d *DB) purgeScanDetailsBatch(scanID int64) {
	const batchLimit = 5000
	for {
		res, err := d.conn.Exec(
			`DELETE FROM scan_files WHERE id IN (SELECT id FROM scan_files WHERE scan_id = ? LIMIT ?)`,
			scanID, batchLimit,
		)
		if err != nil {
			break
		}
		n, _ := res.RowsAffected()
		if n < batchLimit {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	for {
		res, err := d.conn.Exec(
			`DELETE FROM scan_folders WHERE rowid IN (SELECT rowid FROM scan_folders WHERE scan_id = ? LIMIT ?)`,
			scanID, batchLimit,
		)
		if err != nil {
			break
		}
		n, _ := res.RowsAffected()
		if n < batchLimit {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
}

func (d *DB) pruneOldScanDetails(rootPath string, keep int) error {
	rows, err := d.conn.Query(
		`SELECT id FROM scans WHERE root_path = ? AND status IN ('completed', 'partial') ORDER BY finished_at DESC, id DESC LIMIT -1 OFFSET ?`,
		rootPath, keep,
	)
	if err != nil {
		return err
	}
	var oldIDs []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			oldIDs = append(oldIDs, id)
		}
	}
	_ = rows.Close()

	for _, id := range oldIDs {
		d.purgeScanDetailsBatch(id)
	}
	return nil
}

// ListScans 列出扫描历史，可按 rootPath 过滤。
func (d *DB) ListScans(rootPath string, limit int) ([]ScanRecord, error) {
	if limit <= 0 {
		limit = 50
	}
	var rows *sql.Rows
	var err error
	baseQuery := `
		SELECT s.id, s.root_path, s.started_at, s.finished_at, s.status,
		       s.total_size, s.unique_size, s.hardlink_saved, s.total_files, s.total_folders, s.error_msg,
		       (EXISTS(SELECT 1 FROM scan_files sf WHERE sf.scan_id = s.id LIMIT 1) OR EXISTS(SELECT 1 FROM scan_folders sd WHERE sd.scan_id = s.id LIMIT 1)) AS has_details
		FROM scans s`
	if rootPath != "" {
		rows, err = d.conn.Query(baseQuery+` WHERE s.root_path = ? ORDER BY s.started_at DESC, s.id DESC LIMIT ?`, rootPath, limit)
	} else {
		rows, err = d.conn.Query(baseQuery+` ORDER BY s.started_at DESC, s.id DESC LIMIT ?`, limit)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]ScanRecord, 0)
	for rows.Next() {
		var r ScanRecord
		var hasDetailsInt int
		if err := rows.Scan(
			&r.ID, &r.RootPath, &r.StartedAt, &r.FinishedAt, &r.Status,
			&r.TotalSize, &r.UniqueSize, &r.HardlinkSaved, &r.TotalFiles, &r.TotalFolders, &r.ErrorMsg, &hasDetailsInt,
		); err != nil {
			return nil, err
		}
		r.HasDetails = hasDetailsInt == 1
		out = append(out, r)
	}
	return out, nil
}

// GetScanByID 获取单条扫描记录。
func (d *DB) GetScanByID(scanID int64) (*ScanRecord, error) {
	var r ScanRecord
	var hasDetailsInt int
	err := d.conn.QueryRow(`
		SELECT s.id, s.root_path, s.started_at, s.finished_at, s.status,
		       s.total_size, s.unique_size, s.hardlink_saved, s.total_files, s.total_folders, s.error_msg,
		       (EXISTS(SELECT 1 FROM scan_files sf WHERE sf.scan_id = s.id LIMIT 1) OR EXISTS(SELECT 1 FROM scan_folders sd WHERE sd.scan_id = s.id LIMIT 1)) AS has_details
		FROM scans s WHERE s.id = ?`, scanID).Scan(
		&r.ID, &r.RootPath, &r.StartedAt, &r.FinishedAt, &r.Status,
		&r.TotalSize, &r.UniqueSize, &r.HardlinkSaved, &r.TotalFiles, &r.TotalFolders, &r.ErrorMsg, &hasDetailsInt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r.HasDetails = hasDetailsInt == 1
	return &r, nil
}

// GetPreviousCompletedScan 获取当前扫描之前的最近一次已完成扫描，用于计算环比。
func (d *DB) GetPreviousCompletedScan(rootPath string, currentID int64) (*ScanRecord, error) {
	var r ScanRecord
	err := d.conn.QueryRow(`
		SELECT id, root_path, started_at, finished_at, status,
		       total_size, unique_size, hardlink_saved, total_files, total_folders, error_msg
		FROM scans
		WHERE root_path = ? AND status = 'completed' AND id < ?
		ORDER BY id DESC LIMIT 1`, rootPath, currentID).Scan(
		&r.ID, &r.RootPath, &r.StartedAt, &r.FinishedAt, &r.Status,
		&r.TotalSize, &r.UniqueSize, &r.HardlinkSaved, &r.TotalFiles, &r.TotalFolders, &r.ErrorMsg,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return &r, err
}

// DeleteScan 删除指定历史扫描记录及明细。
func (d *DB) DeleteScan(scanID int64) error {
	_, err := d.conn.Exec(`DELETE FROM scans WHERE id = ?`, scanID)
	return err
}

// GetScanTypeStats 优先读取 scan_type_stats 汇总缓存表（毫秒级）；若历史快照尚未缓存，则计算并自动回填缓存。
func (d *DB) GetScanTypeStats(scanID int64) ([]TypeStat, error) {
	if cached, err := d.queryCachedTypeStats(scanID); err == nil && len(cached) > 0 {
		return cached, nil
	}

	rows, err := d.conn.Query(`
		SELECT file_type, COUNT(*), COALESCE(SUM(size), 0)
		FROM scan_files
		WHERE scan_id = ?
		GROUP BY file_type
		ORDER BY SUM(size) DESC`, scanID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]TypeStat, 0)
	for rows.Next() {
		var s TypeStat
		if err := rows.Scan(&s.Type, &s.Count, &s.Size); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	if len(out) > 0 {
		d.saveCachedTypeStats(scanID, out)
	}
	return out, nil
}

func (d *DB) queryCachedTypeStats(scanID int64) ([]TypeStat, error) {
	rows, err := d.conn.Query(`
		SELECT file_type, file_count, total_size
		FROM scan_type_stats
		WHERE scan_id = ? AND file_count > 0
		ORDER BY total_size DESC`, scanID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make([]TypeStat, 0)
	for rows.Next() {
		var s TypeStat
		if err := rows.Scan(&s.Type, &s.Count, &s.Size); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, nil
}

func (d *DB) saveCachedTypeStats(scanID int64, stats []TypeStat) {
	tx, err := d.conn.Begin()
	if err != nil {
		return
	}
	for _, s := range stats {
		_, _ = tx.Exec(`
			INSERT INTO scan_type_stats(scan_id, file_type, file_count, total_size)
			VALUES(?, ?, ?, ?)
			ON CONFLICT(scan_id, file_type) DO UPDATE SET
				file_count = excluded.file_count,
				total_size = excluded.total_size`,
			scanID, s.Type, s.Count, s.Size,
		)
	}
	_ = tx.Commit()
}

func (d *DB) warmScanTypeStatsCache() {
	rows, err := d.conn.Query(`
		SELECT s.id
		FROM scans s
		WHERE s.status IN ('completed', 'partial')
		  AND NOT EXISTS (SELECT 1 FROM scan_type_stats st WHERE st.scan_id = s.id)
		  AND EXISTS (SELECT 1 FROM scan_files sf WHERE sf.scan_id = s.id LIMIT 1)
		ORDER BY s.id DESC
		LIMIT 20`)
	if err != nil {
		return
	}
	var ids []int64
	for rows.Next() {
		var id int64
		if rows.Scan(&id) == nil {
			ids = append(ids, id)
		}
	}
	_ = rows.Close()
	for _, id := range ids {
		_, _ = d.GetScanTypeStats(id)
		time.Sleep(30 * time.Millisecond)
	}
}

// GetLargestFileSize 返回一次扫描中最大的单文件字节数。
func (d *DB) GetLargestFileSize(scanID int64) (int64, error) {
	var maxSize int64
	err := d.conn.QueryRow(`SELECT COALESCE(MAX(size), 0) FROM scan_files WHERE scan_id = ?`, scanID).Scan(&maxSize)
	return maxSize, err
}

// GetDirectChildren 返回指定目录的直接子文件夹和直接文件。
func (d *DB) GetDirectChildren(scanID int64, dirPath string, limit int) ([]FolderItem, []FileItem, error) {
	if limit <= 0 {
		limit = 200
	}
	folders := make([]FolderItem, 0)
	fRows, err := d.conn.Query(`
		SELECT path, parent_path, name, depth, size, file_count, folder_count
		FROM scan_folders
		WHERE scan_id = ? AND parent_path = ?
		ORDER BY size DESC LIMIT ?`, scanID, dirPath, limit)
	if err != nil {
		return nil, nil, err
	}
	for fRows.Next() {
		var it FolderItem
		if err := fRows.Scan(&it.Path, &it.ParentPath, &it.Name, &it.Depth, &it.Size, &it.FileCount, &it.FolderCount); err == nil {
			folders = append(folders, it)
		}
	}
	_ = fRows.Close()

	files := make([]FileItem, 0)
	fileRows, err := d.conn.Query(`
		SELECT id, path, parent_path, name, ext, file_type, size, mtime, inode_key
		FROM scan_files
		WHERE scan_id = ? AND parent_path = ?
		ORDER BY size DESC LIMIT ?`, scanID, dirPath, limit)
	if err != nil {
		return nil, nil, err
	}
	for fileRows.Next() {
		var it FileItem
		if err := fileRows.Scan(&it.ID, &it.Path, &it.ParentPath, &it.Name, &it.Ext, &it.FileType, &it.Size, &it.Mtime, &it.InodeKey); err == nil {
			files = append(files, it)
		}
	}
	_ = fileRows.Close()
	return folders, files, nil
}

// FileQuery 定义文件列表查询条件。
type FileQuery struct {
	ScanID        int64
	DirPrefix     string
	Query         string
	FileType      string
	MinSize       int64
	MaxMtimeSec   int64
	SortBy        string
	Order         string
	Page          int
	PageSize      int
}

// QueryFiles 支持路径范围、关键词、类型、最小体积、修改时间筛选与排序分页。
func (d *DB) QueryFiles(q FileQuery) ([]FileItem, int64, error) {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize <= 0 || q.PageSize > 500 {
		q.PageSize = 50
	}

	where := []string{"scan_id = ?"}
	args := []any{q.ScanID}

	if q.DirPrefix != "" {
		prefix := strings.TrimRight(q.DirPrefix, "/")
		if prefix == "" {
			prefix = "/"
		}
		if prefix == "/" {
			where = append(where, "path LIKE '/%'")
		} else {
			where = append(where, "(path = ? OR path LIKE ?)")
			args = append(args, prefix, prefix+"/%")
		}
	}
	if q.Query != "" {
		where = append(where, "(LOWER(name) LIKE ? OR LOWER(path) LIKE ?)")
		pat := "%" + strings.ToLower(q.Query) + "%"
		args = append(args, pat, pat)
	}
	if q.FileType != "" && q.FileType != "all" {
		where = append(where, "file_type = ?")
		args = append(args, q.FileType)
	}
	if q.MinSize > 0 {
		where = append(where, "size >= ?")
		args = append(args, q.MinSize)
	}
	if q.MaxMtimeSec > 0 {
		where = append(where, "mtime > 0 AND mtime <= ?")
		args = append(args, q.MaxMtimeSec)
	}

	whereSQL := strings.Join(where, " AND ")

	var total int64
	unfiltered := q.DirPrefix == "" && q.Query == "" && (q.FileType == "" || q.FileType == "all") && q.MinSize == 0 && q.MaxMtimeSec == 0
	if unfiltered {
		_ = d.conn.QueryRow(`SELECT COALESCE(total_files, 0) FROM scans WHERE id = ?`, q.ScanID).Scan(&total)
	} else {
		countSQL := "SELECT COUNT(*) FROM scan_files WHERE " + whereSQL
		if err := d.conn.QueryRow(countSQL, args...).Scan(&total); err != nil {
			return nil, 0, err
		}
	}

	sortCol := "size"
	switch q.SortBy {
	case "mtime":
		sortCol = "mtime"
	case "name":
		sortCol = "name"
	case "size":
		sortCol = "size"
	}
	dir := "DESC"
	if strings.EqualFold(q.Order, "asc") {
		dir = "ASC"
	}

	offset := (q.Page - 1) * q.PageSize
	orderClause := fmt.Sprintf("%s %s", sortCol, dir)
	if sortCol == "name" {
		orderClause = fmt.Sprintf("%s %s, id ASC", sortCol, dir)
	}
	listSQL := fmt.Sprintf(`
		SELECT id, path, parent_path, name, ext, file_type, size, mtime, inode_key
		FROM scan_files
		WHERE %s
		ORDER BY %s
		LIMIT ? OFFSET ?`, whereSQL, orderClause)

	listArgs := append(append([]any{}, args...), q.PageSize, offset)
	rows, err := d.conn.Query(listSQL, listArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	items := make([]FileItem, 0)
	for rows.Next() {
		var it FileItem
		if err := rows.Scan(&it.ID, &it.Path, &it.ParentPath, &it.Name, &it.Ext, &it.FileType, &it.Size, &it.Mtime, &it.InodeKey); err != nil {
			return nil, 0, err
		}
		items = append(items, it)
	}
	return items, total, nil
}

// RemoveDeletedFileFromScans 文件物理删除后同步修正包含该文件的最近扫描统计、目录大小与文件表。
func (d *DB) RemoveDeletedFileFromScans(filePath string) error {
	rows, err := d.conn.Query(`SELECT id, scan_id, size, inode_key, file_type FROM scan_files WHERE path = ?`, filePath)
	if err != nil {
		return err
	}
	type hit struct {
		id       int64
		scanID   int64
		size     int64
		inodeKey string
		fileType string
	}
	var hits []hit
	for rows.Next() {
		var h hit
		if rows.Scan(&h.id, &h.scanID, &h.size, &h.inodeKey, &h.fileType) == nil {
			hits = append(hits, h)
		}
	}
	_ = rows.Close()

	if len(hits) == 0 {
		return nil
	}

	tx, err := d.conn.Begin()
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	for _, h := range hits {
		// 检查同一次扫描内是否还有共享相同 inode 的硬链接
		var remainingLinks int
		if h.inodeKey != "" {
			_ = tx.QueryRow(`SELECT COUNT(*) FROM scan_files WHERE scan_id = ? AND inode_key = ? AND id != ?`, h.scanID, h.inodeKey, h.id).Scan(&remainingLinks)
		}

		if _, err = tx.Exec(`DELETE FROM scan_files WHERE id = ?`, h.id); err != nil {
			return err
		}

		uniqueDelta := h.size
		savedDelta := int64(0)
		if remainingLinks > 0 {
			// 若仍有硬链接指向该 inode，则物理磁盘并未释放空间，而是硬链接节省计数减少
			uniqueDelta = 0
			savedDelta = h.size
		}

		if _, err = tx.Exec(`
			UPDATE scans
			SET total_files = MAX(0, total_files - 1),
			    total_size = MAX(0, total_size - ?),
			    unique_size = MAX(0, unique_size - ?),
			    hardlink_saved = MAX(0, hardlink_saved - ?)
			WHERE id = ?`, h.size, uniqueDelta, savedDelta, h.scanID); err != nil {
			return err
		}
		if h.fileType != "" {
			_, _ = tx.Exec(`
				UPDATE scan_type_stats
				SET file_count = MAX(0, file_count - 1),
				    total_size = MAX(0, total_size - ?)
				WHERE scan_id = ? AND file_type = ?`, h.size, h.scanID, h.fileType)
		}

		// 更新所有祖先目录的 size 与 file_count
		ancestors := collectAncestors(filePath)
		for _, anc := range ancestors {
			if _, err = tx.Exec(`
				UPDATE scan_folders
				SET size = MAX(0, size - ?),
				    file_count = MAX(0, file_count - 1)
				WHERE scan_id = ? AND path = ?`, h.size, h.scanID, anc); err != nil {
				return err
			}
		}
	}

	err = tx.Commit()
	return err
}

func collectAncestors(filePath string) []string {
	var out []string
	cur := filepath.Dir(filePath)
	for cur != "" && cur != "." {
		out = append(out, cur)
		parent := filepath.Dir(cur)
		if parent == cur {
			break
		}
		cur = parent
	}
	return out
}

// GetDuplicateSizeCandidates 返回具有相同文件大小（且大于等于 minSize）的候选文件，按大小分组。
func (d *DB) GetDuplicateSizeCandidates(scanID int64, minSize int64) ([]FileItem, error) {
	rows, err := d.conn.Query(`
		SELECT id, path, parent_path, name, ext, file_type, size, mtime, inode_key, partial_hash, full_hash
		FROM scan_files
		WHERE scan_id = ? AND size >= ? AND size IN (
			SELECT size FROM scan_files
			WHERE scan_id = ? AND size >= ?
			GROUP BY size
			HAVING COUNT(*) > 1
		)
		ORDER BY size DESC, mtime ASC`, scanID, minSize, scanID, minSize)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []FileItem
	for rows.Next() {
		var it FileItem
		if err := rows.Scan(&it.ID, &it.Path, &it.ParentPath, &it.Name, &it.Ext, &it.FileType, &it.Size, &it.Mtime, &it.InodeKey, &it.PartialHash, &it.FullHash); err != nil {
			return nil, err
		}
		out = append(out, it)
	}
	return out, nil
}

// UpdateFileHashes 缓存计算出的局部与全量哈希。
func (d *DB) UpdateFileHashes(fileID int64, partialHash, fullHash string) error {
	_, err := d.conn.Exec(`UPDATE scan_files SET partial_hash = ?, full_hash = ? WHERE id = ?`, partialHash, fullHash, fileID)
	return err
}
