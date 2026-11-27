package updater

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"spacemap/internal/config"
	"spacemap/internal/db"
)

const (
	defaultRepo         = "Danborad/spacemap"
	settingKeyConfig    = "update_config"
	maxBinarySizeBytes  = 64 * 1024 * 1024
	maxManifestBytes    = 2 * 1024 * 1024
	backgroundCheckWait = 15 * time.Second
	backgroundInterval  = 6 * time.Hour
)

// UpdateConfig 描述应用在线更新设置。
type UpdateConfig struct {
	Repo        string `json:"repo"`
	ProxyPrefix string `json:"proxyPrefix"`
	AutoCheck   bool   `json:"autoCheck"`
}

// UpdateStatus 描述当前更新检测与执行状态。
type UpdateStatus struct {
	CurrentVersion string `json:"currentVersion"`
	LatestVersion  string `json:"latestVersion"`
	HasUpdate      bool   `json:"hasUpdate"`
	CanSelfUpdate  bool   `json:"canSelfUpdate"`
	SelfUpdateTip  string `json:"selfUpdateTip"`
	Arch           string `json:"arch"`
	Platform       string `json:"platform"`
	PlatformLabel  string `json:"platformLabel"`
	RepoURL        string `json:"repoUrl"`
	ReleaseURL     string `json:"releaseUrl"`
	ReleaseNotes   string `json:"releaseNotes"`
	PublishedAt    string `json:"publishedAt"`
	DownloadURL           string `json:"downloadUrl"`
	ChecksumURL           string `json:"checksumUrl"`
	AssetName             string `json:"assetName"`
	PackageAssetName      string `json:"packageAssetName"`
	PackageDownloadURL    string `json:"packageDownloadUrl"`
	DownloadedPackagePath string `json:"downloadedPackagePath"`
	CheckedAt             int64  `json:"checkedAt"`
	State                 string `json:"state"` // idle | checking | available | up_to_date | downloading | verifying | restarting | downloaded | error
	ProgressPct           int    `json:"progressPct"`
	Downloaded            int64  `json:"downloaded"`
	TotalBytes            int64  `json:"totalBytes"`
	Message               string `json:"message"`
}

// Manager 管理版本检查、SHA-256 与 ELF 校验及原子替换热重启。
type Manager struct {
	cfg        *config.Config
	database   *db.DB
	isScanning func() bool
	onRestart  func(execPath string)
	httpClient *http.Client

	// 可在单元测试中注入覆盖
	execPathOverride string
	archOverride     string
	qpkgConfPath     string
	githubAPIBase    string
	githubWebBase    string

	mu              sync.Mutex
	conf            UpdateConfig
	status          UpdateStatus
	checksumMayMiss bool
	stopCh          chan struct{}
}

var errNoReleasePublished = errors.New("no_release_published")

// New 创建更新管理器。
func New(cfg *config.Config, database *db.DB, isScanning func() bool, onRestart func(execPath string)) *Manager {
	m := &Manager{
		cfg:           cfg,
		database:      database,
		isScanning:    isScanning,
		onRestart:     onRestart,
		httpClient:    &http.Client{Timeout: 45 * time.Second},
		githubAPIBase: "https://api.github.com",
		githubWebBase: "https://github.com",
		conf: UpdateConfig{
			Repo:      defaultRepo,
			AutoCheck: true,
		},
	}
	m.loadConfigFromDB()
	m.initStatus()
	return m
}

func (m *Manager) targetArch() string {
	if m.archOverride != "" {
		return m.archOverride
	}
	return runtime.GOARCH
}

func (m *Manager) targetAssetName() string {
	return "spacemap-linux-" + m.targetArch()
}

func (m *Manager) targetUGOSPackageName(version string) string {
	clean := strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(version), "v"), "V")
	if clean == "" {
		return ""
	}
	return fmt.Sprintf("SpaceMap_%s_%s.upk", clean, m.targetArch())
}

func (m *Manager) resolveRepoURL(repo string) string {
	r := strings.TrimSpace(repo)
	if r == "" {
		r = defaultRepo
	}
	if strings.HasPrefix(r, "http://") || strings.HasPrefix(r, "https://") {
		return r
	}
	webBase := strings.TrimRight(m.githubWebBase, "/")
	if webBase == "" {
		webBase = "https://github.com"
	}
	return fmt.Sprintf("%s/%s", webBase, strings.Trim(r, "/"))
}

func (m *Manager) initStatus() {
	canUpdate, tip, _ := m.detectSelfUpdateCapability()
	repo := m.GetConfig().Repo
	m.mu.Lock()
	defer m.mu.Unlock()
	m.status = UpdateStatus{
		CurrentVersion: m.cfg.Version,
		CanSelfUpdate:  canUpdate,
		SelfUpdateTip:  tip,
		Arch:           m.targetArch(),
		Platform:       string(m.cfg.Platform),
		PlatformLabel:  m.cfg.Platform.Label(),
		RepoURL:        m.resolveRepoURL(repo),
		AssetName:      m.targetAssetName(),
		State:          "idle",
	}
}

