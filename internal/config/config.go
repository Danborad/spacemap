package config

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const DefaultVersion = "2.4.4"

// PlatformType 标识当前运行环境类型。
type PlatformType string

const (
	PlatformFnOS   PlatformType = "fnos"
	PlatformQNAP   PlatformType = "qnap"
	PlatformUGOS   PlatformType = "ugos"
	PlatformDocker PlatformType = "docker"
	PlatformLinux  PlatformType = "linux"
)

// RootEntry 表示一个已发现或已配置的扫描根目录。
type RootEntry struct {
	Path     string `json:"path"`
	Name     string `json:"name"`
	Source   string `json:"source"`
	Writable bool   `json:"writable"`
}

// Config 保存程序运行时全局配置。
type Config struct {
	Port       string
	DataDir    string
	Version    string
	Platform   PlatformType
	AppExecDir string
}

// Load 从环境变量加载运行配置并自动探测当前平台。
func Load() *Config {
	port := firstNonEmptyEnv("PORT", "APP_HTTP_PORT", "UGAPP_PORT_HTTP")
	if port == "" {
		port = "7080"
	}

	if strings.TrimSpace(os.Getenv("TMPDIR")) == "" {
		if cacheDir := strings.TrimSpace(os.Getenv("UGAPP_CACHE_DIR")); cacheDir != "" {
			_ = os.Setenv("TMPDIR", cacheDir)
		}
	}

	dataDir := strings.TrimSpace(os.Getenv("DATA_DIR"))
	if dataDir == "" {
		dataDir = strings.TrimSpace(os.Getenv("UGAPP_DATA_DIR"))
	}
	if dataDir == "" {
		dataDir = filepath.Join(".", "data")
	}
	if absData, err := filepath.Abs(dataDir); err == nil {
		dataDir = absData
	}

	execDir := ""
	if exe, err := os.Executable(); err == nil {
		if realExe, err2 := filepath.EvalSymlinks(exe); err2 == nil {
			execDir = filepath.Dir(realExe)
		} else {
			execDir = filepath.Dir(exe)
		}
	}

	return &Config{
		Port:       port,
		DataDir:    dataDir,
		Version:    readVersion(),
		Platform:   DetectPlatform(),
		AppExecDir: execDir,
	}
}

func readVersion() string {
	if exe, err := os.Executable(); err == nil {
		exeDir := filepath.Dir(exe)
		if b, err := os.ReadFile(filepath.Join(exeDir, "VERSION")); err == nil {
			if v := strings.TrimSpace(string(b)); v != "" {
				return v
			}
		}
	}
	return DefaultVersion
}

// DetectPlatform 自动识别飞牛、威联通、Docker 或通用 Linux 环境。
func DetectPlatform() PlatformType {
	if pathExists("/.dockerenv") || os.Getenv("DOCKER_CONTAINER") != "" {
		return PlatformDocker
	}
	if os.Getenv("UGAPP_DATA_DIR") != "" || os.Getenv("UGAPP_SHARED_DIR") != "" || os.Getenv("UGAPP_INSTALL_DIR") != "" {
		return PlatformUGOS
	}
	if os.Getenv("TRIM_APPDEST") != "" || os.Getenv("TRIM_PKGVAR") != "" || pathExists("/usr/trim") {
		return PlatformFnOS
	}
	if pathExists("/etc/config/qpkg.conf") || pathExists("/share/CACHEDEV1_DATA") || pathExists("/share/ZFS530_DATA") {
		return PlatformQNAP
	}
	return PlatformLinux
}

// Label 返回友好的中文平台名称。
func (p PlatformType) Label() string {
	switch p {
	case PlatformFnOS:
		return "飞牛 fnOS"
	case PlatformQNAP:
		return "威联通 QNAP"
	case PlatformUGOS:
		return "绿联 UGOS Pro"
	case PlatformDocker:
		return "Docker 容器"
	default:
		return "Linux 主机"
	}
}

