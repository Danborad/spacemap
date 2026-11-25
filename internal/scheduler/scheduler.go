package scheduler

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"time"

	"spacemap/internal/config"
	"spacemap/internal/db"
	"spacemap/internal/scanner"
)

// ScheduleConfig 描述自动定时扫描计划。
type ScheduleConfig struct {
	Enabled       bool     `json:"enabled"`
	Mode          string   `json:"mode"` // daily | weekly | interval
	Hour          int      `json:"hour"`
	Minute        int      `json:"minute"`
	Weekday       int      `json:"weekday"`       // 0=周日 ... 6=周六
	IntervalHours int      `json:"intervalHours"` // 间隔小时数
	Paths         []string `json:"paths"`         // 为空时扫描所有已配置路径
	LastRunAt     int64    `json:"lastRunAt"`
	LastStatus    string   `json:"lastStatus"`
}

// Service 管理后台定时扫描任务。
type Service struct {
	cfg      *config.Config
	database *db.DB
	scanMgr  *scanner.Manager

	mu      sync.Mutex
	current ScheduleConfig
	stopCh  chan struct{}
}

// New 创建定时扫描服务。
func New(cfg *config.Config, database *db.DB, scanMgr *scanner.Manager) *Service {
	s := &Service{
		cfg:      cfg,
		database: database,
		scanMgr:  scanMgr,
		current: ScheduleConfig{
			Mode:          "daily",
			Hour:          3,
			Minute:        0,
			Weekday:       0,
			IntervalHours: 24,
			Paths:         []string{},
		},
	}
	s.loadFromDB()
	return s
}

func (s *Service) loadFromDB() {
	raw, err := s.database.GetSetting("scan_schedule")
	if err != nil || raw == "" {
		return
	}
	var loaded ScheduleConfig
	if json.Unmarshal([]byte(raw), &loaded) == nil {
		if loaded.Mode == "" {
			loaded.Mode = "daily"
		}
		if loaded.IntervalHours <= 0 {
			loaded.IntervalHours = 24
		}
		if loaded.Paths == nil {
			loaded.Paths = []string{}
		}
		s.mu.Lock()
		s.current = loaded
		s.mu.Unlock()
	}
}

// Get 返回当前调度配置。
func (s *Service) Get() ScheduleConfig {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.current
	out.Paths = append([]string(nil), s.current.Paths...)
	return out
}

// Update 保存并应用新的调度配置。
func (s *Service) Update(next ScheduleConfig) (ScheduleConfig, error) {
	if next.Mode != "daily" && next.Mode != "weekly" && next.Mode != "interval" {
		next.Mode = "daily"
	}
	if next.Hour < 0 || next.Hour > 23 {
		next.Hour = 3
	}
	if next.Minute < 0 || next.Minute > 59 {
		next.Minute = 0
	}
	if next.Weekday < 0 || next.Weekday > 6 {
		next.Weekday = 0
	}
	if next.IntervalHours < 1 {
		next.IntervalHours = 24
	}
	if next.Paths == nil {
		next.Paths = []string{}
	}

	s.mu.Lock()
	next.LastRunAt = s.current.LastRunAt
	next.LastStatus = s.current.LastStatus
	s.current = next
	s.mu.Unlock()

	b, _ := json.Marshal(next)
	if err := s.database.SetSetting("scan_schedule", string(b)); err != nil {
		return next, err
	}
	return next, nil
}

// Start 启动后台定时检查循环。
func (s *Service) Start() {
	s.mu.Lock()
	if s.stopCh != nil {
		s.mu.Unlock()
		return
	}
	s.stopCh = make(chan struct{})
	stopCh := s.stopCh
	s.mu.Unlock()

	go func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopCh:
				return
			case now := <-ticker.C:
				s.checkAndRun(now)
			}
		}
	}()
}

// Stop 停止定时循环。
func (s *Service) Stop() {
	s.mu.Lock()
	if s.stopCh != nil {
		close(s.stopCh)
		s.stopCh = nil
	}
	s.mu.Unlock()
}

func (s *Service) checkAndRun(now time.Time) {
	s.mu.Lock()
	sc := s.current
	s.mu.Unlock()

	if !sc.Enabled || s.scanMgr.IsRunning() {
		return
	}

	lastRun := time.UnixMilli(sc.LastRunAt)
	due := false

	switch sc.Mode {
	case "interval":
		if sc.LastRunAt == 0 || now.Sub(lastRun) >= time.Duration(sc.IntervalHours)*time.Hour {
			due = true
		}
	case "weekly":
		if int(now.Weekday()) == sc.Weekday && now.Hour() == sc.Hour && now.Minute() == sc.Minute {
			if sc.LastRunAt == 0 || now.Sub(lastRun) > 2*time.Minute {
				due = true
			}
		}
	default: // daily
		if now.Hour() == sc.Hour && now.Minute() == sc.Minute {
			if sc.LastRunAt == 0 || now.Sub(lastRun) > 2*time.Minute {
				due = true
			}
		}
	}

	if !due {
		return
	}

	saved, _ := s.database.GetSavedFolders()
	savedList := make([]string, 0, len(saved))
	for _, f := range saved {
		savedList = append(savedList, f.Path)
	}

	targets := sc.Paths
	if len(targets) == 0 {
		roots := s.cfg.GetAuthorizedRoots(savedList)
		for _, r := range roots {
			targets = append(targets, r.Path)
		}
	}
	if len(targets) == 0 {
		return
	}

	s.mu.Lock()
	s.current.LastRunAt = now.UnixMilli()
	s.current.LastStatus = "running"
	s.mu.Unlock()

	statusMsg := "completed"
	for _, p := range targets {
		resolved, _, err := s.cfg.ResolveAuthorizedPath(p, savedList, true, false)
		if err != nil {
			log.Printf("[scheduler] 跳过未授权路径 %s: %v", p, err)
			statusMsg = "partial_error"
			continue
		}
		if _, err := s.scanMgr.ScanSync(context.Background(), resolved, 64); err != nil {
			log.Printf("[scheduler] 定时扫描路径 %s 失败: %v", resolved, err)
			statusMsg = "failed"
		}
	}

	s.mu.Lock()
	s.current.LastStatus = statusMsg
	updated := s.current
	s.mu.Unlock()

	b, _ := json.Marshal(updated)
	_ = s.database.SetSetting("scan_schedule", string(b))
}
