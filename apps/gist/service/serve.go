package service

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/httplog/v2"
	"github.com/google/uuid"
)

func serveHandler(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	log := httplog.LogEntry(ctx)

	idStr := chi.URLParam(r, "id")
	id, err := uuid.Parse(idStr)
	if err != nil {
		RecordDownload("error")
		http.Error(w, "invalid id format", http.StatusBadRequest)
		return
	}

	storage, err := StorageClientFromContext(ctx)
	if err != nil {
		log.Error("storage client not in context", "error", err)
		RecordDownload("error")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	content, err := storage.Download(ctx, id)
	if err != nil {
		if errors.Is(err, ErrObjectNotExist) {
			RecordDownload("not_found")
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		log.Error("failed to download from GCS", "error", err)
		RecordDownload("error")
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	RecordDownload("success")

	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(content) //nolint:gosec // G705: trusted HTML from GCS with explicit Content-Type
}