// DiscoverRoots 自动发现当前环境中可扫描的根目录。
func (c *Config) DiscoverRoots() []RootEntry {
	seen := make(map[string]struct{})
	var out []RootEntry

	addRootNamed := func(rawPath, displayName, source string) {
		rawPath = strings.TrimSpace(rawPath)
		if rawPath == "" {
			return
		}
		abs, err := filepath.Abs(rawPath)
		if err != nil {
			return
		}
		realPath, err := filepath.EvalSymlinks(abs)
		if err != nil {
			realPath = abs
		}
		info, err := os.Stat(realPath)
		if err != nil || !info.IsDir() {
			return
		}
		if c.isProtectedInternalPath(realPath) {
			return
		}
		if _, exists := seen[realPath]; exists {
			return
		}
		seen[realPath] = struct{}{}
		name := strings.TrimSpace(displayName)
		if name == "" {
			name = filepath.Base(abs)
		}
		if name == "" || name == string(filepath.Separator) {
			name = abs
		}
		out = append(out, RootEntry{
			Path:     realPath,
			Name:     name,
			Source:   source,
			Writable: IsPathWritable(realPath),
		})
	}
	addRoot := func(rawPath, source string) {
		addRootNamed(rawPath, "", source)
	}

	// 1. 优先读取运行时热更新及环境变量配置的授权路径（飞牛访问权限为 TRIM_DATA_ACCESSIBLE_PATHS）
	if rawAccessible := c.runtimeEnv("TRIM_DATA_ACCESSIBLE_PATHS"); rawAccessible != "" {
		for _, item := range splitColonPaths(rawAccessible) {
			addRoot(item, "fnos:accessible")
		}
	}
	for _, envKey := range []string{"TRIM_DATA_SHARE_PATHS", "SCAN_PATHS"} {
		raw := c.runtimeEnv(envKey)
		var items []string
		if envKey == "SCAN_PATHS" {
			items = splitEnvPaths(raw)
		} else {
			items = splitColonPaths(raw)
		}
		for _, item := range items {
			addRoot(item, "env:"+envKey)
		}
	}

	// 2. 按平台补充自动发现
	switch c.Platform {
	case PlatformFnOS:
		// 飞牛严格遵循「应用设置 -> 访问权限」授权的文件夹（TRIM_DATA_ACCESSIBLE_PATHS），
		// 不主动扫描系统 /vol* 挂载目录以免混入内部目录。
	case PlatformQNAP:
		DiscoverQNAPSharesFrom("/etc/config/smb.conf", "/share", addRootNamed)
	case PlatformUGOS:
		DiscoverUGOSSharedFrom(os.Getenv("UGAPP_SHARED_DIR"), addRootNamed)
	case PlatformDocker:
		if len(out) == 0 {
			for _, candidate := range []string{"/media", "/host", "/data", "/mnt"} {
				if candidate != c.DataDir {
					addRoot(candidate, "auto:docker")
				}
			}
		}
	default:
		if len(out) == 0 {
			for _, candidate := range []string{"/mnt", "/media", "/srv"} {
				addRoot(candidate, "auto:linux")
			}
		}
	}

	return out
}

type ugosCandidate struct {
	path   string
	name   string
	parent string
}

// DiscoverUGOSSharedFrom 读取绿联 UGOS Pro 系统注入的 UGAPP_SHARED_DIR 下已授权文件夹。
// 绿联通常在 shared/ 下按卷组织目录（如 shared/volume1/share1、shared/usbs/disk1、shared/home/user），
// 顶层容器（如 volume1）往往仅可读，真正被授权读写的共享目录位于其下一层，因此会自动展开到共享目录层级。
func DiscoverUGOSSharedFrom(sharedDir string, addRoot func(rawPath, displayName, source string)) {
	sharedDir = strings.TrimSpace(sharedDir)
	if sharedDir == "" {
		return
	}
	entries, err := os.ReadDir(sharedDir)
	if err != nil {
		return
	}

	var candidates []ugosCandidate
	nameCount := make(map[string]int)
	appendCandidate := func(path, name, parent string) {
		candidates = append(candidates, ugosCandidate{path: path, name: name, parent: parent})
		nameCount[name]++
	}

	for _, ent := range entries {
		name := ent.Name()
		if name == "" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "@") {
			continue
		}
		full := filepath.Join(sharedDir, name)
		info, statErr := os.Stat(full)
		if statErr != nil || !info.IsDir() {
			continue
		}

		switch {
		case isUGOSVolumeContainer(name):
			subEntries, subErr := os.ReadDir(full)
			if subErr != nil {
				continue
			}
			for _, sub := range subEntries {
				subName := sub.Name()
				if subName == "" || strings.HasPrefix(subName, ".") || strings.HasPrefix(subName, "@") {
					continue
				}
				subFull := filepath.Join(full, subName)
				if subInfo, err := os.Stat(subFull); err == nil && subInfo.IsDir() {
					appendCandidate(subFull, subName, name)
				}
			}
		case isUGOSUserContainer(name):
			subEntries, subErr := os.ReadDir(full)
			if subErr != nil {
				continue
			}
			for _, sub := range subEntries {
				subName := sub.Name()
				if subName == "" || strings.HasPrefix(subName, ".") || strings.HasPrefix(subName, "@") {
					continue
				}
				subFull := filepath.Join(full, subName)
				subInfo, err := os.Stat(subFull)
				if err != nil || !subInfo.IsDir() {
					continue
				}
				// 若用户容器目录本身只读且包含授权子目录（例如 home/user/documents），展开到子目录
				expanded := false
				if !IsPathWritable(subFull) {
					if leafEntries, leafErr := os.ReadDir(subFull); leafErr == nil {
						for _, leaf := range leafEntries {
							leafName := leaf.Name()
							if leafName == "" || strings.HasPrefix(leafName, ".") || strings.HasPrefix(leafName, "@") {
								continue
							}
							leafFull := filepath.Join(subFull, leafName)
							if leafInfo, err := os.Stat(leafFull); err == nil && leafInfo.IsDir() {
								appendCandidate(leafFull, leafName, name+"/"+subName)
								expanded = true
							}
						}
					}
				}
				if !expanded {
					appendCandidate(subFull, subName, name)
				}
			}
		default:
			appendCandidate(full, name, "")
		}
	}

	for _, c := range candidates {
		display := c.name
		if nameCount[c.name] > 1 && c.parent != "" {
			display = fmt.Sprintf("%s (%s)", c.name, c.parent)
		}
		addRoot(c.path, display, "ugos:shared")
	}
}

