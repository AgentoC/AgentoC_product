//go:build windows

package main

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"golang.org/x/sys/windows"
)

// These handles prevent replacement or writes until Close. ACLs on every
// directory must also forbid untrusted creation of extra files; this helper
// alone is not sufficient to authorize execution.
type runtimePins struct{ handles []windows.Handle }

func (p *runtimePins) Close() {
	for i := len(p.handles) - 1; i >= 0; i-- {
		_ = windows.CloseHandle(p.handles[i])
	}
	p.handles = nil
}

func (p *runtimePins) add(path string, directory bool) error {
	absolute, err := filepath.Abs(path)
	if err != nil || len(filepath.VolumeName(absolute)) != 2 {
		return errRuntimeIntegrity
	}
	name, err := windows.UTF16PtrFromString(absolute)
	if err != nil {
		return errRuntimeIntegrity
	}
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	if directory {
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return errRuntimeIntegrity
	}
	keep := false
	defer func() {
		if !keep {
			_ = windows.CloseHandle(handle)
		}
	}()
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		(info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory || (!directory && info.NumberOfLinks != 1) {
		return errRuntimeIntegrity
	}
	buffer := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || n == 0 || n >= uint32(len(buffer)) {
		return errRuntimeIntegrity
	}
	final := windows.UTF16ToString(buffer[:n])
	if !strings.EqualFold(final, `\\?\`+absolute) {
		return errRuntimeIntegrity
	}
	p.handles = append(p.handles, handle)
	keep = true
	return nil
}

func pinRuntimeContent(vendorDir, expectedDigest string) (*runtimePins, runtimeManifest, error) {
	pins := &runtimePins{}
	fail := func() (*runtimePins, runtimeManifest, error) {
		pins.Close()
		return nil, runtimeManifest{}, errRuntimeIntegrity
	}
	var err error
	vendorDir, err = filepath.Abs(vendorDir)
	if err != nil {
		return fail()
	}
	info, err := os.Lstat(vendorDir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fail()
	}
	if err = pins.add(vendorDir, true); err != nil {
		return fail()
	}
	if err = pins.add(filepath.Join(vendorDir, "runtime-integrity.json"), false); err != nil {
		return fail()
	}
	manifest, err := verifyRuntimeManifest(vendorDir, expectedDigest)
	if err != nil {
		return fail()
	}
	dirs := map[string]bool{}
	for _, entry := range manifest.Files {
		parent := filepath.Dir(filepath.Join(vendorDir, filepath.FromSlash(entry.Path)))
		for parent != vendorDir {
			if parent == filepath.Dir(parent) || !strings.HasPrefix(strings.ToLower(parent), strings.ToLower(vendorDir)+string(filepath.Separator)) {
				return fail()
			}
			dirs[parent] = true
			parent = filepath.Dir(parent)
		}
	}
	ordered := make([]string, 0, len(dirs))
	for dir := range dirs {
		ordered = append(ordered, dir)
	}
	sort.Strings(ordered)
	for _, dir := range ordered {
		if err = pins.add(dir, true); err != nil {
			return fail()
		}
	}
	for _, entry := range manifest.Files {
		if err = pins.add(filepath.Join(vendorDir, filepath.FromSlash(entry.Path)), false); err != nil {
			return fail()
		}
	}
	// Rehash after all handles are held; any mutation during enumeration fails.
	if _, err = verifyRuntimeManifest(vendorDir, expectedDigest); err != nil {
		return fail()
	}
	return pins, manifest, nil
}

// Verify every runtime directory while its handles are held. The caller must
// additionally verify ancestors outside vendor before allowing execution.
func pinRuntimeWithDirectoryACL(vendorDir, expectedDigest string, check func(string) error) (*runtimePins, runtimeManifest, error) {
	if check == nil {
		check = verifyRuntimeDirectoryACL
	}
	vendorDir, err := filepath.Abs(vendorDir)
	if err != nil {
		return nil, runtimeManifest{}, errRuntimeIntegrity
	}
	pins, manifest, err := pinRuntimeContent(vendorDir, expectedDigest)
	if err != nil {
		return nil, runtimeManifest{}, err
	}
	dirs := map[string]bool{vendorDir: true}
	for _, entry := range manifest.Files {
		for dir := filepath.Dir(filepath.Join(vendorDir, filepath.FromSlash(entry.Path))); dir != vendorDir; dir = filepath.Dir(dir) {
			if dir == filepath.Dir(dir) || !strings.HasPrefix(strings.ToLower(dir), strings.ToLower(vendorDir)+string(filepath.Separator)) {
				pins.Close()
				return nil, runtimeManifest{}, errRuntimeIntegrity
			}
			dirs[dir] = true
		}
	}
	for dir := range dirs {
		if check(dir) != nil {
			pins.Close()
			return nil, runtimeManifest{}, errRuntimeIntegrity
		}
	}
	return pins, manifest, nil
}
