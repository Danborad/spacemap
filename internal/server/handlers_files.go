package server

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"spacemap/internal/config"
	"spacemap/internal/db"
	"spacemap/internal/scanner"
)

func (s *Server) handleFileDetails(w http.ResponseWriter, r *http.Request) {
	filePath := strings.TrimSpace(r.URL.Query().Get("path"))
	resolved, info, err := s.cfg.ResolveAuthorizedPath(filePath, s.savedPathStrings(), false, true)
	if err != nil {
		writeJSONError(w, http.StatusForbidden, err.Error())
		return
	}

	ext := strings.TrimPrefix(strings.ToLower(filepath.Ext(resolved)), ".")
	mimeType := mime.TypeByExtension("." + ext)
	if mimeType == "" {
		mimeType = "application/octet-stream"
	}

	writeJSONOk(w, map[string]any{
		"name":     filepath.Base(resolved),
		"path":     resolved,
		"size":     info.Size(),
		"type":     scanner.ClassifyFile(resolved),
		"ext":      ext,
		"mimeType": mimeType,
		"modified": info.ModTime().Unix(),
		"writable": config.IsPathWritable(resolved),
	})
}

func (s *Server) handleDeleteFiles(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Paths []string `json:"paths"`
	}
	if err := decodeJSONBody(r, &body); err != nil || len(body.Paths) == 0 {
		writeJSONError(w, http.StatusBadRequest, "请提供要删除的文件路径列表")
		return
	}

	saved := s.savedPathStrings()
	type failEntry struct {
		Path  string `json:"path"`
		Error string `json:"error"`
	}
	var deleted []string
	var failed []failEntry

	for _, rawPath := range body.Paths {
		resolved, _, err := s.cfg.ResolveAuthorizedPath(rawPath, saved, false, true)
		if err != nil {
			failed = append(failed, failEntry{Path: rawPath, Error: err.Error()})
			continue
		}
		if !config.IsPathWritable(resolved) {
			failed = append(failed, failEntry{Path: rawPath, Error: "目标目录为只读状态或当前用户无写入权限"})
			continue
		}
		if err := os.Remove(resolved); err != nil {
			failed = append(failed, failEntry{Path: rawPath, Error: err.Error()})
			continue
		}
		_ = s.database.RemoveDeletedFileFromScans(resolved)
		deleted = append(deleted, resolved)
	}

	if deleted == nil {
		deleted = []string{}
	}
	if failed == nil {
		failed = []failEntry{}
	}

	writeJSONOk(w, map[string]any{
		"deleted": deleted,
		"failed":  failed,
	})
}

func (s *Server) handleScanExport(w http.ResponseWriter, r *http.Request) {
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

	format := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("format")))
	if format == "" {
		format = "csv"
	}

	topFolders, _, _ := s.database.GetDirectChildren(scanID, scan.RootPath, 500)
	files, _, _ := s.database.QueryFiles(db.FileQuery{
		ScanID:   scanID,
		SortBy:   "size",
		Order:    "desc",
		Page:     1,
		PageSize: 500,
	})
	typeStats, _ := s.database.GetScanTypeStats(scanID)

	if format == "json" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="spacemap_scan_%d.json"`, scanID))
		_ = json.NewEncoder(w).Encode(map[string]any{
			"scan":       scan,
			"typeStats":  typeStats,
			"topFolders": topFolders,
			"topFiles":   files,
		})
		return
	}

	w.Header().Set("Content-Type", "text/csv; charset=utf-8")
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="spacemap_scan_%d.csv"`, scanID))
	// 写入 UTF-8 BOM 方便 Excel 直接打开不乱码
	_, _ = w.Write([]byte{0xEF, 0xBB, 0xBF})

	cw := csv.NewWriter(w)
	_ = cw.Write([]string{"Kind", "Name", "Path", "SizeBytes", "Type", "ModifiedUnix"})
	for _, f := range topFolders {
		_ = cw.Write([]string{
			"Folder",
			f.Name,
			f.Path,
			strconv.FormatInt(f.Size, 10),
			"folder",
			"",
		})
	}
	for _, f := range files {
		_ = cw.Write([]string{
			"File",
			f.Name,
			f.Path,
			strconv.FormatInt(f.Size, 10),
			f.FileType,
			strconv.FormatInt(f.Mtime, 10),
		})
	}
	cw.Flush()
}