func (m *Manager) loadConfigFromDB() {
	if m.database == nil {
		return
	}
	raw, err := m.database.GetSetting(settingKeyConfig)
	if err != nil || strings.TrimSpace(raw) == "" {
		return
	}
	var loaded UpdateConfig
	if json.Unmarshal([]byte(raw), &loaded) == nil {
		loaded.Repo = strings.TrimSpace(loaded.Repo)
		if loaded.Repo == "" {
			loaded.Repo = defaultRepo
		}
		loaded.ProxyPrefix = strings.TrimSpace(loaded.ProxyPrefix)
		m.mu.Lock()
		m.conf = loaded
		m.mu.Unlock()
	}
}

// GetConfig 返回当前更新配置。
func (m *Manager) GetConfig() UpdateConfig {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.conf
}

// SaveConfig 保存更新配置并立即生效。
func (m *Manager) SaveConfig(next UpdateConfig) (UpdateConfig, error) {
	next.Repo = strings.TrimSpace(next.Repo)
	if next.Repo == "" {
		next.Repo = defaultRepo
	}
	next.ProxyPrefix = strings.TrimSpace(next.ProxyPrefix)

	b, err := json.Marshal(next)
	if err != nil {
		return UpdateConfig{}, err
	}
	if m.database != nil {
		if err := m.database.SetSetting(settingKeyConfig, string(b)); err != nil {
			return UpdateConfig{}, err
		}
	}
	m.mu.Lock()
	m.conf = next
	m.mu.Unlock()
	return next, nil
}

// GetStatus 返回最新更新状态快照（包含实时自更新权限评估）。
func (m *Manager) GetStatus() UpdateStatus {
	canUpdate, tip, _ := m.detectSelfUpdateCapability()
	repo := m.GetConfig().Repo
	m.mu.Lock()
	defer m.mu.Unlock()
	st := m.status
	st.CurrentVersion = m.cfg.Version
	st.CanSelfUpdate = canUpdate
	st.SelfUpdateTip = tip
	st.Arch = m.targetArch()
	st.Platform = string(m.cfg.Platform)
	st.PlatformLabel = m.cfg.Platform.Label()
	st.RepoURL = m.resolveRepoURL(repo)
	if st.AssetName == "" {
		st.AssetName = m.targetAssetName()
	}
	return st
}

// StartBackgroundCheck 启动后台静默检查更新循环。
func (m *Manager) StartBackgroundCheck() {
	m.mu.Lock()
	if m.stopCh != nil {
		m.mu.Unlock()
		return
	}
	ch := make(chan struct{})
	m.stopCh = ch
	m.mu.Unlock()

	go func() {
		firstTimer := time.NewTimer(backgroundCheckWait)
		ticker := time.NewTicker(backgroundInterval)
		defer firstTimer.Stop()
		defer ticker.Stop()

		for {
			select {
			case <-ch:
				return
			case <-firstTimer.C:
				if m.GetConfig().AutoCheck {
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					if _, err := m.Check(ctx); err != nil {
						log.Printf("后台检查更新失败（已忽略）: %v", err)
					}
					cancel()
				}
			case <-ticker.C:
				if m.GetConfig().AutoCheck {
					ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
					if _, err := m.Check(ctx); err != nil {
						log.Printf("定时检查更新失败（已忽略）: %v", err)
					}
					cancel()
				}
			}
		}
	}()
}

// Stop 停止后台检查任务。
func (m *Manager) Stop() {
	m.mu.Lock()
	ch := m.stopCh
	m.stopCh = nil
	m.mu.Unlock()
	if ch != nil {
		close(ch)
	}
}

func (m *Manager) resolveExecutablePath() (string, error) {
	if m.execPathOverride != "" {
		return m.execPathOverride, nil
	}
	p, err := os.Executable()
	if err != nil {
		return "", err
	}
	if realP, err := filepath.EvalSymlinks(p); err == nil {
		return realP, nil
	}
	return p, nil
}

func (m *Manager) detectSelfUpdateCapability() (bool, string, string) {
	if m.cfg.Platform == config.PlatformDocker {
		return false, "Docker 容器环境请拉取最新镜像并重建容器完成更新", ""
	}
	execPath, err := m.resolveExecutablePath()
	if err != nil || execPath == "" {
		return false, "无法定位当前程序可执行文件路径，请手动安装新版本", ""
	}
	dir := filepath.Dir(execPath)
	probe, err := os.CreateTemp(dir, ".spacemap.probe.*")
	if err != nil {
		if m.cfg.Platform == config.PlatformUGOS {
			return false, "绿联沙箱安装目录为只读，支持一键下载最新 .upk 到授权共享文件夹（含 SHA-256 校验），再于应用中心手动覆盖安装", execPath
		}
		return false, fmt.Sprintf("当前运行用户对目录 %s 无写入权限，请通过 NAS 应用中心手动覆盖安装", dir), execPath
	}
	probeName := probe.Name()
	_ = probe.Close()
	_ = os.Remove(probeName)

	switch m.cfg.Platform {
	case config.PlatformFnOS:
		return true, "支持套件内直接热更新并保留飞牛授权目录配置（注：飞牛应用中心卡片静态版本号仍以安装包 manifest 为准）", execPath
	case config.PlatformQNAP:
		return true, "支持套件内直接热更新并同步刷新威联通 App Center 版本记录", execPath
	case config.PlatformUGOS:
		return true, "支持套件内直接热更新并保留绿联授权目录配置", execPath
	default:
		return true, "支持在线热更新并同 PID 重启服务", execPath
	}
}

