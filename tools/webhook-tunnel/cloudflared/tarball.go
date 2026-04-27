package cloudflared

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// unpackDarwinTarball replaces tmp's contents with the inner
// `cloudflared` file from the macOS .tgz release.
//
// macOS releases ship as `cloudflared-darwin-<arch>.tgz` containing
// a single `cloudflared` executable. We open the downloaded tar.gz,
// find the cloudflared entry, write it to a sibling file, then
// replace tmp.
func unpackDarwinTarball(tmp string) error {
	in, err := os.Open(tmp)
	if err != nil {
		return fmt.Errorf("open tarball: %w", err)
	}
	defer in.Close()
	gz, err := gzip.NewReader(in)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gz.Close()

	tr := tar.NewReader(gz)
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			return fmt.Errorf("cloudflared not found in tarball")
		}
		if err != nil {
			return fmt.Errorf("tar: %w", err)
		}
		// We want the file named `cloudflared` (no path components or
		// just at root). Skip dirs.
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		if filepath.Base(hdr.Name) != "cloudflared" {
			continue
		}
		// Write to a sibling, then rename over tmp so a partial unpack
		// doesn't leave garbage at tmp.
		extracted := tmp + ".extracted"
		out, err := os.OpenFile(extracted, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return fmt.Errorf("open extracted: %w", err)
		}
		if _, err := io.Copy(out, tr); err != nil {
			_ = out.Close()
			_ = os.Remove(extracted)
			return fmt.Errorf("extract copy: %w", err)
		}
		if err := out.Sync(); err != nil {
			_ = out.Close()
			_ = os.Remove(extracted)
			return fmt.Errorf("fsync extracted: %w", err)
		}
		if err := out.Close(); err != nil {
			_ = os.Remove(extracted)
			return err
		}
		if err := os.Rename(extracted, tmp); err != nil {
			_ = os.Remove(extracted)
			return fmt.Errorf("rename extracted: %w", err)
		}
		return nil
	}
}
