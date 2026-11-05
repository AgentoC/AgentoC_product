//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const maxPinnedMSIBytes = 2 * 1024 * 1024 * 1024

type msiArtifactPins struct {
	serviceImagePins
	path string
}

// pinWindowsMSIArtifact binds a checked MSI path and its ancestors for the
// lifetime of the returned pins. This is an integrity primitive only: callers
// must separately authorize the installation and verify publisher trust.
func pinWindowsMSIArtifact(raw, expectedDigest string) (*msiArtifactPins, error) {
	path := filepath.Clean(raw)
	digest := strings.ToLower(expectedDigest)
	if !filepath.IsAbs(path) || len(filepath.VolumeName(path)) != 2 ||
		strings.Contains(path[2:], ":") || strings.Contains(path, "%") ||
		!strings.EqualFold(filepath.Ext(path), ".msi") || len(digest) != 64 {
		return nil, errors.New("invalid MSI artifact binding")
	}
	if _, err := hex.DecodeString(digest); err != nil {
		return nil, errors.New("invalid MSI artifact digest")
	}
	var ancestors []string
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		ancestors = append(ancestors, dir)
		if dir == filepath.Dir(dir) {
			break
		}
	}
	pins := &msiArtifactPins{path: path}
	for i := len(ancestors) - 1; i >= 0; i-- {
		if err := pins.add(ancestors[i], true); err != nil {
			pins.Close()
			return nil, err
		}
	}
	if err := pins.add(path, false); err != nil {
		pins.Close()
		return nil, err
	}
	file, err := os.Open(path)
	if err != nil {
		pins.Close()
		return nil, err
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Size() <= 0 || stat.Size() > maxPinnedMSIBytes {
		pins.Close()
		return nil, errors.New("MSI artifact size or type invalid")
	}
	hash := sha256.New()
	if _, err := io.Copy(hash, io.LimitReader(file, maxPinnedMSIBytes+1)); err != nil || hex.EncodeToString(hash.Sum(nil)) != digest {
		pins.Close()
		return nil, errors.New("MSI artifact digest mismatch")
	}
	return pins, nil
}
