package service

import (
	"encoding/json"
	"net/http"
)

// writeJSONError writes a JSON error response with proper Content-Type.
func writeJSONError(w http.ResponseWriter, message string, status int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
