package secure

import "net/http"

// NoSniff is a middleware that sets the X-Content-Type-Options header to nosniff.
func NoSniff(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

// PermissionsPolicy is a middleware that sets the Permissions-Policy header
// to restrict usage of geolocation, camera, and microphone.
func PermissionsPolicy(next http.Handler) http.Handler {
	policy := "geolocation=(), camera=(), microphone=()"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Permissions-Policy", policy)
		next.ServeHTTP(w, r)
	})
}

// CrossOriginPolicies sets the Cross-Origin-Embedder-Policy,
// Cross-Origin-Opener-Policy, and Cross-Origin-Resource-Policy headers.
func CrossOriginPolicies(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
		w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		w.Header().Set("Cross-Origin-Resource-Policy", "same-site")
		next.ServeHTTP(w, r)
	})
}