// CompareVersion 比较两个语义化版本号，a > b 返回 1，a < b 返回 -1，相等返回 0。
func CompareVersion(a, b string) int {
	pa := parseSemverParts(a)
	pb := parseSemverParts(b)
	maxLen := len(pa)
	if len(pb) > maxLen {
		maxLen = len(pb)
	}
	for i := 0; i < maxLen; i++ {
		var va, vb int
		if i < len(pa) {
			va = pa[i]
		}
		if i < len(pb) {
			vb = pb[i]
		}
		if va > vb {
			return 1
		}
		if va < vb {
			return -1
		}
	}
	return 0
}

func parseSemverParts(v string) []int {
	v = strings.TrimSpace(v)
	v = strings.TrimPrefix(strings.TrimPrefix(v, "v"), "V")
	if idx := strings.IndexAny(v, "-+"); idx >= 0 {
		v = v[:idx]
	}
	if v == "" {
		return []int{0}
	}
	segs := strings.Split(v, ".")
	out := make([]int, len(segs))
	for i, s := range segs {
		n, err := strconv.Atoi(strings.TrimSpace(s))
		if err == nil && n >= 0 {
			out[i] = n
		}
	}
	return out
}

// ApplyProxy 为外部下载链接拼接可选代理前缀。
func ApplyProxy(rawURL, proxyPrefix string) string {
	rawURL = strings.TrimSpace(rawURL)
	prefix := strings.TrimSpace(proxyPrefix)
	if prefix == "" || rawURL == "" {
		return rawURL
	}
	if !strings.HasPrefix(prefix, "http://") && !strings.HasPrefix(prefix, "https://") {
		prefix = "https://" + prefix
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	if strings.HasPrefix(rawURL, prefix) {
		return rawURL
	}
	return prefix + rawURL
}

type githubRelease struct {
	TagName     string `json:"tag_name"`
	Version     string `json:"version"`
	Name        string `json:"name"`
	HTMLURL     string `json:"html_url"`
	Body        string `json:"body"`
	PublishedAt string `json:"published_at"`
	Assets      []struct {
		Name               string `json:"name"`
		BrowserDownloadURL string `json:"browser_download_url"`
		Size               int64  `json:"size"`
	} `json:"assets"`
}

// Check 立即检查最新版本。
func (m *Manager) Check(ctx context.Context) (UpdateStatus, error) {
	conf := m.GetConfig()
	canUpdate, tip, _ := m.detectSelfUpdateCapability()
	expectedAsset := m.targetAssetName()

	m.mu.Lock()
	if m.status.State == "downloading" || m.status.State == "verifying" || m.status.State == "restarting" {
		cur := m.status
		m.mu.Unlock()
		return cur, errors.New("正在执行更新，请稍候")
	}
	m.status.State = "checking"
	m.status.Message = "正在检查最新版本..."
	m.status.CanSelfUpdate = canUpdate
	m.status.SelfUpdateTip = tip
	m.status.Arch = m.targetArch()
	m.status.AssetName = expectedAsset
	m.mu.Unlock()

	var rel *githubRelease
	var err error
	fromWebRedirect := false

	rawRepo := strings.TrimSpace(conf.Repo)
	if strings.HasPrefix(rawRepo, "http://") || strings.HasPrefix(rawRepo, "https://") {
		rel, err = m.fetchRelease(ctx, rawRepo, conf.ProxyPrefix)
	} else {
		repoSlug := strings.Trim(rawRepo, "/")
		apiBase := strings.TrimRight(m.githubAPIBase, "/")
		if apiBase == "" {
			apiBase = "https://api.github.com"
		}
		apiURL := fmt.Sprintf("%s/repos/%s/releases/latest", apiBase, repoSlug)
		rel, err = m.fetchRelease(ctx, apiURL, conf.ProxyPrefix)
		if err != nil && !errors.Is(err, errNoReleasePublished) {
			// api.github.com 遇到 403 限流或网络异常时，自动降级到免限流的 github.com/<repo>/releases/latest 302 重定向检测
			if webRel, webErr := m.fetchReleaseViaWebRedirect(ctx, repoSlug, conf.ProxyPrefix, expectedAsset); webErr == nil || errors.Is(webErr, errNoReleasePublished) {
				rel = webRel
				err = webErr
				fromWebRedirect = webErr == nil
			}
		}
	}

	if errors.Is(err, errNoReleasePublished) {
		repoURL := m.resolveRepoURL(conf.Repo)
		relURL := ""
		if !strings.HasPrefix(rawRepo, "http://") && !strings.HasPrefix(rawRepo, "https://") {
			relURL = strings.TrimRight(repoURL, "/") + "/releases"
		}
		m.mu.Lock()
		m.status.CurrentVersion = m.cfg.Version
		m.status.LatestVersion = ""
		m.status.HasUpdate = false
		m.status.CanSelfUpdate = canUpdate
		m.status.SelfUpdateTip = tip
		m.status.RepoURL = repoURL
		m.status.ReleaseURL = relURL
		m.status.ReleaseNotes = ""
		m.status.DownloadURL = ""
		m.status.ChecksumURL = ""
		m.status.PackageAssetName = ""
		m.status.PackageDownloadURL = ""
		m.status.DownloadedPackagePath = ""
		m.status.CheckedAt = time.Now().UnixMilli()
		m.status.State = "up_to_date"
		m.status.Message = fmt.Sprintf("仓库 %s 暂未发布任何 Release（当前版本 v%s）", conf.Repo, m.cfg.Version)
		m.checksumMayMiss = false
		st := m.status
		m.mu.Unlock()
		return st, nil
	}
	if err != nil {
		m.mu.Lock()
		m.status.State = "error"
		m.status.CheckedAt = time.Now().UnixMilli()
		m.status.Message = "检查更新失败: " + err.Error()
		st := m.status
		m.mu.Unlock()
		return st, err
	}

	latestVer := strings.TrimSpace(rel.TagName)
	if latestVer == "" {
		latestVer = strings.TrimSpace(rel.Version)
	}
	latestClean := strings.TrimPrefix(strings.TrimPrefix(latestVer, "v"), "V")

	var dlURL, sumURL, pkgName, pkgURL string
	var assetSize, pkgSize int64
	expectedPkg := strings.ToLower(m.targetUGOSPackageName(latestClean))
	archUpkSuffix := "_" + strings.ToLower(m.targetArch()) + ".upk"
	for _, a := range rel.Assets {
		nameTrim := strings.TrimSpace(a.Name)
		nameLower := strings.ToLower(nameTrim)
		if a.Name == expectedAsset || nameLower == expectedAsset {
			dlURL = a.BrowserDownloadURL
			assetSize = a.Size
		} else if nameLower == "checksums.txt" || nameLower == "sha256sums.txt" {
			sumURL = a.BrowserDownloadURL
		} else if m.cfg.Platform == config.PlatformUGOS && strings.HasSuffix(nameLower, ".upk") {
			if (expectedPkg != "" && nameLower == expectedPkg) || (pkgURL == "" && strings.HasSuffix(nameLower, archUpkSuffix)) {
				pkgName = nameTrim
				pkgURL = a.BrowserDownloadURL
				pkgSize = a.Size
			}
		}
	}

	hasUpdate := latestClean != "" && CompareVersion(latestClean, m.cfg.Version) > 0
	state := "up_to_date"
	msg := fmt.Sprintf("当前已是最新版本 v%s", m.cfg.Version)
	if hasUpdate {
		state = "available"
		if m.cfg.Platform == config.PlatformUGOS && !canUpdate && pkgURL != "" {
			msg = fmt.Sprintf("发现新版本 v%s，支持一键下载 .upk 安装包到授权共享目录", latestClean)
		} else if dlURL != "" {
			msg = fmt.Sprintf("发现新版本 v%s，支持直接下载热更新", latestClean)
		} else {
			msg = fmt.Sprintf("发现新版本 v%s，但该发布暂未包含 %s 安装包", latestClean, expectedAsset)
		}
	}

	displayTotal := assetSize
	if m.cfg.Platform == config.PlatformUGOS && !canUpdate && pkgSize > 0 {
		displayTotal = pkgSize
	}

	m.mu.Lock()
	m.status.CurrentVersion = m.cfg.Version
	m.status.LatestVersion = latestClean
	m.status.HasUpdate = hasUpdate
	m.status.CanSelfUpdate = canUpdate
	m.status.SelfUpdateTip = tip
	m.status.RepoURL = m.resolveRepoURL(conf.Repo)
	m.status.ReleaseURL = rel.HTMLURL
	m.status.ReleaseNotes = rel.Body
	m.status.PublishedAt = rel.PublishedAt
	m.status.DownloadURL = dlURL
	m.status.ChecksumURL = sumURL
	m.status.AssetName = expectedAsset
	m.status.PackageAssetName = pkgName
	m.status.PackageDownloadURL = pkgURL
	if hasUpdate && m.status.DownloadedPackagePath != "" && filepath.Base(m.status.DownloadedPackagePath) != pkgName {
		m.status.DownloadedPackagePath = ""
	}
	m.status.TotalBytes = displayTotal
	m.status.Downloaded = 0
	m.status.ProgressPct = 0
	m.status.CheckedAt = time.Now().UnixMilli()
	m.status.State = state
	m.status.Message = msg
	m.checksumMayMiss = fromWebRedirect
	out := m.status
	m.mu.Unlock()
	return out, nil
}

func (m *Manager) fetchReleaseViaWebRedirect(ctx context.Context, repoSlug, proxyPrefix, expectedAsset string) (*githubRelease, error) {
	webBase := strings.TrimRight(m.githubWebBase, "/")
	if webBase == "" {
		webBase = "https://github.com"
	}
	latestURL := fmt.Sprintf("%s/%s/releases/latest", webBase, repoSlug)

	noRedirect := &http.Client{
		Timeout:   20 * time.Second,
		Transport: m.httpClient.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}

	urls := make([]string, 0, 2)
	if proxyPrefix != "" {
		urls = append(urls, ApplyProxy(latestURL, proxyPrefix))
	}
	urls = append(urls, latestURL)

	var lastErr error
	for _, u := range urls {
		for _, method := range []string{http.MethodHead, http.MethodGet} {
			req, err := http.NewRequestWithContext(ctx, method, u, nil)
			if err != nil {
				lastErr = err
				break
			}
			req.Header.Set("User-Agent", "SpaceMap-Updater/"+m.cfg.Version)
			resp, err := noRedirect.Do(req)
			if err != nil {
				lastErr = err
				break
			}
			_ = resp.Body.Close()

			if resp.StatusCode == http.StatusMethodNotAllowed && method == http.MethodHead {
				continue
			}
			if resp.StatusCode == http.StatusNotFound {
				return nil, errNoReleasePublished
			}
			if resp.StatusCode >= 300 && resp.StatusCode < 400 {
				loc := strings.TrimSpace(resp.Header.Get("Location"))
				if loc == "" {
					lastErr = errors.New("302 响应缺少 Location")
					break
				}
				if idx := strings.Index(loc, "/releases/tag/"); idx >= 0 {
					rawTag := loc[idx+len("/releases/tag/"):]
					if qIdx := strings.IndexAny(rawTag, "?#"); qIdx >= 0 {
						rawTag = rawTag[:qIdx]
					}
					rawTag = strings.Trim(rawTag, "/")
					tag, unescErr := url.PathUnescape(rawTag)
					if unescErr != nil || tag == "" {
						tag = rawTag
					}
					if tag == "" {
						return nil, errNoReleasePublished
					}
					pkgAssetName := m.targetUGOSPackageName(tag)
					assets := []struct {
						Name               string `json:"name"`
						BrowserDownloadURL string `json:"browser_download_url"`
						Size               int64  `json:"size"`
					}{
						{
							Name:               expectedAsset,
							BrowserDownloadURL: fmt.Sprintf("%s/%s/releases/download/%s/%s", webBase, repoSlug, tag, expectedAsset),
						},
						{
							Name:               "checksums.txt",
							BrowserDownloadURL: fmt.Sprintf("%s/%s/releases/download/%s/checksums.txt", webBase, repoSlug, tag),
						},
					}
					if pkgAssetName != "" {
						assets = append(assets, struct {
							Name               string `json:"name"`
							BrowserDownloadURL string `json:"browser_download_url"`
							Size               int64  `json:"size"`
						}{
							Name:               pkgAssetName,
							BrowserDownloadURL: fmt.Sprintf("%s/%s/releases/download/%s/%s", webBase, repoSlug, tag, pkgAssetName),
						})
					}
					rel := &githubRelease{
						TagName: tag,
						HTMLURL: fmt.Sprintf("%s/%s/releases/tag/%s", webBase, repoSlug, tag),
						Body:    "已通过 GitHub Releases 免限流跳转通道检测到最新版本",
						Assets:  assets,
					}
					return rel, nil
				}
				cleanLoc := strings.TrimRight(loc, "/")
				if strings.HasSuffix(cleanLoc, "/releases") {
					return nil, errNoReleasePublished
				}
			}
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			break
		}
	}
	if lastErr == nil {
		lastErr = errors.New("无法通过重定向检测最新版本")
	}
	return nil, lastErr
}

func (m *Manager) fetchRelease(ctx context.Context, apiURL, proxyPrefix string) (*githubRelease, error) {
	urls := make([]string, 0, 2)
	if proxyPrefix != "" {
		urls = append(urls, ApplyProxy(apiURL, proxyPrefix))
	}
	urls = append(urls, apiURL)

	var lastErr error
	for _, u := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "SpaceMap-Updater/"+m.cfg.Version)

		resp, err := m.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, maxManifestBytes))
		_ = resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode == http.StatusNotFound {
			return nil, errNoReleasePublished
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
			continue
		}
		var rel githubRelease
		if err := json.Unmarshal(body, &rel); err != nil {
			lastErr = fmt.Errorf("解析版本信息失败: %w", err)
			continue
		}
		return &rel, nil
	}
	if lastErr == nil {
		lastErr = errors.New("无法连接更新源")
	}
	return nil, lastErr
}

