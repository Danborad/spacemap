package server

import (
	"net/http"
	"path/filepath"
	"strings"

	"spacemap/internal/config"
	"spacemap/internal/db"
	"spacemap/internal/scheduler"
)

func (s *Server) handleEnv(w http.ResponseWriter, r *http.Request) {
	writeJSONOk(w, map[string]any{
		"version":       s.cfg.Version,
		"platform":      string(s.cfg.Platform),
		"platformLabel": s.cfg.Platform.Label(),
		"port":          s.cfg.Port,
	})
}

func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	hasPwd, err := s.authMgr.HasPassword()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "检查认证状态失败")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success":       true,
		"hasPassword":   hasPwd,
		"authenticated": !hasPwd || s.authMgr.RequestAuthenticated(r),
	})
}

func (s *Server) handleAuthLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Password string `json:"password"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求体格式无效")
		return
	}
	ok, err := s.authMgr.VerifyPassword(body.Password)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "验证失败")
		return
	}
	if !ok {
		writeJSONError(w, http.StatusUnauthorized, "密码错误")
		return
	}
	if err := s.authMgr.CreateSession(w, r); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "创建会话失败")
		return
	}
	writeJSONOk(w, map[string]any{"authenticated": true})
}

func (s *Server) handleAuthLogout(w http.ResponseWriter, r *http.Request) {
	s.authMgr.ClearSession(w, r)
	writeJSONOk(w, map[string]any{"authenticated": false})
}

func (s *Server) handleAuthPassword(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OldPassword string `json:"oldPassword"`
		NewPassword string `json:"newPassword"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求体格式无效")
		return
	}
	if err := s.authMgr.SetPassword(body.OldPassword, body.NewPassword); err != nil {
		writeJSONError(w, http.StatusUnauthorized, err.Error())
		return
	}
	if body.NewPassword != "" {
		_ = s.authMgr.CreateSession(w, r)
	}
	writeJSONOk(w, map[string]any{
		"hasPassword": body.NewPassword != "",
	})
}

func (s *Server) handleGetRoots(w http.ResponseWriter, r *http.Request) {
	saved, err := s.database.GetSavedFolders()
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "读取已保存路径失败")
		return
	}

	savedStrs := make([]string, 0, len(saved))
	for _, f := range saved {
		savedStrs = append(savedStrs, f.Path)
	}

	discovered := s.cfg.DiscoverRoots()
	authorized := s.cfg.GetAuthorizedRoots(savedStrs)

	savedView := make([]config.RootEntry, 0, len(saved))
	for _, f := range saved {
		resolved, _, err := s.cfg.ResolveAuthorizedPath(f.Path, savedStrs, true, false)
		writable := false
		exists := false
		if err == nil {
			exists = true
			writable = config.IsPathWritable(resolved)
		}
		savedView = append(savedView, config.RootEntry{
			Path:     f.Path,
			Name:     f.Name,
			Source:   boolSource(exists),
			Writable: writable,
		})
	}

	envRestricted := s.cfg.IsEnvRestricted()

	writeJSONOk(w, map[string]any{
		"platform":      string(s.cfg.Platform),
		"platformLabel": s.cfg.Platform.Label(),
		"envRestricted": envRestricted,
		"discovered":    discovered,
		"saved":         savedView,
		"authorized":    authorized,
	})
}

func boolSource(exists bool) string {
	if exists {
		return "saved"
	}
	return "unavailable"
}

func (s *Server) handleSaveFolders(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Folders []db.SavedFolder `json:"folders"`
	}
	if err := decodeJSONBody(r, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "请求参数无效")
		return
	}

	seen := make(map[string]struct{})
	valid := make([]db.SavedFolder, 0, len(body.Folders))
	var rejected []string

	for _, item := range body.Folders {
		if strings.TrimSpace(item.Path) == "" {
			continue
		}
		entry, err := s.cfg.ValidateSavedPath(item.Path)
		if err != nil {
			rejected = append(rejected, item.Path+": "+err.Error())
			continue
		}
		if _, ok := seen[entry.Path]; ok {
			continue
		}
		seen[entry.Path] = struct{}{}
		name := strings.TrimSpace(item.Name)
		if name == "" {
			name = filepath.Base(entry.Path)
			if name == "" || name == string(filepath.Separator) {
				name = entry.Path
			}
		}
		valid = append(valid, db.SavedFolder{
			Path: entry.Path,
			Name: name,
		})
	}

	if len(rejected) > 0 && len(valid) == 0 && len(body.Folders) > 0 {
		writeJSONError(w, http.StatusBadRequest, strings.Join(rejected, "；"))
		return
	}

	if err := s.database.SaveFolders(valid); err != nil {
		writeJSONError(w, http.StatusInternalServerError, "保存路径失败")
		return
	}

	writeJSONOk(w, map[string]any{
		"folders":  valid,
		"rejected": rejected,
	})
}

func (s *Server) handleGetSchedule(w http.ResponseWriter, r *http.Request) {
	writeJSONOk(w, s.sched.Get())
}

func (s *Server) handleSaveSchedule(w http.ResponseWriter, r *http.Request) {
	var body scheduler.ScheduleConfig
	if err := decodeJSONBody(r, &body); err != nil {
		writeJSONError(w, http.StatusBadRequest, "定时配置格式无效")
		return
	}
	savedPaths := s.savedPathStrings()
	cleanPaths := make([]string, 0, len(body.Paths))
	for _, p := range body.Paths {
		resolved, _, err := s.cfg.ResolveAuthorizedPath(p, savedPaths, true, false)
		if err == nil {
			cleanPaths = append(cleanPaths, resolved)
		}
	}
	body.Paths = cleanPaths

	updated, err := s.sched.Update(body)
	if err != nil {
		writeJSONError(w, http.StatusInternalServerError, "保存定时配置失败")
		return
	}
	writeJSONOk(w, updated)
}
