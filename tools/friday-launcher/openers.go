package main

import (
	"fmt"
	"os/exec"
	"runtime"

	"github.com/pkg/browser"
)

// openURLInBrowser delegates to pkg/browser for a real http(s) URL.
// pkg/browser is fine for URLs but does NOT do the right thing for
// directory file:// paths (opens a directory listing in the browser
// instead of in Finder/Explorer) — for that, see openInFileBrowser.
func openURLInBrowser(url string) error {
	return browser.OpenURL(url)
}

// openInFileBrowser opens a directory in the OS's native file browser
// (Finder on macOS, Explorer on Windows, xdg-open on Linux). NOT
// pkg/browser — see comment above.
func openInFileBrowser(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", path)
	case "windows":
		cmd = exec.Command("explorer.exe", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open %s: %w", path, err)
	}
	return nil
}
