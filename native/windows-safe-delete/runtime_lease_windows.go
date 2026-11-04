//go:build windows

package safedelete

import (
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/windows"
)

// RuntimeManifestLease pins all listed regular files and their directory names.
// The manifest must independently come from a trusted, authenticated source;
// this lease does not prove that the runtime covers every external dependency.
type RuntimeManifestLease struct {
	dirs  []windows.Handle
	files []*PinnedExecutable
}

func (p *RuntimeManifestLease) Close() error {
	var result error
	for i := len(p.files) - 1; i >= 0; i-- {
		if err := p.files[i].Close(); err != nil && result == nil {
			result = err
		}
	}
	p.files = nil
	for i := len(p.dirs) - 1; i >= 0; i-- {
		if err := windows.CloseHandle(p.dirs[i]); err != nil && result == nil {
			result = err
		}
	}
	p.dirs = nil
	return result
}

// OpenRuntimeManifestLease enforces administrator-controlled runtime
// directories and ancestor replacement protection. It must be combined with
// authenticated manifest provenance and external dependency validation.
func OpenRuntimeManifestLease(root string, manifest []RuntimeManifestFile) (*RuntimeManifestLease, error) {
	return openRuntimeManifestLease(root, manifest, verifyRuntimeACL)
}

func openRuntimeManifestLease(root string, manifest []RuntimeManifestFile, verify func(string, bool) error) (*RuntimeManifestLease, error) {
	if verify == nil || VerifyRuntimeManifestContent(root, manifest) != nil {
		return nil, ErrExecutableIdentity
	}
	root = filepath.Clean(root)
	lease := &RuntimeManifestLease{}
	ok := false
	defer func() {
		if !ok {
			_ = lease.Close()
		}
	}()
	openDir := func(dir string, tree bool) error {
		ptr, err := windows.UTF16PtrFromString(dir)
		if err != nil {
			return ErrExecutableIdentity
		}
		h, err := windows.CreateFile(ptr, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
			nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
		if err != nil {
			return ErrExecutableIdentity
		}
		lease.dirs = append(lease.dirs, h)
		var info windows.ByHandleFileInformation
		if windows.GetFileInformationByHandle(h, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 || info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 {
			return ErrExecutableIdentity
		}
		buf := make([]uint16, 32768)
		n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0)
		if err != nil || n == 0 || n >= uint32(len(buf)) || !strings.EqualFold(windows.UTF16ToString(buf[:n]), `\\?\`+dir) {
			return ErrExecutableIdentity
		}
		return verify(dir, tree)
	}
	var ancestors []string
	for dir := root; ; dir = filepath.Dir(dir) {
		ancestors = append(ancestors, dir)
		if filepath.Dir(dir) == dir {
			break
		}
	}
	for i := len(ancestors) - 1; i >= 0; i-- {
		if openDir(ancestors[i], i == 0) != nil {
			return nil, ErrExecutableIdentity
		}
	}
	paths := map[string]bool{}
	for _, entry := range manifest {
		for dir := filepath.Dir(filepath.FromSlash(entry.Path)); dir != "."; dir = filepath.Dir(dir) {
			paths[dir] = true
		}
	}
	ordered := make([]string, 0, len(paths))
	for dir := range paths {
		ordered = append(ordered, dir)
	}
	sort.Strings(ordered)
	for _, dir := range ordered {
		if openDir(filepath.Join(root, dir), true) != nil {
			return nil, ErrExecutableIdentity
		}
	}
	for _, entry := range manifest {
		file, err := openPinnedRegularFile(filepath.Join(root, filepath.FromSlash(entry.Path)), entry.SHA256, true)
		if err != nil {
			return nil, ErrExecutableIdentity
		}
		lease.files = append(lease.files, file)
	}
	if VerifyRuntimeManifestContent(root, manifest) != nil {
		return nil, ErrExecutableIdentity
	}
	ok = true
	return lease, nil
}
