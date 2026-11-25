package server

import (
	"context"
	"net/http"
	"time"

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
