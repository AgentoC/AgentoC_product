//go:build windows

package safedelete

import (
	"crypto/sha256"
	"crypto/subtle"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
)

// RuntimeManifestFile describes one regular file in a previously trusted
// runtime snapshot. The manifest itself must be authenticated by the caller.
type RuntimeManifestFile struct {
	Path   string
	Size   int64
	SHA256 [sha256.Size]byte
}

// VerifyRuntimeManifestContent checks a complete content snapshot. It neither
// holds paths open nor validates ACLs or manifest provenance. A caller must
// separately establish those facts and repeat verification while holding the
// necessary leases before using a result for an approval decision.
func VerifyRuntimeManifestContent(root string, manifest []RuntimeManifestFile) error {
	if !filepath.IsAbs(root) || len(filepath.VolumeName(root)) != 2 || len(manifest) == 0 || len(manifest) > 10000 {
		return ErrExecutableIdentity
	}
	root = filepath.Clean(root)
	files := make(map[string]RuntimeManifestFile, len(manifest))
	dirs := map[string]string{".": "."}
	var total int64
	var pathBytes int
	for _, item := range manifest {
		parts := strings.Split(item.Path, "/")
		pathBytes += len(item.Path)
		if item.Path == "" || len(item.Path) > 32767 || pathBytes > 8*1024*1024 || strings.ContainsAny(item.Path, "\\:\x00") || item.Size < 0 || item.Size > 400*1024*1024 {
			return ErrExecutableIdentity
		}
		for _, part := range parts {
			if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || strings.HasSuffix(part, " ") || deviceName.MatchString(part) {
				return ErrExecutableIdentity
			}
		}
		total += item.Size
		if total > 2*1024*1024*1024 {
			return ErrExecutableIdentity
		}
		key := strings.ToLower(item.Path)
		if _, exists := files[key]; exists {
			return ErrExecutableIdentity
		}
		files[key] = item
		for n := 1; n < len(parts); n++ {
			dir := strings.Join(parts[:n], "/")
			key := strings.ToLower(dir)
			if old, exists := dirs[key]; exists && old != dir {
				return ErrExecutableIdentity
			}
			dirs[key] = dir
		}
	}
	seen := 0
	err := filepath.WalkDir(root, func(name string, item fs.DirEntry, walkErr error) error {
		if walkErr != nil || item == nil {
			return ErrExecutableIdentity
		}
		info, err := item.Info()
		if err != nil || info.Mode()&os.ModeSymlink != 0 {
			return ErrExecutableIdentity
		}
		rel, err := filepath.Rel(root, name)
		if err != nil {
			return ErrExecutableIdentity
		}
		rel = filepath.ToSlash(rel)
		if info.IsDir() {
			expected, ok := dirs[strings.ToLower(rel)]
			if !ok || expected != rel {
				return ErrExecutableIdentity
			}
			return nil
		}
		if !info.Mode().IsRegular() {
			return ErrExecutableIdentity
		}
		expected, ok := files[strings.ToLower(rel)]
		if !ok || expected.Path != rel || expected.Size != info.Size() {
			return ErrExecutableIdentity
		}
		file, err := os.Open(name)
		if err != nil {
			return ErrExecutableIdentity
		}
		hash := sha256.New()
		_, readErr := io.Copy(hash, file)
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || subtle.ConstantTimeCompare(hash.Sum(nil), expected.SHA256[:]) != 1 {
			return ErrExecutableIdentity
		}
		seen++
		return nil
	})
	if err != nil || seen != len(files) {
		return ErrExecutableIdentity
	}
	return nil
}
