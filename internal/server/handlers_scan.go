package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"spacemap/internal/config"
	"spacemap/internal/db"
	"spacemap/internal/scanner"
)

func (s *Server) handleScanStart(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Path     string `json:"path"`
		MaxDepth int    `json:"maxDepth"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	if strings.TrimSpace(body.Path) == "" {
		writeJSONError(w, http.StatusBadRequest, "请选择要扫描的目录")
		return
	}
	resolved, _, err := s.cfg.ResolveAuthorizedPath(body.Path, s.savedPathStrings(), true, false)
	if err != nil {
		writeJSONError(w, http.StatusForbidden, err.Error())
		return
	}

	scanID, err := s.scanMgr.StartAsync(resolved, body.MaxDepth)
	if err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSONOk(w, map[string]any{
		"scanId":   scanID,
		"rootPath": resolved,
	})
}

func (s *Server) handleScanCancel(w http.ResponseWriter, r *http.Request) {
	var body struct {
		KeepPartial bool `json:"keepPartial"`
	}
	_ = decodeJSONBody(r, &body)
	cancelled := s.scanMgr.Cancel(body.KeepPartial)
	writeJSONOk(w, map[string]any{
		"cancelled":   cancelled,
		"keepPartial": body.KeepPartial,
	})
}

func (s *Server) handleScanStatus(w http.ResponseWriter, r *http.Request) {
	writeJSONOk(w, s.scanMgr.Status())
}

func (s *Server) handleScanEvents(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeJSONError(w, http.StatusInternalServerError, "当前连接不支持流式推送")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")

	ch := s.scanMgr.Subscribe()
	defer s.scanMgr.Unsubscribe(ch)

	heartbeat := time.NewTicker(15 * time.Second)
	defer heartbeat.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case snap, open := <-ch:
			if !open {
				return
			}
			b, _ := json.Marshal(snap)
			_, _ = fmt.Fprintf(w, "event: progress\ndata: %s\n\n", b)
			flusher.Flush()
		case <-heartbeat.C:
			_, _ = fmt.Fprint(w, ": ping\n\n")
			flusher.Flush()
		}
	}
}

func (s *Server) handleListScans(w http.ResponseWriter, r *http.Request) {
	rootPath := strings.TrimSpace(r.URL.Query().Get("rootPath"))
	if rootPath != "" {
		if resolved, _, err := s.cfg.ResolveAuthorizedPath(rootPath, s.savedPathStrings(), true, false); err == nil {
			rootPath = resolved
		}
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 200 {
		limit = 50
	}

	list, err := s.database.ListScans(rootPath, limit)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "读取扫描历史失败")
		return
	}
	writeJSONOk(w, list)
}

func (s *Server) handleDeleteScan(w http.ResponseWriter, r *http.Request) {
	scanID, ok := parsePathID(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "无效的扫描 ID")
		return
	}
	if err := s.database.DeleteScan(scanID); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "删除历史记录失败")
		return
	}
	writeJSONOk(w, map[string]any{"deletedId": scanID})
}

func (s *Server) handleScanOverview(w http.ResponseWriter, r *http.Request) {
	scanID, ok := parsePathID(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "无效的扫描 ID")
		return
	}
	scan, err := s.database.GetScanByID(scanID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "查询扫描详情失败")
		return
	}
	if scan == nil {
		writeJSONError(w, http.StatusNotFound, "扫描记录不存在")
		return
	}

	typeStats, err := s.database.GetScanTypeStats(scanID)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "统计文件类型失败")
		return
	}
	largestSize, _ := s.database.GetLargestFileSize(scanID)
	topFolders, directFiles, err := s.database.GetDirectChildren(scanID, scan.RootPath, 200)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "读取顶层目录失败")
		return
	}
	prevScan, _ := s.database.GetPreviousCompletedScan(scan.RootPath, scanID)
	writable := config.IsPathWritable(scan.RootPath)

	writeJSONOk(w, map[string]any{
		"scan":            scan,
		"previousScan":    prevScan,
		"largestFileSize": largestSize,
		"typeStats":       typeStats,
		"topFolders":      topFolders,
		"directFiles":     directFiles,
		"writable":        writable,
	})
}

func (s *Server) handleScanChildren(w http.ResponseWriter, r *http.Request) {
	scanID, ok := parsePathID(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "无效的扫描 ID")
		return
	}
	scan, err := s.database.GetScanByID(scanID)
	if err != nil || scan == nil {
		writeJSONError(w, http.StatusNotFound, "扫描记录不存在")
		return
	}

	dirPath := strings.TrimSpace(r.URL.Query().Get("path"))
	if dirPath == "" {
		dirPath = scan.RootPath
	}
	if !config.IsPathInside(dirPath, scan.RootPath) {
		writeJSONError(w, http.StatusForbidden, "目录不在本次扫描范围内")
		return
	}

	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 200
	}

	folders, files, err := s.database.GetDirectChildren(scanID, dirPath, limit)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "读取子目录失败")
		return
	}

	var currentSize int64
	if dirPath == scan.RootPath {
		currentSize = scan.TotalSize
	} else {
		for _, f := range folders {
			currentSize += f.Size
		}
		for _, f := range files {
			currentSize += f.Size
		}
	}

	writeJSONOk(w, map[string]any{
		"rootPath":    scan.RootPath,
		"path":        dirPath,
		"currentSize": currentSize,
		"folders":     folders,
		"files":       files,
		"writable":    config.IsPathWritable(scan.RootPath),
	})
}

func (s *Server) handleScanFiles(w http.ResponseWriter, r *http.Request) {
	scanID, ok := parsePathID(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "无效的扫描 ID")
		return
	}
	q := r.URL.Query()
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))
	minSize, _ := strconv.ParseInt(q.Get("minSize"), 10, 64)

	items, total, err := s.database.QueryFiles(db.FileQuery{
		ScanID:    scanID,
		DirPrefix: strings.TrimSpace(q.Get("path")),
		Query:     strings.TrimSpace(q.Get("q")),
		FileType:  strings.TrimSpace(q.Get("type")),
		MinSize:   minSize,
		SortBy:    strings.TrimSpace(q.Get("sort")),
		Order:     strings.TrimSpace(q.Get("order")),
		Page:      page,
		PageSize:  pageSize,
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "查询文件列表失败")
		return
	}
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 500 {
		pageSize = 50
	}

	writeJSONOk(w, map[string]any{
		"items":    items,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
	})
}

func (s *Server) handleColdFiles(w http.ResponseWriter, r *http.Request) {
	scanID, ok := parsePathID(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "无效的扫描 ID")
		return
	}
	q := r.URL.Query()
	days, _ := strconv.Atoi(q.Get("olderThanDays"))
	if days <= 0 {
		days = 180
	}
	minSize, _ := strconv.ParseInt(q.Get("minSize"), 10, 64)
	page, _ := strconv.Atoi(q.Get("page"))
	pageSize, _ := strconv.Atoi(q.Get("pageSize"))

	cutoffSec := time.Now().Add(-time.Duration(days) * 24 * time.Hour).Unix()
	items, total, err := s.database.QueryFiles(db.FileQuery{
		ScanID:      scanID,
		Query:       strings.TrimSpace(q.Get("q")),
		FileType:    strings.TrimSpace(q.Get("type")),
		MinSize:     minSize,
		MaxMtimeSec: cutoffSec,
		SortBy:      "mtime",
		Order:       "asc",
		Page:        page,
		PageSize:    pageSize,
	})
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "查询冷数据失败")
		return
	}
	if page < 1 {
		page = 1
	}
	if pageSize <= 0 || pageSize > 500 {
		pageSize = 50
	}

	writeJSONOk(w, map[string]any{
		"items":         items,
		"total":         total,
		"page":          page,
		"pageSize":      pageSize,
		"olderThanDays": days,
	})
}

func (s *Server) handleScanDuplicates(w http.ResponseWriter, r *http.Request) {
	scanID, ok := parsePathID(r.PathValue("id"))
	if !ok {
		writeJSONError(w, http.StatusBadRequest, "无效的扫描 ID")
		return
	}
	scan, err := s.database.GetScanByID(scanID)
	if err != nil || scan == nil {
		writeJSONError(w, http.StatusNotFound, "扫描记录不存在")
		return
	}
	if !scan.HasDetails {
		writeJSONError(w, http.StatusBadRequest, "该扫描记录仅包含历史摘要，请重新扫描后查重")
		return
	}

	var body struct {
		MinSize int64 `json:"minSize"`
	}
	_ = decodeJSONBody(r, &body)
	if body.MinSize <= 0 {
		body.MinSize = 1024 * 1024 // 默认 1MB
	}

	report, err := scanner.FindDuplicates(r.Context(), s.database, scanID, body.MinSize)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "查重失败: "+err.Error())
		return
	}
	writeJSONOk(w, report)
}
