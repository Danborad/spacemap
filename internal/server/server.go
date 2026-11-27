package server

import (
	"encoding/json"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"spacemap/internal/auth"
	"spacemap/internal/config"
	"spacemap/internal/db"
	"spacemap/internal/scanner"
	"spacemap/internal/scheduler"
	"spacemap/internal/updater"
	"spacemap/web"
)

// Server 聚合 HTTP 路由、鉴权与各业务处理器。
type Server struct {
	cfg      *config.Config
	database *db.DB
	authMgr  *auth.Manager
	scanMgr  *scanner.Manager
	sched    *scheduler.Service
	upd      *updater.Manager
	handler  http.Handler
}

// New 初始化 HTTP 服务器与路由表。
func New(cfg *config.Config, database *db.DB, authMgr *auth.Manager, scanMgr *scanner.Manager, sched *scheduler.Service, upd *updater.Manager) *Server {
	s := &Server{
		cfg:      cfg,
		database: database,
		authMgr:  authMgr,
		scanMgr:  scanMgr,
		sched:    sched,
		upd:      upd,
	}

	mux := http.NewServeMux()

	// 免鉴权或认证接口
	mux.HandleFunc("GET /api/env", s.handleEnv)
	mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/auth/login", s.handleAuthLogin)
	mux.HandleFunc("POST /api/auth/logout", s.handleAuthLogout)
	mux.HandleFunc("POST /api/auth/password", s.handleAuthPassword)

	// 根目录、已保存路径与定时计划
	mux.HandleFunc("GET /api/roots", s.handleGetRoots)
	mux.HandleFunc("POST /api/saved-folders", s.handleSaveFolders)
	mux.HandleFunc("GET /api/schedule", s.handleGetSchedule)
	mux.HandleFunc("POST /api/schedule", s.handleSaveSchedule)

	// 扫描控制与 SSE 进度流
	mux.HandleFunc("POST /api/scan/start", s.handleScanStart)
	mux.HandleFunc("POST /api/scan/cancel", s.handleScanCancel)
	mux.HandleFunc("GET /api/scan/status", s.handleScanStatus)
	mux.HandleFunc("GET /api/scan/events", s.handleScanEvents)

	// 扫描记录、总览、下钻、筛选、冷数据、查重
	mux.HandleFunc("GET /api/scans", s.handleListScans)
	mux.HandleFunc("DELETE /api/scans/{id}", s.handleDeleteScan)
	mux.HandleFunc("GET /api/scans/{id}/overview", s.handleScanOverview)
	mux.HandleFunc("GET /api/scans/{id}/children", s.handleScanChildren)
	mux.HandleFunc("GET /api/scans/{id}/files", s.handleScanFiles)
	mux.HandleFunc("GET /api/scans/{id}/cold-files", s.handleColdFiles)
	mux.HandleFunc("POST /api/scans/{id}/duplicates", s.handleScanDuplicates)
	mux.HandleFunc("GET /api/scans/{id}/export", s.handleScanExport)

	// 文件详情与安全删除
	mux.HandleFunc("GET /api/file/details", s.handleFileDetails)
	mux.HandleFunc("POST /api/files/delete", s.handleDeleteFiles)

	// 在线检查更新与热重启升级
	mux.HandleFunc("GET /api/update/status", s.handleUpdateStatus)
	mux.HandleFunc("POST /api/update/config", s.handleUpdateConfig)
	mux.HandleFunc("POST /api/update/check", s.handleUpdateCheck)
	mux.HandleFunc("POST /api/update/apply", s.handleUpdateApply)

	// 内嵌静态资源服务
	staticSub, err := fs.Sub(web.Assets, ".")
	if err == nil {
		fileServer := http.FileServer(http.FS(staticSub))
		mux.Handle("/", fileServer)
	}

	s.handler = s.corsMiddleware(authMgr.Middleware(mux))
	return s
}

// Handler 返回可直接交给 http.Server 使用的根处理器。
func (s *Server) Handler() http.Handler {
	return s.handler
}

func (s *Server) corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin != "" {
			u, err := url.Parse(origin)
			validOrigin := err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
			sameHost := validOrigin && (u.Host == r.Host || headerMatchesHost(r.Header.Get("X-Forwarded-Host"), u.Host))
			loopbackRemote := isLoopbackRemote(r.RemoteAddr)
			viaUGOSGateway := validOrigin && ((s.cfg != nil && s.cfg.Platform == config.PlatformUGOS && loopbackRemote) || strings.TrimSpace(r.Header.Get("Ugreen-User-ID")) != "")
			sameRefererProxy := false
			if validOrigin && loopbackRemote {
				if ref := strings.TrimSpace(r.Header.Get("Referer")); ref != "" {
					if refURL, refErr := url.Parse(ref); refErr == nil && refURL.Host == u.Host {
						sameRefererProxy = true
					}
				}
			}
			if !sameHost && !viaUGOSGateway && !sameRefererProxy {
				writeJSONError(w, http.StatusForbidden, "跨域请求被拒绝")
				return
			}
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}
		}
		next.ServeHTTP(w, r)
	})
}

func headerMatchesHost(rawHeader, targetHost string) bool {
	if rawHeader == "" || targetHost == "" {
		return false
	}
	for _, part := range strings.Split(rawHeader, ",") {
		if strings.TrimSpace(part) == targetHost {
			return true
		}
	}
	return false
}

func isLoopbackRemote(remoteAddr string) bool {
	host := strings.TrimSpace(remoteAddr)
	if host == "" {
		return false
	}
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func (s *Server) savedPathStrings() []string {
	saved, err := s.database.GetSavedFolders()
	if err != nil {
		return nil
	}
	out := make([]string, 0, len(saved))
	for _, f := range saved {
		out = append(out, f.Path)
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeJSONOk(w http.ResponseWriter, data any) {
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"data":    data,
	})
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]any{
		"success": false,
		"error":   message,
	})
}

func parsePathID(raw string) (int64, bool) {
	id, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

func decodeJSONBody(r *http.Request, dst any) error {
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, 2*1024*1024))
	return dec.Decode(dst)
}
