package service

import (
	"net/http"
	"strings"

	"github.com/go-chi/httplog/v2"
)

func logout(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	log := httplog.LogEntry(ctx)

	cfg, err := ConfigFromContext(ctx)
	if err != nil {
		log.Error("Failed to get config from context", "error", err)
		http.Error(w, "Failed to get config from context", http.StatusInternalServerError)
		return
	}

	DeleteTempestTokenCookie(&cfg, w)

	// Redirect to the auth UI login page
	redirectURL := strings.TrimRight(cfg.AuthUIURL, "/") + "/"
	http.Redirect(w, r, redirectURL, http.StatusSeeOther)
}
