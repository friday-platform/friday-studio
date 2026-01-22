package service

import (
	_ "embed"
	"net/http"
)

//go:embed favicon.png
var faviconData []byte

func faviconHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	_, _ = w.Write(faviconData)
}
