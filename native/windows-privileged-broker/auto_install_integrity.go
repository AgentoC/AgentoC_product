package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

type runtimeManifestEntry struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type runtimeManifest struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Files         []runtimeManifestEntry `json:"files"`
}

var runtimePathPattern = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
var runtimeHashPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var errRuntimeIntegrity = errors.New("APB_RUNTIME_INTEGRITY_REFUSED")

// This validates content only. It does not lock paths or establish ACL trust;
// callers must hold verified Windows handles over the entire execution.
func verifyRuntimeManifest(vendorDir, expectedDigest string) (runtimeManifest, error) {
	var manifest runtimeManifest
	if !filepath.IsAbs(vendorDir) || !runtimeHashPattern.MatchString(expectedDigest) {
		return manifest, errRuntimeIntegrity
	}
	manifestPath := filepath.Join(vendorDir, "runtime-integrity.json")
	info, err := os.Lstat(manifestPath)
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 || info.Size() > 2*1024*1024 {
		return manifest, errRuntimeIntegrity
	}
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return manifest, errRuntimeIntegrity
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != expectedDigest {
		return manifest, errRuntimeIntegrity
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&manifest) != nil || decoder.Decode(&struct{}{}) != io.EOF || manifest.SchemaVersion != 1 || len(manifest.Files) == 0 || len(manifest.Files) > 4096 {
		return runtimeManifest{}, errRuntimeIntegrity
	}
	entries := make(map[string]runtimeManifestEntry, len(manifest.Files))
	directories := make(map[string]string)
	for _, entry := range manifest.Files {
		parts := strings.Split(entry.Path, "/")
		if !runtimePathPattern.MatchString(entry.Path) || len(parts) < 2 || (parts[0] != "PowerShell" && parts[0] != "Microsoft.WinGet.Client") || entry.Size < 0 || entry.Size > 400*1024*1024 || !runtimeHashPattern.MatchString(entry.SHA256) {
			return runtimeManifest{}, errRuntimeIntegrity
		}
		for _, part := range parts {
			if part == "" || part == "." || part == ".." {
				return runtimeManifest{}, errRuntimeIntegrity
			}
		}
		key := strings.ToLower(entry.Path)
		if _, exists := entries[key]; exists {
			return runtimeManifest{}, errRuntimeIntegrity
		}
		entries[key] = entry
		for dir := filepath.ToSlash(filepath.Dir(filepath.FromSlash(entry.Path))); dir != "."; dir = filepath.ToSlash(filepath.Dir(filepath.FromSlash(dir))) {
			lower := strings.ToLower(dir)
			if existing, exists := directories[lower]; exists && existing != dir {
				return runtimeManifest{}, errRuntimeIntegrity
			}
			directories[lower] = dir
		}
	}
	for _, required := range []string{"powershell/pwsh.exe", "microsoft.winget.client/microsoft.winget.client.psd1"} {
		if _, ok := entries[required]; !ok {
			return runtimeManifest{}, errRuntimeIntegrity
		}
	}
	seen := 0
	for _, root := range []string{"PowerShell", "Microsoft.WinGet.Client"} {
		if err := filepath.WalkDir(filepath.Join(vendorDir, root), func(path string, item fs.DirEntry, walkErr error) error {
			if walkErr != nil || item == nil {
				return errRuntimeIntegrity
			}
			info, err := item.Info()
			if err != nil || info.Mode()&os.ModeSymlink != 0 {
				return errRuntimeIntegrity
			}
			if info.IsDir() {
				rel, relErr := filepath.Rel(vendorDir, path)
				name := filepath.ToSlash(rel)
				if expected, exists := directories[strings.ToLower(name)]; relErr != nil || !exists || expected != name {
					return errRuntimeIntegrity
				}
				return nil
			}
			if !info.Mode().IsRegular() {
				return errRuntimeIntegrity
			}
			rel, err := filepath.Rel(vendorDir, path)
			if err != nil {
				return errRuntimeIntegrity
			}
			entry, ok := entries[strings.ToLower(filepath.ToSlash(rel))]
			if !ok || entry.Path != filepath.ToSlash(rel) || info.Size() != entry.Size {
				return errRuntimeIntegrity
			}
			file, err := os.Open(path)
			if err != nil {
				return errRuntimeIntegrity
			}
			hash := sha256.New()
			_, copyErr := io.Copy(hash, file)
			closeErr := file.Close()
			if copyErr != nil || closeErr != nil || fmt.Sprintf("%x", hash.Sum(nil)) != entry.SHA256 {
				return errRuntimeIntegrity
			}
			seen++
			return nil
		}); err != nil {
			return runtimeManifest{}, errRuntimeIntegrity
		}
	}
	if seen != len(entries) {
		return runtimeManifest{}, errRuntimeIntegrity
	}
	return manifest, nil
}