// StartApply 校验条件并异步启动下载替换热重启流程。
func (m *Manager) StartApply() error {
	if m.isScanning != nil && m.isScanning() {
		return errors.New("当前正在执行目录扫描，请等待扫描完成或先取消后再更新")
	}
	canUpdate, tip, _ := m.detectSelfUpdateCapability()
	if !canUpdate {
		return errors.New(tip)
	}

	m.mu.Lock()
	if m.status.State == "downloading" || m.status.State == "verifying" || m.status.State == "restarting" {
		m.mu.Unlock()
		return errors.New("更新任务正在执行中，请勿重复触发")
	}
	needCheck := m.status.CheckedAt == 0 || m.status.DownloadURL == ""
	if !needCheck && !m.status.HasUpdate {
		m.mu.Unlock()
		return errors.New("当前已是最新版本，无需更新")
	}
	m.status.State = "downloading"
	m.status.ProgressPct = 0
	m.status.Downloaded = 0
	m.status.Message = "正在准备下载新版本..."
	m.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if err := m.applyInternal(ctx, needCheck); err != nil {
			log.Printf("在线更新失败: %v", err)
			m.mu.Lock()
			m.status.State = "error"
			m.status.Message = err.Error()
			m.mu.Unlock()
		}
	}()
	return nil
}

