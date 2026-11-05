//go:build windows

package main

import (
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	msiDLL              = windows.NewLazySystemDLL("msi.dll")
	msiOpenDatabase     = msiDLL.NewProc("MsiOpenDatabaseW")
	msiDatabaseOpenView = msiDLL.NewProc("MsiDatabaseOpenViewW")
	msiViewExecute      = msiDLL.NewProc("MsiViewExecute")
	msiViewFetch        = msiDLL.NewProc("MsiViewFetch")
	msiRecordGetString  = msiDLL.NewProc("MsiRecordGetStringW")
	msiCloseHandle      = msiDLL.NewProc("MsiCloseHandle")
)

// Validate the Media table while the same MSI path remains pinned. External
// cabinets and loose-file media are not bound by the MSI's file hash.
func verifyPinnedMSIEmbeddedMedia(pins *msiArtifactPins) error {
	if pins == nil || len(pins.handles) == 0 || pins.path == "" {
		return errors.New("MSI media binding invalid")
	}
	path, err := windows.UTF16PtrFromString(pins.path)
	if err != nil {
		return errors.New("MSI media path invalid")
	}
	var db uint32
	status, _, _ := msiOpenDatabase.Call(uintptr(unsafe.Pointer(path)), 0, uintptr(unsafe.Pointer(&db)))
	if status != 0 || db == 0 {
		return errors.New("MSI database unavailable")
	}
	defer msiCloseHandle.Call(uintptr(db))
	query, _ := windows.UTF16PtrFromString("SELECT `Cabinet` FROM `Media`")
	var view uint32
	status, _, _ = msiDatabaseOpenView.Call(uintptr(db), uintptr(unsafe.Pointer(query)), uintptr(unsafe.Pointer(&view)))
	if status != 0 || view == 0 {
		return errors.New("MSI media table unavailable")
	}
	defer msiCloseHandle.Call(uintptr(view))
	status, _, _ = msiViewExecute.Call(uintptr(view), 0)
	if status != 0 {
		return errors.New("MSI media query failed")
	}
	count := 0
	for {
		var row uint32
		status, _, _ = msiViewFetch.Call(uintptr(view), uintptr(unsafe.Pointer(&row)))
		if status == 259 {
			break
		} // ERROR_NO_MORE_ITEMS
		if status != 0 || row == 0 {
			return errors.New("MSI media fetch failed")
		}
		buffer := make([]uint16, 1024)
		length := uint32(len(buffer))
		status, _, _ = msiRecordGetString.Call(uintptr(row), 1, uintptr(unsafe.Pointer(&buffer[0])), uintptr(unsafe.Pointer(&length)))
		msiCloseHandle.Call(uintptr(row))
		if status != 0 || length >= uint32(len(buffer)) {
			return errors.New("MSI media entry invalid")
		}
		cabinet := windows.UTF16ToString(buffer[:length])
		if !strings.HasPrefix(cabinet, "#") || len(cabinet) < 2 {
			return errors.New("MSI references external media")
		}
		count++
		if count > 4096 {
			return errors.New("MSI media table exceeds limit")
		}
	}
	if count == 0 {
		return errors.New("MSI media table is empty")
	}
	return nil
}
