package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"spacemap/internal/auth"
	"spacemap/internal/config"
	"spacemap/internal/db"
	"spacemap/internal/scanner"
	"spacemap/internal/scheduler"
	"spacemap/internal/server"
	"spacemap/internal/updater"
)

func main() {
	cfg := config.Load()

	database, err := db.Open(cfg.DataDir)
	if err != nil {
		log.Fatalf("初始化数据库失败: %v", err)
	}

	authMgr := auth.New(database)
	scanMgr := scanner.NewManager(database)
	sched := scheduler.New(cfg, database, scanMgr)
	sched.Start()

	restartCh := make(chan string, 1)
	upd := updater.New(cfg, database, scanMgr.IsRunning, func(execPath string) {
		select {
		case restartCh <- execPath:
		default:
		}
	})
	upd.StartBackgroundCheck()

	srv := server.New(cfg, database, authMgr, scanMgr, sched, upd)
	httpServer := &http.Server{
		Addr:              ":" + cfg.Port,
		Handler:           srv.Handler(),
		ReadHeaderTimeout: 15 * time.Second,
	}

	log.Printf("SpaceMap %s 启动成功 [%s]，监听端口 %s，数据目录 %s", cfg.Version, cfg.Platform.Label(), cfg.Port, cfg.DataDir)

	errCh := make(chan error, 1)
	go func() {
		if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			errCh <- err
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		log.Printf("收到退出信号 %v，正在优雅停止...", sig)
		upd.Stop()
		sched.Stop()
		scanMgr.Cancel(false)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = httpServer.Shutdown(ctx)
		cancel()
		_ = database.Close()
	case err := <-errCh:
		upd.Stop()
		sched.Stop()
		_ = database.Close()
		log.Fatalf("HTTP 服务异常退出: %v", err)
	case execPath := <-restartCh:
		log.Printf("即将同 PID 热重启新版本: %s", execPath)
		time.Sleep(500 * time.Millisecond)
		upd.Stop()
		sched.Stop()
		scanMgr.Cancel(false)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		_ = httpServer.Shutdown(ctx)
		cancel()
		_ = database.Close()

		if err := syscall.Exec(execPath, os.Args, os.Environ()); err != nil {
			log.Printf("热重启 syscall.Exec 失败，尝试回滚旧版本: %v", err)
			bakPath := execPath + ".bak"
			if _, statErr := os.Stat(bakPath); statErr == nil {
				_ = os.Rename(bakPath, execPath)
			}
			log.Fatalf("热重启失败: %v", err)
		}
	}
}