// ApplySync 同步执行完整更新流程（主要用于单元测试）。
func (m *Manager) ApplySync(ctx context.Context) error {
	if m.isScanning != nil && m.isScanning() {
		return errors.New("当前正在执行目录扫描，请等待扫描完成或先取消后再更新")
	}
	canUpdate, tip, _ := m.detectSelfUpdateCapability()
	if !canUpdate {
		return errors.New(tip)
	}
	m.mu.Lock()
	needCheck := m.status.CheckedAt == 0 || m.status.DownloadURL == ""
	m.mu.Unlock()
	err := m.applyInternal(ctx, needCheck)
	if err != nil {
		m.mu.Lock()
		m.status.State = "error"
		m.status.Message = err.Error()
		m.mu.Unlock()
	}
	return err
}

func (m *Manager) applyInternal(ctx context.Context, needCheck bool) error {
	if needCheck {
		// 临时允许 Check 执行
		m.mu.Lock()
		m.status.State = "idle"
		m.mu.Unlock()
		if _, err := m.Check(ctx); err != nil {
			return err
		}
	}

	canUpdate, tip, selfPath := m.detectSelfUpdateCapability()
	if !canUpdate {
		return errors.New(tip)
	}

	m.mu.Lock()
	st := m.status
	conf := m.conf
	checksumOptional := m.checksumMayMiss
	if !st.HasUpdate {
		m.mu.Unlock()
		return errors.New("当前已是最新版本，无需更新")
	}
	if st.DownloadURL == "" {
		m.mu.Unlock()
		return fmt.Errorf("未找到适用于当前架构 (%s) 的发布包 %s", st.Arch, st.AssetName)
	}
	m.status.State = "downloading"
	m.status.ProgressPct = 0
	m.status.Downloaded = 0
	m.status.Message = "正在下载新版本安装包..."
	m.mu.Unlock()

	expectedHash := ""
	if st.ChecksumURL != "" {
		sum, err := m.fetchExpectedSHA256(ctx, st.ChecksumURL, conf.ProxyPrefix, st.AssetName)
		if err != nil {
			if !(checksumOptional && errors.Is(err, errNoReleasePublished)) {
				return fmt.Errorf("获取 SHA-256 校验清单失败: %w", err)
			}
			log.Printf("未在当前 Release 中找到 checksums.txt（404），将继续使用 ELF 魔数与架构校验")
		} else {
			expectedHash = sum
		}
	}

	tmpPath := filepath.Join(filepath.Dir(selfPath), ".spacemap.update.tmp")
	_ = os.Remove(tmpPath)
	defer func() {
		// 若尚未原子重命名成功，清理临时文件
		_ = os.Remove(tmpPath)
	}()

	gotHash, err := m.downloadWithProgress(ctx, st.DownloadURL, conf.ProxyPrefix, tmpPath, st.TotalBytes)
	if err != nil {
		return fmt.Errorf("下载新版本失败: %w", err)
	}

	m.mu.Lock()
	m.status.State = "verifying"
	m.status.ProgressPct = 100
	m.status.Message = "正在校验 SHA-256 与可执行文件架构..."
	m.mu.Unlock()

	if expectedHash != "" && !strings.EqualFold(gotHash, expectedHash) {
		return fmt.Errorf("SHA-256 校验不匹配（期望 %s，实际 %s），已中止更新", expectedHash, gotHash)
	}
	if err := validateELFBinary(tmpPath, m.targetArch()); err != nil {
		return fmt.Errorf("二进制完整性校验失败: %w", err)
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return fmt.Errorf("设置可执行权限失败: %w", err)
	}

	bakPath := selfPath + ".bak"
	_ = os.Remove(bakPath)
	if linkErr := os.Link(selfPath, bakPath); linkErr != nil {
		if cpErr := copyFile(selfPath, bakPath, 0o755); cpErr != nil {
			return fmt.Errorf("备份旧版本失败: %w", cpErr)
		}
	}

	if err := os.Rename(tmpPath, selfPath); err != nil {
		return fmt.Errorf("原子替换程序文件失败: %w", err)
	}

	if m.cfg.Platform == config.PlatformQNAP {
		m.syncQNAPVersion(st.LatestVersion)
	}

	m.mu.Lock()
	m.status.State = "restarting"
	m.status.ProgressPct = 100
	m.status.Message = fmt.Sprintf("v%s 已就绪，正在同 PID 平滑重启服务...", st.LatestVersion)
	m.mu.Unlock()

	if m.onRestart != nil {
		m.onRestart(selfPath)
	}
	return nil
}

