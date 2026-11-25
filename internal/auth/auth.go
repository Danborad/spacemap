package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/scrypt"
	"spacemap/internal/db"
)

const (
	SessionCookieName = "spacemap_session"
	SessionMaxAge     = 7 * 24 * time.Hour
)

type authConfig struct {
	Scheme string `json:"scheme"`
	Hash   string `json:"hash,omitempty"`
	Salt   string `json:"salt,omitempty"`
	Plain  string `json:"plain,omitempty"`
}

// Manager 管理访问密码校验与基于 SQLite 的持久化会话。
type Manager struct {
	database *db.DB
}

// New 创建认证管理器。
func New(database *db.DB) *Manager {
	return &Manager{database: database}
}

// HasPassword 判断系统是否已启用访问密码。
func (m *Manager) HasPassword() (bool, error) {
	cfg, err := m.loadConfig()
	if err != nil {
		return false, err
	}
	return cfg.isSet(), nil
}

// VerifyPassword 校验输入密码是否正确（兼容 Node 旧版 scrypt 及明文格式）。
func (m *Manager) VerifyPassword(password string) (bool, error) {
	cfg, err := m.loadConfig()
	if err != nil {
		return false, err
	}
	if !cfg.isSet() {
		return true, nil
	}
	return verifyAgainstConfig(cfg, password)
}

// SetPassword 更新或清除密码（newPassword 为空字符串表示关闭密码保护）。
func (m *Manager) SetPassword(oldPassword, newPassword string) error {
	cfg, err := m.loadConfig()
	if err != nil {
		return err
	}
	if cfg.isSet() {
		ok, err := verifyAgainstConfig(cfg, oldPassword)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("旧密码错误")
		}
	}

	if newPassword == "" {
		if err := m.database.SetSetting("auth_config", ""); err != nil {
			return err
		}
		m.database.ClearAllSessions()
		return nil
	}

	saltBytes := make([]byte, 16)
	if _, err := rand.Read(saltBytes); err != nil {
		return err
	}
	salt := hex.EncodeToString(saltBytes)
	hashBytes, err := scrypt.Key([]byte(newPassword), []byte(salt), 16384, 8, 1, 64)
	if err != nil {
		return err
	}
	next := authConfig{
		Scheme: "scrypt-v2",
		Hash:   hex.EncodeToString(hashBytes),
		Salt:   salt,
	}
	raw, _ := json.Marshal(next)
	if err := m.database.SetSetting("auth_config", string(raw)); err != nil {
		return err
	}
	m.database.ClearAllSessions()
	return nil
}

// CreateSession 生成新会话并设置 HttpOnly Cookie。
func (m *Manager) CreateSession(w http.ResponseWriter, r *http.Request) error {
	tokenBytes := make([]byte, 32)
	if _, err := rand.Read(tokenBytes); err != nil {
		return err
	}
	token := hex.EncodeToString(tokenBytes)
	expiresMs := time.Now().Add(SessionMaxAge).UnixMilli()
	if err := m.database.UpsertSession(token, expiresMs); err != nil {
		return err
	}
	m.database.ClearExpiredSessions(time.Now().UnixMilli())

	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    token,
		Path:     "/",
		MaxAge:   int(SessionMaxAge.Seconds()),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r != nil && r.TLS != nil,
	})
	return nil
}

// ClearSession 删除请求对应的会话并清理 Cookie。
func (m *Manager) ClearSession(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(SessionCookieName); err == nil && c.Value != "" {
		_ = m.database.DeleteSession(c.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
}

// RequestAuthenticated 验证当前请求是否携带有效会话（自动续期）。
func (m *Manager) RequestAuthenticated(r *http.Request) bool {
	c, err := r.Cookie(SessionCookieName)
	if err != nil || strings.TrimSpace(c.Value) == "" {
		return false
	}
	token := c.Value
	exp, err := m.database.GetSessionExpiry(token)
	if err != nil || exp == 0 {
		return false
	}
	nowMs := time.Now().UnixMilli()
	if exp < nowMs {
		_ = m.database.DeleteSession(token)
		return false
	}
	// 滑动续期
	_ = m.database.UpsertSession(token, time.Now().Add(SessionMaxAge).UnixMilli())
	return true
}

// Middleware 保护需要认证的 API 路由。
func (m *Manager) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		if !strings.HasPrefix(p, "/api/") ||
			p == "/api/env" ||
			p == "/api/auth/status" ||
			p == "/api/auth/login" ||
			p == "/api/auth/logout" {
			next.ServeHTTP(w, r)
			return
		}

		hasPwd, err := m.HasPassword()
		if err != nil {
			http.Error(w, `{"success":false,"error":"鉴权校验失败"}`, http.StatusInternalServerError)
			return
		}
		if !hasPwd || m.RequestAuthenticated(r) {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"success":false,"error":"未登录或登录已过期"}`))
	})
}

func (m *Manager) loadConfig() (authConfig, error) {
	raw, err := m.database.GetSetting("auth_config")
	if err != nil || strings.TrimSpace(raw) == "" {
		return authConfig{}, err
	}
	var cfg authConfig
	if err := json.Unmarshal([]byte(raw), &cfg); err != nil {
		return authConfig{}, nil
	}
	return cfg, nil
}

func (c authConfig) isSet() bool {
	return c.Hash != "" || c.Plain != ""
}

func verifyAgainstConfig(cfg authConfig, password string) (bool, error) {
	switch cfg.Scheme {
	case "scrypt-v2", "scrypt-node-hex":
		derived, err := scrypt.Key([]byte(password), []byte(cfg.Salt), 16384, 8, 1, 64)
		if err != nil {
			return false, err
		}
		expected, err := hex.DecodeString(cfg.Hash)
		if err != nil || len(expected) == 0 {
			return false, nil
		}
		return subtle.ConstantTimeCompare(derived, expected) == 1, nil
	case "legacy-plain":
		return subtle.ConstantTimeCompare([]byte(password), []byte(cfg.Plain)) == 1, nil
	default:
		return false, nil
	}
}
