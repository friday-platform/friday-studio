package tunnel

import (
	"reflect"
	"testing"
)

// TestBuildArgs locks in the cloudflared command line for each
// (TunnelToken, TLS, OriginCA) shape. The original 502-on-every-webhook
// bug was a missing --origin-ca-pool branch in this function, so it's
// worth pinning the contract here in isolation.
func TestBuildArgs(t *testing.T) {
	cases := []struct {
		name string
		opts Options
		want []string
	}{
		{
			name: "quick tunnel http",
			opts: Options{Port: 9090},
			want: []string{"tunnel", "--url", "http://localhost:9090", "--no-autoupdate"},
		},
		{
			name: "quick tunnel https without ca — no flag (matches buggy pre-fix behavior for ergonomics; the main process logs a warn)",
			opts: Options{Port: 9090, TLS: true},
			want: []string{"tunnel", "--url", "https://localhost:9090", "--no-autoupdate"},
		},
		{
			name: "quick tunnel https with ca",
			opts: Options{Port: 9090, TLS: true, OriginCA: "/etc/friday/s2s-ca.crt"},
			want: []string{"tunnel", "--url", "https://localhost:9090", "--no-autoupdate", "--origin-ca-pool", "/etc/friday/s2s-ca.crt"},
		},
		{
			name: "named tunnel http",
			opts: Options{Port: 9090, TunnelToken: "tok"},
			want: []string{"tunnel", "run", "--token", "tok", "--url", "http://localhost:9090"},
		},
		{
			name: "named tunnel https with ca",
			opts: Options{Port: 9090, TunnelToken: "tok", TLS: true, OriginCA: "/etc/friday/s2s-ca.crt"},
			want: []string{"tunnel", "run", "--token", "tok", "--url", "https://localhost:9090", "--origin-ca-pool", "/etc/friday/s2s-ca.crt"},
		},
		{
			name: "ca without tls is dropped — origin-ca-pool only meaningful when origin speaks https",
			opts: Options{Port: 9090, OriginCA: "/etc/friday/s2s-ca.crt"},
			want: []string{"tunnel", "--url", "http://localhost:9090", "--no-autoupdate"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := &Manager{opts: tc.opts}
			got := m.buildArgs()
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("buildArgs() mismatch\n  got:  %v\n  want: %v", got, tc.want)
			}
		})
	}
}