// StartDownloadPackage 异步下载当前平台套件包（如绿联 .upk）到指定已授权可写目录并校验 SHA-256。
func (m *Manager) StartDownloadPackage(targetDir string) error {
	targetDir = strings.TrimSpace(targetDir)
	info, err := os.Stat(targetDir)
	if err != nil || !info.IsDir() {
		return errors.New("目标保存路径不存在或不是目录")
	}
	if !config.IsPathWritable(targetDir) {
		return errors.New("目标目录没有写入权限，请在绿联应用配置中设为读写权限")
	}

	m.mu.Lock()
	if m.status.State == "downloading" || m.status.State == "verifying" || m.status.State == "restarting" {
		m.mu.Unlock()
		return errors.New("正在下载或更新中，请勿重复触发")
	}
	needCheck := m.status.CheckedAt == 0 || m.status.PackageDownloadURL == ""
	if !needCheck && !m.status.HasUpdate {
		m.mu.Unlock()
		return errors.New("当前已是最新版本，无需下载安装包")
	}
	m.status.State = "downloading"
	m.status.ProgressPct = 0
	m.status.Downloaded = 0
	m.status.DownloadedPackagePath = ""
	m.status.Message = "正在准备下载 .upk 安装包..."
	m.mu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, err := m.downloadPackageInternal(ctx, targetDir, needCheck); err != nil {
			log.Printf("下载 .upk 安装包失败: %v", err)
			m.mu.Lock()
			m.status.State = "error"
			m.status.Message = err.Error()
			m.mu.Unlock()
		}
	}()
	return nil
}

