package server

import (
	"context"
	"net/http"
	"strings"
	"time"

	"spacemap/internal/config"
	"spacemap/internal/updater"
)

func (s *Server) handleUpdateStatus(w http.ResponseWriter, r *http.Request) {
	writeJSONOk(w, map[string]any{
		"config": s.upd.GetConfig(),
		"status": s.upd.GetStatus(),
	})
}

func (s *Server) handleUpdateConfig(w http.ResponseWriter, r *http.Request) {
	var body updater.UpdateConfig
	if err := decodeJSONBody(r, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "更新配置格式无效")
		return
	}
	saved, err := s.upd.SaveConfig(body)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "保存更新配置失败")
		return
	}
	writeJSONOk(w, map[string]any{
		"config": saved,
		"status": s.upd.GetStatus(),
	})
}

func (s *Server) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	st, err := s.upd.Check(ctx)
	if err != nil {
		writeJSONError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSONOk(w, map[string]any{
		"config": s.upd.GetConfig(),
		"status": st,
	})
}

func (s *Server) handleUpdateApply(w http.ResponseWriter, r *http.Request) {
	if err := s.upd.StartApply(); err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSONOk(w, map[string]any{
		"started": true,
		"status":  s.upd.GetStatus(),
	})
}

func (s *Server) handleUpdateDownloadPackage(w http.ResponseWriter, r *http.Request) {
	var body struct {
		TargetDir string `json:"targetDir"`
	}
	_ = decodeJSONBody(r, &body)

	saved := s.savedPathStrings()
	targetDir := strings.TrimSpace(body.TargetDir)
	var resolved string
	if targetDir == "" {
		roots := s.cfg.GetAuthorizedRoots(saved)
		for _, rt := range roots {
			if rt.Writable && config.IsPathWritable(rt.Path) {
				resolved = rt.Path
				break
			}
		}
		if resolved == "" {
			writeJSONError(w, http.StatusBadRequest, "未找到可写入的已授权共享目录，请先在绿联应用配置中授予至少一个目录的读写权限")
			return
		}
	} else {
		p, _, err := s.cfg.ResolveAuthorizedPath(targetDir, saved, true, false)
		if err != nil {
			writeJSONError(w, http.StatusBadRequest, err.Error())
			return
		}
		if !config.IsPathWritable(p) {
			writeJSONError(w, http.StatusForbidden, "所选目录没有写入权限，请在绿联应用配置中设为读写权限")
			return
		}
		resolved = p
	}

	if err := s.upd.StartDownloadPackage(resolved); err != nil {
		writeJSONError(w, http.StatusConflict, err.Error())
		return
	}
	writeJSONOk(w, map[string]any{
		"started":   true,
		"targetDir": resolved,
		"status":    s.upd.GetStatus(),
	})
}
