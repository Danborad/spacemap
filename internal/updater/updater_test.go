package updater

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"

	"spacemap/internal/config"
	"spacemap/internal/db"
)

func makeFakeELF(arch string, payloadTag string) []byte {
	buf := make([]byte, 128)
	copy(buf[:4], []byte{0x7f, 'E', 'L', 'F'})
	var machine uint16 = 0x003e
	if arch == "arm64" {
		machine = 0x00b7
	}
	binary.LittleEndian.PutUint16(buf[18:20], machine)
	copy(buf[32:], []byte(payloadTag))
	return buf
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

func TestCompareVersionAndProxy(t *testing.T) {
	if CompareVersion("2.3.1", "2.3.0") != 1 {
		t.Fatalf("expected 2.3.1 > 2.3.0")
	}
	if CompareVersion("v2.3.0", "2.3.0") != 0 {
		t.Fatalf("expected v2.3.0 == 2.3.0")
	}
	if CompareVersion("2.2.9", "2.3.0") != -1 {
		t.Fatalf("expected 2.2.9 < 2.3.0")
	}
	if CompareVersion("2.3.0-beta.1", "2.3.0") != 0 {
		t.Fatalf("expected suffix ignored")
	}

	got := ApplyProxy("https://github.com/Danborad/spacemap/releases/download/v2.3.1/a", "ghfast.top")
	if got != "https://ghfast.top/https://github.com/Danborad/spacemap/releases/download/v2.3.1/a" {
		t.Fatalf("unexpected proxy url: %s", got)
	}
}

func TestCheckAndApplyUpdateFlow(t *testing.T) {
	tmp := t.TempDir()
	dataDir := filepath.Join(tmp, "data")
	binDir := filepath.Join(tmp, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	execPath := filepath.Join(binDir, "spacemap")
	oldBin := makeFakeELF(runtime.GOARCH, "OLD-2.3.0")
	if err := os.WriteFile(execPath, oldBin, 0o755); err != nil {
		t.Fatal(err)
	}

	newBin := makeFakeELF(runtime.GOARCH, "NEW-2.3.1")
	goodHash := sha256Hex(newBin)
	assetName := "spacemap-linux-" + runtime.GOARCH

	var serveBadHash atomic.Bool
	var serveNonELF atomic.Bool

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			rel := map[string]any{
				"tag_name":     "v2.3.1",
				"html_url":     srv.URL + "/releases/v2.3.1",
				"body":         "修复若干问题并优化体验",
				"published_at": "2026-11-26T00:00:00Z",
				"assets": []map[string]any{
					{
						"name":                 assetName,
						"browser_download_url": srv.URL + "/download/" + assetName,
						"size":                 len(newBin),
					},
					{
						"name":                 "checksums.txt",
						"browser_download_url": srv.URL + "/download/checksums.txt",
						"size":                 128,
					},
				},
			}
			_ = json.NewEncoder(w).Encode(rel)
		case "/download/checksums.txt":
			h := goodHash
			if serveBadHash.Load() {
				h = strings.Repeat("0", 64)
			} else if serveNonELF.Load() {
				h = sha256Hex([]byte("not an elf binary at all"))
			}
			_, _ = fmt.Fprintf(w, "%s  %s\n", h, assetName)
		case "/download/" + assetName:
			if serveNonELF.Load() {
				_, _ = w.Write([]byte("not an elf binary at all"))
				return
			}
			_, _ = w.Write(newBin)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	database, err := db.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	cfg := &config.Config{
		DataDir:  dataDir,
		Platform: config.PlatformFnOS,
		Version:  "2.3.0",
	}

	var restartedPath string
	mgr := New(cfg, database, func() bool { return false }, func(p string) {
		restartedPath = p
	})
	mgr.execPathOverride = execPath

	if _, err := mgr.SaveConfig(UpdateConfig{
		Repo:      srv.URL + "/manifest.json",
		AutoCheck: false,
	}); err != nil {
		t.Fatal(err)
	}

	// 1. 检查更新应发现 v2.3.1
	st, err := mgr.Check(context.Background())
	if err != nil {
		t.Fatalf("Check failed: %v", err)
	}
	if !st.HasUpdate || st.LatestVersion != "2.3.1" || !st.CanSelfUpdate {
		t.Fatalf("unexpected status: %+v", st)
	}

	// 2. SHA-256 不匹配必须被拒绝，原二进制保持不变
	serveBadHash.Store(true)
	if err := mgr.ApplySync(context.Background()); err == nil || !strings.Contains(err.Error(), "SHA-256") {
		t.Fatalf("expected SHA-256 mismatch error, got: %v", err)
	}
	gotCur, _ := os.ReadFile(execPath)
	if string(gotCur) != string(oldBin) {
		t.Fatalf("binary modified on bad sha256")
	}
	serveBadHash.Store(false)

	// 3. 非 ELF 可执行文件必须被拒绝
	serveNonELF.Store(true)
	if err := mgr.ApplySync(context.Background()); err == nil || !strings.Contains(err.Error(), "ELF") {
		t.Fatalf("expected ELF validation error, got: %v", err)
	}
	serveNonELF.Store(false)

	// 4. 合法二进制与正确 SHA-256：应成功原子替换、保留 .bak 并触发重启回调
	if err := mgr.ApplySync(context.Background()); err != nil {
		t.Fatalf("ApplySync failed: %v", err)
	}
	if restartedPath != execPath {
		t.Fatalf("expected restart callback with %s, got %q", execPath, restartedPath)
	}
	updatedBytes, _ := os.ReadFile(execPath)
	if string(updatedBytes) != string(newBin) {
		t.Fatalf("expected updated binary written")
	}
	bakBytes, err := os.ReadFile(execPath + ".bak")
	if err != nil || string(bakBytes) != string(oldBin) {
		t.Fatalf("expected backup binary kept, err=%v", err)
	}

	// 5. Docker 环境禁止就地覆盖自更新
	dockerCfg := &config.Config{
		DataDir:  dataDir,
		Platform: config.PlatformDocker,
		Version:  "2.3.0",
	}
	dockerMgr := New(dockerCfg, database, nil, nil)
	if dockerMgr.GetStatus().CanSelfUpdate {
		t.Fatalf("expected Docker canSelfUpdate false")
	}
}

func TestFallbackToWebRedirectOnRateLimit(t *testing.T) {
	tmp := t.TempDir()
	dataDir := filepath.Join(tmp, "data")
	binDir := filepath.Join(tmp, "bin")
	if err := os.MkdirAll(binDir, 0o755); err != nil {
		t.Fatal(err)
	}
	execPath := filepath.Join(binDir, "spacemap")
	if err := os.WriteFile(execPath, makeFakeELF(runtime.GOARCH, "OLD"), 0o755); err != nil {
		t.Fatal(err)
	}

	var noReleaseMode atomic.Bool
	apiSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"message":"API rate limit exceeded"}`))
	}))
	defer apiSrv.Close()

	webSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/Danborad/spacemap/releases/latest" {
			if noReleaseMode.Load() {
				w.Header().Set("Location", "/Danborad/spacemap/releases")
			} else {
				w.Header().Set("Location", "/Danborad/spacemap/releases/tag/v2.4.0")
			}
			w.WriteHeader(http.StatusFound)
			return
		}
		http.NotFound(w, r)
	}))
	defer webSrv.Close()

	database, err := db.Open(dataDir)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()

	cfg := &config.Config{
		DataDir:  dataDir,
		Platform: config.PlatformFnOS,
		Version:  "2.3.1",
	}
	mgr := New(cfg, database, nil, nil)
	mgr.execPathOverride = execPath
	mgr.githubAPIBase = apiSrv.URL
	mgr.githubWebBase = webSrv.URL

	// 1. 403 限流时自动降级到 Web 302 解析出 v2.4.0
	st, err := mgr.Check(context.Background())
	if err != nil {
		t.Fatalf("expected fallback succeed, got err: %v", err)
	}
	if !st.HasUpdate || st.LatestVersion != "2.4.0" {
		t.Fatalf("expected HasUpdate=true and v2.4.0, got %+v", st)
	}
	expectedDL := webSrv.URL + "/Danborad/spacemap/releases/download/v2.4.0/spacemap-linux-" + runtime.GOARCH
	if st.DownloadURL != expectedDL {
		t.Fatalf("expected download url %s, got %s", expectedDL, st.DownloadURL)
	}

	// 2. 仓库尚无 Release（302 -> /releases）应正常返回 up_to_date 而非报错
	noReleaseMode.Store(true)
	st2, err := mgr.Check(context.Background())
	if err != nil {
		t.Fatalf("expected no error when no releases exist, got: %v", err)
	}
	if st2.HasUpdate || st2.State != "up_to_date" {
		t.Fatalf("expected up_to_date when no release published, got %+v", st2)
	}
	if st2.RepoURL != webSrv.URL+"/Danborad/spacemap" || st2.ReleaseURL != webSrv.URL+"/Danborad/spacemap/releases" {
		t.Fatalf("expected repoUrl and releaseUrl populated, got repo=%q release=%q", st2.RepoURL, st2.ReleaseURL)
	}
}