// DownloadPackageSync 同步下载套件包到目标目录并校验 SHA-256（主要用于单元测试）。
func (m *Manager) DownloadPackageSync(ctx context.Context, targetDir string) (string, error) {
	targetDir = strings.TrimSpace(targetDir)
	info, err := os.Stat(targetDir)
	if err != nil || !info.IsDir() {
		return "", errors.New("目标保存路径不存在或不是目录")
	}
	if !config.IsPathWritable(targetDir) {
		return "", errors.New("目标目录没有写入权限")
	}
	m.mu.Lock()
	needCheck := m.status.CheckedAt == 0 || m.status.PackageDownloadURL == ""
	m.mu.Unlock()

	finalPath, err := m.downloadPackageInternal(ctx, targetDir, needCheck)
	if err != nil {
		m.mu.Lock()
		m.status.State = "error"
		m.status.Message = err.Error()
		m.mu.Unlock()
		return "", err
	}
	return finalPath, nil
}

func (m *Manager) downloadPackageInternal(ctx context.Context, targetDir string, needCheck bool) (string, error) {
	if needCheck {
		m.mu.Lock()
		m.status.State = "idle"
		m.mu.Unlock()
		if _, err := m.Check(ctx); err != nil {
			return "", err
		}
	}

	m.mu.Lock()
	st := m.status
	conf := m.conf
	checksumOptional := m.checksumMayMiss
	if !st.HasUpdate {
		m.mu.Unlock()
		return "", errors.New("当前已是最新版本，无需下载安装包")
	}
	if st.PackageDownloadURL == "" || st.PackageAssetName == "" {
		m.mu.Unlock()
		return "", fmt.Errorf("当前发布暂未包含适用于 %s 架构的 .upk 安装包", st.Arch)
	}
	m.status.State = "downloading"
	m.status.ProgressPct = 0
	m.status.Downloaded = 0
	m.status.DownloadedPackagePath = ""
	m.status.Message = fmt.Sprintf("正在下载 %s...", st.PackageAssetName)
	m.mu.Unlock()

	expectedHash := ""
	if st.ChecksumURL != "" {
		sum, err := m.fetchExpectedSHA256(ctx, st.ChecksumURL, conf.ProxyPrefix, st.PackageAssetName)
		if err != nil {
			if !(checksumOptional && errors.Is(err, errNoReleasePublished)) {
				return "", fmt.Errorf("获取 SHA-256 校验清单失败: %w", err)
			}
			log.Printf("未在当前 Release 中找到 checksums.txt（404），跳过校验")
		} else {
			expectedHash = sum
		}
	}

	tmpPath := filepath.Join(targetDir, "."+st.PackageAssetName+".tmp")
	finalPath := filepath.Join(targetDir, filepath.Base(st.PackageAssetName))
	_ = os.Remove(tmpPath)
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	gotHash, err := m.downloadWithProgress(ctx, st.PackageDownloadURL, conf.ProxyPrefix, tmpPath, st.TotalBytes)
	if err != nil {
		return "", fmt.Errorf("下载 .upk 安装包失败: %w", err)
	}

	m.mu.Lock()
	m.status.State = "verifying"
	m.status.ProgressPct = 100
	m.status.Message = "正在校验 .upk 安装包 SHA-256..."
	m.mu.Unlock()

	if expectedHash != "" && !strings.EqualFold(gotHash, expectedHash) {
		return "", fmt.Errorf("SHA-256 校验不匹配（期望 %s，实际 %s），已中止保存", expectedHash, gotHash)
	}
	if err := os.Chmod(tmpPath, 0o644); err != nil {
		return "", fmt.Errorf("设置安装包权限失败: %w", err)
	}
	if err := os.Rename(tmpPath, finalPath); err != nil {
		return "", fmt.Errorf("保存安装包到共享目录失败: %w", err)
	}

	m.mu.Lock()
	m.status.State = "downloaded"
	m.status.ProgressPct = 100
	m.status.DownloadedPackagePath = finalPath
	m.status.Message = fmt.Sprintf("安装包已下载并校验完成：%s", finalPath)
	m.mu.Unlock()
	return finalPath, nil
}