func isUGOSVolumeContainer(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	if lower == "usbs" || lower == "external" {
		return true
	}
	if strings.HasPrefix(lower, "volume") && len(lower) > len("volume") {
		for _, ch := range lower[len("volume"):] {
			if ch < '0' || ch > '9' {
				return false
			}
		}
		return true
	}
	return false
}

func isUGOSUserContainer(name string) bool {
	lower := strings.ToLower(strings.TrimSpace(name))
	return lower == "home" || lower == "users"
}

// DiscoverQNAPSharesFrom 优先解析威联通 /etc/config/smb.conf 中的真实共享文件夹，
// 仅在无法读取或未解析到共享目录时，才回退到过滤后的 /share 软链接扫描。
func DiscoverQNAPSharesFrom(smbConfPath, shareRoot string, addRoot func(rawPath, displayName, source string)) {
	if count := parseQNAPSmbConf(smbConfPath, addRoot); count > 0 {
		return
	}

	entries, err := os.ReadDir(shareRoot)
	if err != nil {
		return
	}
	for _, ent := range entries {
		name := ent.Name()
		if isIgnoredQNAPEntry(name) {
			continue
		}
		// 威联通 /share 下真正的用户共享目录均为符号链接；普通空目录多为系统占位点
		if ent.Type()&os.ModeSymlink == 0 {
			continue
		}
		full := filepath.Join(shareRoot, name)
		addRoot(full, name, "auto:qnap")
	}
}

func parseQNAPSmbConf(smbConfPath string, addRoot func(rawPath, displayName, source string)) int {
	data, err := os.ReadFile(smbConfPath)
	if err != nil {
		return 0
	}

	var curSection string
	var curPath string
	added := 0

	flush := func() {
		if curSection == "" || curPath == "" {
			return
		}
		if isIgnoredQNAPEntry(curSection) || isIgnoredQNAPEntry(filepath.Base(curPath)) {
			return
		}
		addRoot(curPath, curSection, "auto:qnap")
		added++
	}

	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			flush()
			curSection = strings.TrimSpace(line[1 : len(line)-1])
			curPath = ""
			continue
		}
		if curSection == "" {
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		if strings.EqualFold(strings.TrimSpace(k), "path") {
			curPath = strings.TrimSpace(v)
		}
	}
	flush()
	return added
}

func isIgnoredQNAPEntry(name string) bool {
	if name == "" || strings.HasPrefix(name, ".") || strings.HasPrefix(name, "@") {
		return true
	}
	lower := strings.ToLower(strings.TrimSpace(name))
	switch lower {
	case "global", "printers", "print$", "ipc$", "homes", "home", "external", "nfsv=4", "qsync", "snapshot":
		return true
	}
	// 过滤所有威联通底层磁盘/存储池/卷挂载占位目录（如 HDA_DATA..HDZ_DATA、CACHEDEV*_DATA、ZFS*_DATA、MD*_DATA）
	if strings.HasSuffix(strings.ToUpper(name), "_DATA") {
		return true
	}
	return false
}

