package main

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"runtime"

	"github.com/pkg/browser"
)

// openURLInBrowserOverride is a test hook. When non-nil it replaces
// the default pkg/browser delegation in openURLInBrowser. Production
// code never sets it (zero value is nil); test code reassigns +
// restores via t.Cleanup so the tray's --no-browser semantic refinement
// + browserDisabled env override can be exercised without launching a
// real browser.
var openURLInBrowserOverride func(url string) error

// openURLInBrowser delegates to pkg/browser for a real http(s) URL.
// pkg/browser is fine for URLs but does NOT do the right thing for
// directory file:// paths (opens a directory listing in the browser
// instead of in Finder/Explorer) — for that, see openInFileBrowser.
//
// Tests set openURLInBrowserOverride to capture or count calls
// without spawning the host browser.
func openURLInBrowser(url string) error {
	if openURLInBrowserOverride != nil {
		return openURLInBrowserOverride(url)
	}
	return browser.OpenURL(url)
}

// openInFileBrowser opens a directory in the OS's native file browser
// (Finder on macOS, Explorer on Windows, xdg-open on Linux). NOT
// pkg/browser — see comment above.
func openInFileBrowser(path string) error {
	// path is a launcher-controlled directory ("~/.friday/local"), not user
	// input piped through the API — gosec's taint analysis can't see that.
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path) //nolint:gosec // G204: launcher-controlled path
	case "windows":
		cmd = exec.Command("explorer.exe", path) //nolint:gosec // G204: launcher-controlled path
	default:
		cmd = exec.Command("xdg-open", path) //nolint:gosec // G204: launcher-controlled path
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	return nil
}

// revealInFileBrowserOverride is a test hook. When non-nil it replaces
// the OS shell-out in revealInFileBrowser so tests can assert the
// reveal happened without spawning Finder/Explorer on the developer's
// machine. Production code leaves it nil.
var revealInFileBrowserOverride func(path string) error

// revealInFileBrowser opens the OS file browser with the given file
// preselected (the diagnostic zip the user just exported). macOS and
// Windows have native "select this file" flags; Linux's xdg-open has
// no equivalent, so we fall back to opening the containing directory.
//
// Fire-and-forget like openInFileBrowser — we don't wait for Finder
// to come up. Any spawn error surfaces to the caller for logging.
func revealInFileBrowser(path string) error {
	if revealInFileBrowserOverride != nil {
		return revealInFileBrowserOverride(path)
	}
	// path is the launcher-produced zip in ~/Downloads (or fallback
	// TempDir) — same provenance as logsDir() above, so the gosec
	// suppression has the same rationale.
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", "-R", path) //nolint:gosec // G204: launcher-produced path
	case "windows":
		cmd = exec.Command("explorer.exe", "/select,"+path) //nolint:gosec // G204: launcher-produced path
	default:
		cmd = exec.Command("xdg-open", filepath.Dir(path)) //nolint:gosec // G204: launcher-produced path
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("reveal %s: %w", path, err)
	}
	return nil
}