func (m *Manager) fetchExpectedSHA256(ctx context.Context, checksumURL, proxyPrefix, assetName string) (string, error) {
	urls := make([]string, 0, 2)
	if proxyPrefix != "" {
		urls = append(urls, ApplyProxy(checksumURL, proxyPrefix))
	}
	urls = append(urls, checksumURL)

	var lastErr error
	for _, u := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("User-Agent", "SpaceMap-Updater/"+m.cfg.Version)
		resp, err := m.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		body, readErr := io.ReadAll(io.LimitReader(resp.Body, 1024*1024))
		_ = resp.Body.Close()
		if readErr != nil {
			lastErr = readErr
			continue
		}
		if resp.StatusCode == http.StatusNotFound {
			lastErr = errNoReleasePublished
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			continue
		}

		scanner := bufio.NewScanner(strings.NewReader(string(body)))
		for scanner.Scan() {
			fields := strings.Fields(scanner.Text())
			if len(fields) < 2 {
				continue
			}
			hashHex := strings.TrimSpace(fields[0])
			name := strings.TrimPrefix(strings.TrimSpace(fields[1]), "*")
			if filepath.Base(name) == assetName || name == assetName {
				if len(hashHex) == 64 {
					return strings.ToLower(hashHex), nil
				}
			}
		}
		lastErr = fmt.Errorf("checksums.txt 中未包含 %s 的校验值", assetName)
	}
	return "", lastErr
}

func (m *Manager) downloadWithProgress(ctx context.Context, dlURL, proxyPrefix, dstPath string, expectedSize int64) (string, error) {
	urls := make([]string, 0, 2)
	if proxyPrefix != "" {
		urls = append(urls, ApplyProxy(dlURL, proxyPrefix))
	}
	urls = append(urls, dlURL)

	var lastErr error
	for _, u := range urls {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			lastErr = err
			continue
		}
		req.Header.Set("User-Agent", "SpaceMap-Updater/"+m.cfg.Version)

		resp, err := m.httpClient.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			_ = resp.Body.Close()
			lastErr = fmt.Errorf("HTTP %d", resp.StatusCode)
			continue
		}

		total := resp.ContentLength
		if total <= 0 {
			total = expectedSize
		}
		m.mu.Lock()
		m.status.TotalBytes = total
		m.status.Downloaded = 0
		m.status.ProgressPct = 0
		m.mu.Unlock()

		f, err := os.OpenFile(dstPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			_ = resp.Body.Close()
			return "", err
		}

		hasher := sha256.New()
		buf := make([]byte, 32*1024)
		var written int64
		var lastReport time.Time
		limitedReader := io.LimitReader(resp.Body, maxBinarySizeBytes+1)

		var copyErr error
		for {
			nr, er := limitedReader.Read(buf)
			if nr > 0 {
				if written+int64(nr) > maxBinarySizeBytes {
					copyErr = fmt.Errorf("安装包体积超过上限 %d MB", maxBinarySizeBytes/(1024*1024))
					break
				}
				nw, ew := f.Write(buf[:nr])
				if ew != nil {
					copyErr = ew
					break
				}
				if nw != nr {
					copyErr = io.ErrShortWrite
					break
				}
				_, _ = hasher.Write(buf[:nr])
				written += int64(nw)

				now := time.Now()
				if now.Sub(lastReport) >= 150*time.Millisecond {
					lastReport = now
					pct := 0
					if total > 0 {
						pct = int(written * 100 / total)
						if pct > 99 {
							pct = 99
						}
					}
					m.mu.Lock()
					m.status.Downloaded = written
					m.status.ProgressPct = pct
					m.mu.Unlock()
				}
			}
			if er != nil {
				if er != io.EOF {
					copyErr = er
				}
				break
			}
		}
		_ = f.Close()
		_ = resp.Body.Close()

		if copyErr != nil {
			_ = os.Remove(dstPath)
			lastErr = copyErr
			continue
		}
		if written == 0 {
			_ = os.Remove(dstPath)
			lastErr = errors.New("下载文件为空")
			continue
		}

		m.mu.Lock()
		m.status.Downloaded = written
		m.status.TotalBytes = written
		m.status.ProgressPct = 100
		m.mu.Unlock()

		return hex.EncodeToString(hasher.Sum(nil)), nil
	}
	if lastErr == nil {
		lastErr = errors.New("下载失败")
	}
	return "", lastErr
}

func validateELFBinary(path, expectedArch string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()

	var hdr [20]byte
	if _, err := io.ReadFull(f, hdr[:]); err != nil {
		return fmt.Errorf("文件过小，不是有效 ELF 可执行文件: %w", err)
	}
	if hdr[0] != 0x7f || hdr[1] != 'E' || hdr[2] != 'L' || hdr[3] != 'F' {
		return errors.New("文件头魔数非 ELF 格式（可能下载到了错误页面）")
	}
	// 小端读取 e_machine (offset 18..19)
	machine := binary.LittleEndian.Uint16(hdr[18:20])
	switch expectedArch {
	case "amd64":
		if machine != 0x003e {
			return fmt.Errorf("架构不匹配：需要 amd64 (0x3e)，实际为 0x%x", machine)
		}
	case "arm64":
		if machine != 0x00b7 {
			return fmt.Errorf("架构不匹配：需要 arm64 (0xb7)，实际为 0x%x", machine)
		}
	}
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()

	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

func (m *Manager) syncQNAPVersion(version string) {
	if version == "" {
		return
	}
	setcfgPath := "/sbin/setcfg"
	if _, err := os.Stat(setcfgPath); err != nil {
		return
	}
	confPath := m.qpkgConfPath
	if confPath == "" {
		confPath = "/etc/config/qpkg.conf"
	}
	if _, err := os.Stat(confPath); err != nil {
		return
	}
	_ = exec.Command(setcfgPath, "SpaceMap", "Version", version, "-f", confPath).Run()
}
