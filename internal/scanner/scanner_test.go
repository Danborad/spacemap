package scanner_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"spacemap/internal/auth"
	"spacemap/internal/config"
	"spacemap/internal/db"
	"spacemap/internal/scanner"
)

func TestScanHardlinksDuplicatesAndDeleteSync(t *testing.T) {
	tmpRoot := t.TempDir()
	dataDir := filepath.Join(tmpRoot, "_data")
	scanRoot := filepath.Join(tmpRoot, "nas_share")
	subA := filepath.Join(scanRoot, "movies")
	subB := filepath.Join(scanRoot, "backups")
	if err := os.MkdirAll(subA, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(subB, 0o755); err != nil {
		t.Fatal(err)
	}

	// 1. 创建原文件与硬链接（总大小 2MB，物理实际占用应为 1MB）
	payload1 := make([]byte, 1024*1024)
	for i := range payload1 {
		payload1[i] = byte((i * 13) % 251)
	}
	origFile := filepath.Join(subA, "video.mkv")
	hardLinkFile := filepath.Join(subB, "video_link.mkv")
	if err := os.WriteFile(origFile, payload1, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(origFile, hardLinkFile); err != nil {
		t.Fatal(err)
	}

	// 2. 创建内容完全相同但不同名的独立副本（应被识别为重复文件）
	payload2 := make([]byte, 512*1024)
	for i := range payload2 {
		payload2[i] = byte((i * 7 + 3) % 239)
	}
	dup1 := filepath.Join(subA, "archive_a.zip")
	dup2 := filepath.Join(subB, "archive_renamed.zip")
	if err := os.WriteFile(dup1, payload2, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dup2, payload2, 0o644); err != nil {
		t.Fatal(err)
	}

	// 3. 将 dup1 修改为 300 天前，用于验证冷数据筛选
	oldTime := time.Now().Add(-300 * 24 * time.Hour)
	if err := os.Chtimes(dup1, oldTime, oldTime); err != nil {
		t.Fatal(err)
	}

	database, err := db.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	mgr := scanner.NewManager(database)
	scanID, err := mgr.ScanSync(context.Background(), scanRoot, 32)
	if err != nil {
		t.Fatalf("ScanSync failed: %v", err)
	}

	rec, err := database.GetScanByID(scanID)
	if err != nil || rec == nil {
		t.Fatalf("GetScanByID failed: %v", err)
	}

	// 逻辑大小 = 1MB + 1MB + 512KB + 512KB = 3MB
	// 实际去重大小 = 1MB + 512KB + 512KB = 2MB，硬链接节省 = 1MB
	if rec.TotalFiles != 4 {
		t.Fatalf("expected 4 files, got %d", rec.TotalFiles)
	}
	if rec.TotalSize != 3*1024*1024 {
		t.Fatalf("expected totalSize 3MB, got %d", rec.TotalSize)
	}
	if rec.UniqueSize != 2*1024*1024 {
		t.Fatalf("expected uniqueSize 2MB, got %d", rec.UniqueSize)
	}
	if rec.HardlinkSaved != 1024*1024 {
		t.Fatalf("expected hardlinkSaved 1MB, got %d", rec.HardlinkSaved)
	}

	// 验证精确查重：只应发现 dup1/dup2 一组，不应把硬链接算作重复释放空间
	report, err := scanner.FindDuplicates(context.Background(), database, scanID, 1024)
	if err != nil {
		t.Fatalf("FindDuplicates failed: %v", err)
	}
	if report.GroupCount != 1 {
		t.Fatalf("expected 1 duplicate group, got %d", report.GroupCount)
	}
	if report.ReclaimableBytes != 512*1024 {
		t.Fatalf("expected 512KB reclaimable, got %d", report.ReclaimableBytes)
	}

	// 验证冷数据查询
	cutoff := time.Now().Add(-180 * 24 * time.Hour).Unix()
	cold, totalCold, err := database.QueryFiles(db.FileQuery{
		ScanID:      scanID,
		MaxMtimeSec: cutoff,
		Page:        1,
		PageSize:    20,
	})
	if err != nil || totalCold != 1 || len(cold) != 1 || cold[0].Name != "archive_a.zip" {
		t.Fatalf("unexpected cold files: total=%d, items=%+v, err=%v", totalCold, cold, err)
	}

	// 验证删除文件并同步更新扫描统计与目录大小
	if err := os.Remove(dup2); err != nil {
		t.Fatal(err)
	}
	if err := database.RemoveDeletedFileFromScans(dup2); err != nil {
		t.Fatal(err)
	}
	recAfter, _ := database.GetScanByID(scanID)
	if recAfter.TotalFiles != 3 || recAfter.UniqueSize != 2*1024*1024-512*1024 {
		t.Fatalf("expected stats updated after delete, got %+v", recAfter)
	}
	// 验证类型统计缓存与删除同步扣减及旧数据自动回填
	stats, err := database.GetScanTypeStats(scanID)
	if err != nil || len(stats) == 0 {
		t.Fatalf("GetScanTypeStats failed: %v %+v", err, stats)
	}
	var archiveSize int64
	for _, st := range stats {
		if st.Type == "archive" {
			archiveSize = st.Size
		}
	}
	if archiveSize != 512*1024 {
		t.Fatalf("expected archive size 512KB after delete, got %d", archiveSize)
	}
	// 模拟老版本未建缓存表时清空缓存并触发自动回填
	if _, err := database.Conn().Exec(`DELETE FROM scan_type_stats WHERE scan_id = ?`, scanID); err != nil {
		t.Fatal(err)
	}
	backfilled, err := database.GetScanTypeStats(scanID)
	if err != nil || len(backfilled) != len(stats) {
		t.Fatalf("expected backfill stats match, got %+v err=%v", backfilled, err)
	}
	var cachedCnt int
	_ = database.Conn().QueryRow(`SELECT COUNT(*) FROM scan_type_stats WHERE scan_id = ?`, scanID).Scan(&cachedCnt)
	if cachedCnt == 0 {
		t.Fatalf("expected scan_type_stats auto-populated on miss")
	}
	folders, _, _ := database.GetDirectChildren(scanID, scanRoot, 20)
	for _, f := range folders {
		if f.Name == "backups" && f.Size != 1024*1024 {
			t.Fatalf("expected backups folder size reduced to 1MB, got %d", f.Size)
		}
	}

	// 验证密码认证与旧配置迁移兼容
	authMgr := auth.New(database)
	if err := authMgr.SetPassword("", "secret123"); err != nil {
		t.Fatal(err)
	}
	ok, err := authMgr.VerifyPassword("secret123")
	if err != nil || !ok {
		t.Fatalf("password verify failed: ok=%v err=%v", ok, err)
	}
	if config.IsPathInside(dup1, scanRoot) == false {
		t.Fatalf("expected IsPathInside true")
	}
}

func TestCancelScanKeepPartialAndDiscard(t *testing.T) {
	tmpRoot := t.TempDir()
	dataDir := filepath.Join(tmpRoot, "_data")
	scanRoot := filepath.Join(tmpRoot, "bigshare")
	for d := 0; d < 25; d++ {
		dir := filepath.Join(scanRoot, fmt.Sprintf("dir_%02d", d))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		for f := 0; f < 40; f++ {
			if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f_%02d.bin", f)), []byte("abc"), 0o644); err != nil {
				t.Fatal(err)
			}
		}
	}

	database, err := db.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	mgr := scanner.NewManager(database)
	ch := mgr.Subscribe()
	defer mgr.Unsubscribe(ch)

	// 1. 取消并保留部分快照
	scanID1, err := mgr.StartAsync(scanRoot, 32)
	if err != nil {
		t.Fatal(err)
	}
	// 等到扫描启动后立即带 keepPartial=true 取消
	time.Sleep(3 * time.Millisecond)
	mgr.Cancel(true)

	var final1 scanner.ProgressSnapshot
	deadline := time.After(5 * time.Second)
	for {
		select {
		case snap := <-ch:
			if !snap.Running && snap.ScanID == scanID1 {
				final1 = snap
				goto done1
			}
		case <-deadline:
			t.Fatal("timeout waiting for keep-partial cancel")
		}
	}
done1:
	if final1.Status != "partial" && final1.Status != "completed" {
		t.Fatalf("expected partial or completed status, got %s", final1.Status)
	}
	rec1, _ := database.GetScanByID(scanID1)
	if rec1 == nil || !rec1.HasDetails {
		t.Fatalf("expected partial scan to keep details, got %+v", rec1)
	}

	// 2. 取消并丢弃数据（后台异步清理）
	scanID2, err := mgr.StartAsync(scanRoot, 32)
	if err != nil {
		t.Fatal(err)
	}
	time.Sleep(3 * time.Millisecond)
	mgr.Cancel(false)

	var final2 scanner.ProgressSnapshot
	deadline2 := time.After(5 * time.Second)
	for {
		select {
		case snap := <-ch:
			if !snap.Running && snap.ScanID == scanID2 {
				final2 = snap
				goto done2
			}
		case <-deadline2:
			t.Fatal("timeout waiting for discard cancel")
		}
	}
done2:
	if final2.Status != "cancelled" && final2.Status != "completed" {
		t.Fatalf("expected cancelled or completed status, got %s", final2.Status)
	}
}