// runtimeEnv 优先读取飞牛 config_callback 写入的 DATA_DIR/fnos_paths.env，实现免重启热更新；
// 若文件不存在或未定义该键，则回退到进程环境变量。
func (c *Config) runtimeEnv(key string) string {
	if c.DataDir != "" {
		envFile := filepath.Join(c.DataDir, "fnos_paths.env")
		if b, err := os.ReadFile(envFile); err == nil {
			prefix := key + "="
			for _, line := range strings.Split(string(b), "\n") {
				line = strings.TrimRight(line, "\r")
				if strings.HasPrefix(line, prefix) {
					return strings.TrimSpace(strings.TrimPrefix(line, prefix))
				}
			}
		}
	}
	return os.Getenv(key)
}

// IsEnvRestricted 判断当前是否由环境变量限定了扫描白名单作用域。
func (c *Config) IsEnvRestricted() bool {
	return strings.TrimSpace(c.runtimeEnv("TRIM_DATA_ACCESSIBLE_PATHS")) != "" ||
		strings.TrimSpace(c.runtimeEnv("TRIM_DATA_SHARE_PATHS")) != "" ||
		strings.TrimSpace(c.runtimeEnv("SCAN_PATHS")) != ""
}

// GetAuthorizedRoots 返回所有授权可访问的根目录（包括系统发现路径与用户手动保存路径）。
// 若设置了 TRIM_DATA_ACCESSIBLE_PATHS / TRIM_DATA_SHARE_PATHS / SCAN_PATHS 环境变量，遵循其作用域约束。
func (c *Config) GetAuthorizedRoots(savedPaths []string) []RootEntry {
	discovered := c.DiscoverRoots()
	seen := make(map[string]struct{}, len(discovered)+len(savedPaths))
	var out []RootEntry
	for _, d := range discovered {
		seen[d.Path] = struct{}{}
		out = append(out, d)
	}

	// 判断是否处于严格环境变量白名单模式（例如飞牛访问权限或 Docker 显式配置）
	envRestricted := c.IsEnvRestricted()

	for _, sp := range savedPaths {
		sp = strings.TrimSpace(sp)
		if sp == "" {
			continue
		}
		abs, err := filepath.Abs(sp)
		if err != nil {
			continue
		}
		realPath, err := filepath.EvalSymlinks(abs)
		if err != nil {
			realPath = abs
		}
		info, err := os.Stat(realPath)
		if err != nil || !info.IsDir() || c.isProtectedInternalPath(realPath) {
			continue
		}
		if envRestricted && !isInsideAnyRoot(realPath, discovered) {
			continue
		}
		if _, ok := seen[realPath]; ok {
			continue
		}
		seen[realPath] = struct{}{}
		name := filepath.Base(realPath)
		if name == "" || name == string(filepath.Separator) {
			name = realPath
		}
		out = append(out, RootEntry{
			Path:     realPath,
			Name:     name,
			Source:   "saved",
			Writable: IsPathWritable(realPath),
		})
	}
	return out
}

func isInsideAnyRoot(target string, roots []RootEntry) bool {
	for _, r := range roots {
		if IsPathInside(target, r.Path) {
			return true
		}
	}
	return false
}

// ValidateSavedPath 校验用户添加的自定义路径是否有效且允许保存。
func (c *Config) ValidateSavedPath(inputPath string) (RootEntry, error) {
	p := strings.TrimSpace(inputPath)
	if p == "" || strings.ContainsRune(p, '\x00') {
		return RootEntry{}, errors.New("路径不能为空")
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return RootEntry{}, errors.New("无效路径格式")
	}
	realPath, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return RootEntry{}, errors.New("目录不存在或无法访问")
	}
	info, err := os.Stat(realPath)
	if err != nil || !info.IsDir() {
		return RootEntry{}, errors.New("目标路径不是有效目录")
	}
	if c.isProtectedInternalPath(realPath) {
		return RootEntry{}, errors.New("不能扫描系统数据目录或程序目录")
	}

	if c.IsEnvRestricted() {
		discovered := c.DiscoverRoots()
		if !isInsideAnyRoot(realPath, discovered) {
			return RootEntry{}, errors.New("路径不在已授权目录范围内")
		}
	}

	name := filepath.Base(realPath)
	if name == "" || name == string(filepath.Separator) {
		name = realPath
	}
	return RootEntry{
		Path:     realPath,
		Name:     name,
		Source:   "saved",
		Writable: IsPathWritable(realPath),
	}, nil
}

