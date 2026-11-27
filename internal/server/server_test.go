package server

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"spacemap/internal/config"
)

func TestCORSMiddleware(t *testing.T) {
	okHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	t.Run("ugos loopback gateway allows desktop origin", func(t *testing.T) {
		s := &Server{cfg: &config.Config{Platform: config.PlatformUGOS}}
		h := s.corsMiddleware(okHandler)

		req := httptest.NewRequest(http.MethodPost, "/api/scan/start", nil)
		req.RemoteAddr = "127.0.0.1:52341"
		req.Host = "127.0.0.1:41023"
		req.Header.Set("Origin", "http://192.168.1.10:9999")

		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for UGOS loopback proxy, got %d (%s)", rec.Code, rec.Body.String())
		}
		if got := rec.Header().Get("Access-Control-Allow-Origin"); got != "http://192.168.1.10:9999" {
			t.Fatalf("unexpected Allow-Origin header: %q", got)
		}
	})

	t.Run("non-ugos external cross-origin request rejected", func(t *testing.T) {
		s := &Server{cfg: &config.Config{Platform: config.PlatformFnOS}}
		h := s.corsMiddleware(okHandler)

		req := httptest.NewRequest(http.MethodPost, "/api/scan/start", nil)
		req.RemoteAddr = "192.168.1.99:55555"
		req.Host = "192.168.1.10:7080"
		req.Header.Set("Origin", "http://evil.example")

		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for cross-origin external client, got %d", rec.Code)
		}
	})

	t.Run("same host origin allowed", func(t *testing.T) {
		s := &Server{cfg: &config.Config{Platform: config.PlatformFnOS}}
		h := s.corsMiddleware(okHandler)

		req := httptest.NewRequest(http.MethodPost, "/api/scan/start", nil)
		req.RemoteAddr = "192.168.1.50:54321"
		req.Host = "192.168.1.10:7080"
		req.Header.Set("Origin", "http://192.168.1.10:7080")

		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("expected 200 for same-origin request, got %d", rec.Code)
		}
	})
}
