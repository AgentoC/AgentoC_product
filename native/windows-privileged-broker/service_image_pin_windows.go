//go:build windows

package main

import (
	"errors"
	"path/filepath"
	"reflect"
	"strings"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
	"golang.org/x/sys/windows/svc/mgr"
)

// Retain every ancestor without delete sharing and the image without write or
// delete sharing. The caller must retain these pins through the service action;
// this is only a file identity guarantee, not an authorization or registry lock.
type serviceImagePins struct {
	handles  []windows.Handle
	snapshot serviceImageSnapshot
}

func (p *serviceImagePins) Close() {
	for i := len(p.handles) - 1; i >= 0; i-- {
		_ = windows.CloseHandle(p.handles[i])
	}
	p.handles = nil
}

func (p *serviceImagePins) add(path string, directory bool) error {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	access, share, flags := uint32(windows.FILE_READ_ATTRIBUTES), uint32(windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE), uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_BACKUP_SEMANTICS)
	if !directory {
		access = windows.GENERIC_READ
		share = windows.FILE_SHARE_READ
		flags = windows.FILE_FLAG_OPEN_REPARSE_POINT
	}
	handle, err := windows.CreateFile(name, access, share, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		return err
	}
	keep := false
	defer func() {
		if !keep {
			_ = windows.CloseHandle(handle)
		}
	}()
	var info windows.ByHandleFileInformation
	if windows.GetFileInformationByHandle(handle, &info) != nil || info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 ||
		(info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != directory {
		return errors.New("service image pin identity invalid")
	}
	buffer := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || n == 0 || n >= uint32(len(buffer)) || !strings.EqualFold(windows.UTF16ToString(buffer[:n]), `\\?\`+path) {
		return errors.New("service image pin path changed")
	}
	p.handles = append(p.handles, handle)
	keep = true
	return nil
}

func pinWindowsServiceImage(raw string) (*serviceImagePins, serviceImageSnapshot, error) {
	var empty serviceImageSnapshot
	expanded, err := registry.ExpandString(raw)
	if err != nil {
		return nil, empty, err
	}
	path := filepath.Clean(expanded)
	if !filepath.IsAbs(path) || len(filepath.VolumeName(path)) != 2 || strings.Contains(path, "%") {
		return nil, empty, errors.New("service image path invalid")
	}
	var ancestors []string
	for dir := filepath.Dir(path); ; dir = filepath.Dir(dir) {
		ancestors = append(ancestors, dir)
		if dir == filepath.Dir(dir) {
			break
		}
	}
	pins := &serviceImagePins{}
	for i := len(ancestors) - 1; i >= 0; i-- {
		if err := pins.add(ancestors[i], true); err != nil {
			pins.Close()
			return nil, empty, err
		}
	}
	if err := pins.add(path, false); err != nil {
		pins.Close()
		return nil, empty, err
	}
	snapshot, err := snapshotWindowsServiceImage(path)
	if err != nil {
		pins.Close()
		return nil, empty, err
	}
	pins.snapshot = snapshot
	return pins, snapshot, nil
}

func pinWindowsServiceImages(name string, config mgr.Config) ([]*serviceImagePins, error) {
	images, _, err := snapshotWindowsServiceImages(name, config)
	if err != nil {
		return nil, err
	}
	var pins []*serviceImagePins
	for _, expected := range images {
		pin, observed, err := pinWindowsServiceImage(expected.Path)
		if err != nil || !reflect.DeepEqual(expected, observed) {
			if pin != nil {
				pin.Close()
			}
			for i := len(pins) - 1; i >= 0; i-- {
				pins[i].Close()
			}
			return nil, errors.New("service image changed while pinning")
		}
		pins = append(pins, pin)
	}
	return pins, nil
}
