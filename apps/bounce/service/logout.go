package service

import (
	"net/http"

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
	http.Redirect(w, r, "/login", http.StatusSeeOther)
}
