package geoblock

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"os"
	"strings"
	"time"

	"github.com/oschwald/maxminddb-golang/v2"
)

// Config holds the plugin configuration.
type Config struct {
	DatabasePath         string   `json:"databasePath"`
	AllowedCountries     []string `json:"allowedCountries"`
	UnknownCountryAction string   `json:"unknownCountryAction"`
	BlockedPagePath      string   `json:"blockedPagePath"`
}

// CreateConfig creates the default plugin configuration.
func CreateConfig() *Config {
	return &Config{
		UnknownCountryAction: "allow",
	}
}

// GeoBlock is the middleware handler.
// It implements io.Closer to release the database resources.
type GeoBlock struct {
	next             http.Handler
	db               *maxminddb.Reader
	allowedCountries map[string]bool
	allowUnknown     bool
	blockedPage      []byte
	name             string
}

// Close releases the MaxMind database resources.
// Note: Traefik doesn't call this automatically; the db lives for process lifetime.
func (g *GeoBlock) Close() error {
	if g.db != nil {
		return g.db.Close()
	}
	return nil
}

// countryRecord is the struct for MaxMind database lookup.
type countryRecord struct {
	Country struct {
		ISOCode string `maxminddb:"iso_code"`
	} `maxminddb:"country"`
}

// LogEntry for structured logging.
type LogEntry struct {
	Time          string `json:"time"`
	Level         string `json:"level"`
	Msg           string `json:"msg"`
	ClientIP      string `json:"client_ip,omitempty"`
	CountryCode   string `json:"country_code,omitempty"`
	RequestMethod string `json:"request_method,omitempty"`
	RequestPath   string `json:"request_path,omitempty"`
	RequestHost   string `json:"request_host,omitempty"`
	UserAgent     string `json:"user_agent,omitempty"`
	Error         string `json:"error,omitempty"`
}

// New creates a new GeoBlock middleware.
// The ctx parameter is required by Traefik's plugin interface but not used.
func New(_ context.Context, next http.Handler, config *Config, name string) (http.Handler, error) {
	if config.DatabasePath == "" {
		return nil, fmt.Errorf("databasePath is required")
	}

	db, err := maxminddb.Open(config.DatabasePath)
	if err != nil {
		logEntry("error", "failed to open database, allowing all requests", name).
			withError(err).print()
		return &GeoBlock{
			next:             next,
			db:               nil,
			allowedCountries: make(map[string]bool),
			allowUnknown:     true,
			blockedPage:      nil,
			name:             name,
		}, nil
	}

	allowed := make(map[string]bool)
	for _, code := range config.AllowedCountries {
		allowed[strings.ToUpper(code)] = true
	}

	var blockedPage []byte
	if config.BlockedPagePath != "" {
		blockedPage, err = os.ReadFile(config.BlockedPagePath)
		if err != nil {
			logEntry("warn", "failed to read blocked page, using default", name).
				withError(err).print()
			blockedPage = []byte("<!DOCTYPE html><html><body><h1>Access Denied</h1><p>This service is not available in your region.</p></body></html>")
		}
	}

	return &GeoBlock{
		next:             next,
		db:               db,
		allowedCountries: allowed,
		allowUnknown:     config.UnknownCountryAction == "allow",
		blockedPage:      blockedPage,
		name:             name,
	}, nil
}

// ServeHTTP implements http.Handler.
func (g *GeoBlock) ServeHTTP(rw http.ResponseWriter, req *http.Request) {
	// If database failed to load, allow all (fail open)
	if g.db == nil {
		g.next.ServeHTTP(rw, req)
		return
	}

	clientIP := getClientIP(req)
	if clientIP == "" {
		if g.allowUnknown {
			g.next.ServeHTTP(rw, req)
			return
		}
		g.blockRequest(rw, req, clientIP, "unknown")
		return
	}

	ip := net.ParseIP(clientIP)
	if ip == nil {
		if g.allowUnknown {
			g.next.ServeHTTP(rw, req)
			return
		}
		g.blockRequest(rw, req, clientIP, "invalid")
		return
	}

	// Always allow private/loopback IPs
	if isPrivateIP(ip) {
		g.next.ServeHTTP(rw, req)
		return
	}

	// Convert net.IP to netip.Addr for maxminddb v2
	// Note: AddrFromSlice cannot fail here since net.ParseIP already validated the IP
	addr, _ := netip.AddrFromSlice(ip)

	country, err := g.lookupCountry(addr)
	if err != nil || country == "" {
		if g.allowUnknown {
			g.next.ServeHTTP(rw, req)
			return
		}
		g.blockRequest(rw, req, clientIP, "unknown")
		return
	}

	// Country codes from MaxMind are already uppercase (ISO 3166-1 alpha-2)
	if g.allowedCountries[country] {
		g.next.ServeHTTP(rw, req)
		return
	}

	g.blockRequest(rw, req, clientIP, country)
}

func (g *GeoBlock) blockRequest(rw http.ResponseWriter, req *http.Request, clientIP, country string) {
	logEntry("warn", "request blocked", g.name).
		withClientIP(clientIP).
		withCountryCode(country).
		withRequest(req).
		print()

	rw.Header().Set("Content-Type", "text/html; charset=utf-8")
	rw.WriteHeader(http.StatusForbidden)
	if g.blockedPage != nil {
		_, _ = rw.Write(g.blockedPage)
	}
}

func (g *GeoBlock) lookupCountry(addr netip.Addr) (string, error) {
	var record countryRecord
	err := g.db.Lookup(addr).Decode(&record)
	if err != nil {
		return "", err
	}
	return record.Country.ISOCode, nil
}

func getClientIP(req *http.Request) string {
	if xff := req.Header.Get("X-Forwarded-For"); xff != "" {
		ips := strings.Split(xff, ",")
		for _, ipStr := range ips {
			ipStr = strings.TrimSpace(ipStr)
			ip := net.ParseIP(ipStr)
			if ip != nil && !isPrivateIP(ip) {
				return ipStr
			}
		}
		// No public IP found; return first entry (Split always returns ≥1 element)
		return strings.TrimSpace(ips[0])
	}

	if xri := req.Header.Get("X-Real-IP"); xri != "" {
		return strings.TrimSpace(xri)
	}

	host, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		return req.RemoteAddr
	}
	return host
}

func isPrivateIP(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast()
}

func logEntry(level, msg, name string) *LogEntry {
	return &LogEntry{
		Time:  time.Now().Format(time.RFC3339),
		Level: level,
		Msg:   fmt.Sprintf("[%s] geoblock: %s", name, msg),
	}
}

func (e *LogEntry) withError(err error) *LogEntry {
	if err != nil {
		e.Error = err.Error()
	}
	return e
}

func (e *LogEntry) withClientIP(ip string) *LogEntry {
	e.ClientIP = ip
	return e
}

func (e *LogEntry) withCountryCode(code string) *LogEntry {
	e.CountryCode = code
	return e
}

func (e *LogEntry) withRequest(req *http.Request) *LogEntry {
	e.RequestMethod = req.Method
	e.RequestPath = req.URL.Path
	e.RequestHost = req.Host
	e.UserAgent = req.UserAgent()
	return e
}

func (e *LogEntry) print() {
	jsonBytes, _ := json.Marshal(e)
	fmt.Println(string(jsonBytes))
}
