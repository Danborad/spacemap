package config_test

import (
	"os"
	"path/filepath"
	"testing"

	"spacemap/internal/config"
)

func TestRuntimeEnvHotReload(t *testing.T) {
	tmp := t.TempDir()
	dataDir := filepath.Join(tmp, "data")
	dirA := filepath.Join(tmp, "SSD")
	dirB := filepath.Join(tmp, "Media")
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dirA, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dirB, 0o755); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{
		DataDir:  dataDir,
		Platform: config.PlatformFnOS,
		Version:  config.DefaultVersion,
	}

	// 初始空文件：应无目录
	envPath := filepath.Join(dataDir, "fnos_paths.env")
	if err := os.WriteFile(envPath, []byte("TRIM_DATA_ACCESSIBLE_PATHS=\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if roots := cfg.DiscoverRoots(); len(roots) != 0 {
		t.Fatalf("expected 0 roots initially, got %d", len(roots))
	}

	// 模拟飞牛 config_callback 写入新增授权路径，无需重启进程立即生效
	if err := os.WriteFile(envPath, []byte("TRIM_DATA_ACCESSIBLE_PATHS="+dirA+":"+dirB+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	roots := cfg.DiscoverRoots()
	if len(roots) != 2 {
		t.Fatalf("expected 2 hot-reloaded roots, got %d (%+v)", len(roots), roots)
	}
}

func TestDiscoverQNAPSharesFiltering(t *testing.T) {
	tmp := t.TempDir()
	shareRoot := filepath.Join(tmp, "share")
	cache1 := filepath.Join(shareRoot, "CACHEDEV1_DATA")
	publicDir := filepath.Join(cache1, "Public")
	workDir := filepath.Join(cache1, "Work")
	extDir := filepath.Join(shareRoot, "external", ".nd", "0", "010746800-uuid")

	for _, d := range []string{
		publicDir,
		workDir,
		extDir,
		filepath.Join(shareRoot, "HDP_DATA"),
		filepath.Join(shareRoot, "HDZ_DATA"),
		filepath.Join(shareRoot, "NFSv=4"),
		filepath.Join(shareRoot, "homes"),
	} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(publicDir, filepath.Join(shareRoot, "Public")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(workDir, filepath.Join(shareRoot, "Work")); err != nil {
		t.Fatal(err)
	}

	smbConf := filepath.Join(tmp, "smb.conf")
	smbContent := `
[global]
workgroup = WORKGROUP

[homes]
path = ` + filepath.Join(shareRoot, "homes") + `

[Public]
path = ` + publicDir + `

[Work]
path = ` + workDir + `

[绿联DXP4800]
path = ` + extDir + `
`
	if err := os.WriteFile(smbConf, []byte(smbContent), 0o644); err != nil {
		t.Fatal(err)
	}

	var got []string
	config.DiscoverQNAPSharesFrom(smbConf, shareRoot, func(rawPath, displayName, source string) {
		got = append(got, displayName+"="+rawPath)
	})
	if len(got) != 3 {
		t.Fatalf("expected 3 shares from smb.conf, got %d: %v", len(got), got)
	}
	if got[2] != "绿联DXP4800="+extDir {
		t.Fatalf("expected display name preserved for external share, got %q", got[2])
	}

	// 无 smb.conf 时回退：应过滤 HDP_DATA/HDZ_DATA/CACHEDEV1_DATA/NFSv=4/external/homes，仅保留软链接共享
	var fallback []string
	config.DiscoverQNAPSharesFrom(filepath.Join(tmp, "missing.conf"), shareRoot, func(rawPath, displayName, source string) {
		fallback = append(fallback, displayName)
	})
	if len(fallback) != 2 || fallback[0] != "Public" || fallback[1] != "Work" {
		t.Fatalf("expected [Public Work] on fallback, got %v", fallback)
	}
}

func TestDiscoverUGOSSharedDirs(t *testing.T) {
	tmp := t.TempDir()
	sharedDir := filepath.Join(tmp, "ug_shared")
	realShare := filepath.Join(tmp, "volume1", "Media")
	subPlain := filepath.Join(sharedDir, "Docs")
	for _, d := range []string{sharedDir, realShare, subPlain, filepath.Join(sharedDir, ".hidden"), filepath.Join(sharedDir, "@tmp")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(realShare, filepath.Join(sharedDir, "Media")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(sharedDir, "ignore.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}

	t.Setenv("UGAPP_SHARED_DIR", sharedDir)
	t.Setenv("UGAPP_DATA_DIR", filepath.Join(tmp, "ug_data"))

	if gotPlat := config.DetectPlatform(); gotPlat != config.PlatformUGOS {
		t.Fatalf("expected PlatformUGOS, got %s", gotPlat)
	}

	cfg := &config.Config{
		DataDir:  filepath.Join(tmp, "ug_data"),
		Platform: config.PlatformUGOS,
		Version:  config.DefaultVersion,
	}
	roots := cfg.DiscoverRoots()
	if len(roots) != 2 {
		t.Fatalf("expected 2 authorized UGOS roots, got %d (%+v)", len(roots), roots)
	}
	names := map[string]string{}
	for _, r := range roots {
		names[r.Name] = r.Source
	}
	if names["Media"] != "ugos:shared" || names["Docs"] != "ugos:shared" {
		t.Fatalf("unexpected UGOS roots: %+v", roots)
	}
}

func TestUGOSDynamicPortAndScanPaths(t *testing.T) {
	tmp := t.TempDir()
	dataDir := filepath.Join(tmp, "ug_data")
	sharedDir := filepath.Join(tmp, "ug_shared")
	cacheDir := filepath.Join(tmp, "ug_cache")
	dirA := filepath.Join(tmp, "volume1", "Video")
	dirB := filepath.Join(tmp, "volume1", "Photo")
	dirC := filepath.Join(tmp, "volume2", "Backup")
	for _, d := range []string{dataDir, sharedDir, cacheDir, dirA, dirB, dirC} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(dirA, filepath.Join(sharedDir, "Video")); err != nil {
		t.Fatal(err)
	}

	// 验证动态端口变量回退链 PORT -> APP_HTTP_PORT -> UGAPP_PORT_HTTP 及 UGAPP_CACHE_DIR -> TMPDIR
	t.Setenv("PORT", "")
	t.Setenv("APP_HTTP_PORT", "")
	t.Setenv("UGAPP_PORT_HTTP", "31080")
	t.Setenv("TMPDIR", "")
	t.Setenv("UGAPP_CACHE_DIR", cacheDir)
	t.Setenv("UGAPP_DATA_DIR", dataDir)
	t.Setenv("UGAPP_SHARED_DIR", sharedDir)

	cfg := config.Load()
	if cfg.Port != "31080" {
		t.Fatalf("expected UGAPP_PORT_HTTP 31080, got %s", cfg.Port)
	}
	if gotTmp := os.Getenv("TMPDIR"); gotTmp != cacheDir {
		t.Fatalf("expected TMPDIR=%s, got %s", cacheDir, gotTmp)
	}

	t.Setenv("APP_HTTP_PORT", "32080")
	if cfg2 := config.Load(); cfg2.Port != "32080" {
		t.Fatalf("expected APP_HTTP_PORT 32080 to override UGAPP_PORT_HTTP, got %s", cfg2.Port)
	}

	t.Setenv("PORT", "33080")
	if cfg3 := config.Load(); cfg3.Port != "33080" {
		t.Fatalf("expected PORT 33080 to take highest priority, got %s", cfg3.Port)
	}

	// JSON 数组格式 + 与 UGAPP_SHARED_DIR 去重合并
	t.Setenv("SCAN_PATHS", `["`+dirA+`","`+dirB+`"]`)
	rootsJSON := cfg.DiscoverRoots()
	if len(rootsJSON) != 2 {
		t.Fatalf("expected 2 merged roots (deduped), got %d (%+v)", len(rootsJSON), rootsJSON)
	}

	// 逗号与冒号分隔格式
	t.Setenv("SCAN_PATHS", dirB+","+dirC+":"+dirA)
	rootsDelim := cfg.DiscoverRoots()
	if len(rootsDelim) != 3 {
		t.Fatalf("expected 3 merged roots with delimiter parsing, got %d (%+v)", len(rootsDelim), rootsDelim)
	}
}

func TestDiscoverUGOSVolumeNestedShares(t *testing.T) {
	tmp := t.TempDir()
	sharedDir := filepath.Join(tmp, "ug_shared")

	share1 := filepath.Join(sharedDir, "volume1", "share1")
	share2 := filepath.Join(sharedDir, "volume2", "share2")
	share3 := filepath.Join(sharedDir, "volume3", "share3")
	dupVol1 := filepath.Join(sharedDir, "volume1", "Media")
	dupVol2 := filepath.Join(sharedDir, "volume2", "Media")
	emptyVol4 := filepath.Join(sharedDir, "volume4")
	for _, d := range []string{share1, share2, share3, dupVol1, dupVol2, emptyVol4} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	var got []config.RootEntry
	config.DiscoverUGOSSharedFrom(sharedDir, func(rawPath, displayName, source string) {
		got = append(got, config.RootEntry{Path: rawPath, Name: displayName, Source: source})
	})

	if len(got) != 5 {
		t.Fatalf("expected 5 expanded UGOS shares (excluding empty volume4 and volume containers), got %d: %+v", len(got), got)
	}
	names := map[string]string{}
	for _, r := range got {
		names[r.Name] = r.Path
	}
	if names["share1"] != share1 || names["share2"] != share2 || names["share3"] != share3 {
		t.Fatalf("expected share1/share2/share3 directly discovered, got: %+v", got)
	}
	if names["Media (volume1)"] != dupVol1 || names["Media (volume2)"] != dupVol2 {
		t.Fatalf("expected duplicate share names disambiguated with volume name, got: %+v", got)
	}
}