// ResolveAuthorizedPath 验证目标路径在授权目录内并返回解析后的绝对真实路径。
func (c *Config) ResolveAuthorizedPath(inputPath string, savedPaths []string, wantDir, wantFile bool) (string, os.FileInfo, error) {
	if strings.TrimSpace(inputPath) == "" || strings.ContainsRune(inputPath, '\x00') {
		return "", nil, errors.New("无效路径")
	}
	abs, err := filepath.Abs(inputPath)
	if err != nil {
		return "", nil, errors.New("路径格式错误")
	}
	realPath, err := filepath.EvalSymlinks(abs)
	if err != nil {
		return "", nil, errors.New("路径不存在或无权限访问")
	}
	if c.isProtectedInternalPath(realPath) {
		return "", nil, errors.New("禁止访问应用内部受保护路径")
	}

	roots := c.GetAuthorizedRoots(savedPaths)
	if !isInsideAnyRoot(realPath, roots) {
		return "", nil, errors.New("路径不在已授权扫描范围内")
	}

	info, err := os.Stat(realPath)
	if err != nil {
		return "", nil, err
	}
	if wantDir && !info.IsDir() {
		return "", nil, errors.New("路径不是目录")
	}
	if wantFile && !info.Mode().IsRegular() {
		return "", nil, errors.New("路径不是普通文件")
	}
	return realPath, info, nil
}

func (c *Config) isProtectedInternalPath(realPath string) bool {
	if c.DataDir != "" {
		if realData, err := filepath.EvalSymlinks(c.DataDir); err == nil {
			if IsPathInside(realPath, realData) {
				return true
			}
		} else if IsPathInside(realPath, c.DataDir) {
			return true
		}
	}
	return false
}

// IsPathInside 判断 target 是否等于或位于 root 目录内部。
func IsPathInside(target, root string) bool {
	rel, err := filepath.Rel(root, target)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}

// IsPathWritable 检测指定路径所在挂载点及目录权限是否可写。
func IsPathWritable(target string) bool {
	realPath, err := filepath.EvalSymlinks(target)
	if err != nil {
		realPath = target
	}
	if isMountReadOnly(realPath) {
		return false
	}
	info, err := os.Stat(realPath)
	if err != nil {
		return false
	}
	dirToTest := realPath
	if !info.IsDir() {
		dirToTest = filepath.Dir(realPath)
	}
	f, err := os.CreateTemp(dirToTest, ".spacemap_rw_check_*")
	if err != nil {
		// 若无法创建临时文件，说明当前进程对该目录无写权限（如只读挂载或权限不足）
		return false
	}
	tmpName := f.Name()
	_ = f.Close()
	_ = os.Remove(tmpName)
	return true
}

func isMountReadOnly(target string) bool {
	f, err := os.Open("/proc/mounts")
	if err != nil {
		return false
	}
	defer f.Close()

	bestLen := -1
	bestRO := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		fields := strings.Fields(scanner.Text())
		if len(fields) < 4 {
			continue
		}
		mountPoint := strings.ReplaceAll(fields[1], `\040`, " ")
		if IsPathInside(target, mountPoint) && len(mountPoint) > bestLen {
			bestLen = len(mountPoint)
			opts := strings.Split(fields[3], ",")
			ro := false
			for _, o := range opts {
				if o == "ro" {
					ro = true
					break
				}
			}
			bestRO = ro
		}
	}
	return bestRO
}

func firstNonEmptyEnv(keys ...string) string {
	for _, k := range keys {
		if v := strings.TrimSpace(os.Getenv(k)); v != "" {
			return v
		}
	}
	return ""
}

// splitEnvPaths 兼容 JSON 字符串数组、整段单路径（即使含逗号或分号）以及换行/分号/冒号/逗号分隔的多路径。
func splitEnvPaths(raw string) []string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	if strings.HasPrefix(raw, "[") {
		var arr []string
		if err := json.Unmarshal([]byte(raw), &arr); err == nil {
			out := make([]string, 0, len(arr))
			for _, item := range arr {
				if p := strings.TrimSpace(item); p != "" {
					out = append(out, p)
				}
			}
			return out
		}
	}
	if info, err := os.Stat(raw); err == nil && info.IsDir() {
		return []string{raw}
	}
	parts := strings.FieldsFunc(raw, func(r rune) bool {
		return r == '\n' || r == '\r' || r == ';' || r == ':' || r == ','
	})
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if s := strings.TrimSpace(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func splitColonPaths(raw string) []string {
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ":")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func pathExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
