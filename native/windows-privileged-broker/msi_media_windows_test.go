//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func makeMediaMSI(t *testing.T, cabinet string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "fixture.msi")
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		t.Fatal(err)
	}
	var db uint32
	status, _, _ := msiOpenDatabase.Call(uintptr(unsafe.Pointer(name)), 3, uintptr(unsafe.Pointer(&db))) // MSIDBOPEN_CREATE
	if status != 0 || db == 0 {
		t.Fatalf("create MSI database: %d", status)
	}
	defer msiCloseHandle.Call(uintptr(db))
	for _, sql := range []string{
		"CREATE TABLE `Media` (`DiskId` SHORT NOT NULL, `Cabinet` CHAR(255) PRIMARY KEY `DiskId`)",
		"INSERT INTO `Media` (`DiskId`, `Cabinet`) VALUES (1, '" + cabinet + "')",
	} {
		query, err := windows.UTF16PtrFromString(sql)
		if err != nil {
			t.Fatal(err)
		}
		var view uint32
		status, _, _ = msiDatabaseOpenView.Call(uintptr(db), uintptr(unsafe.Pointer(query)), uintptr(unsafe.Pointer(&view)))
		if status != 0 || view == 0 {
			t.Fatalf("open MSI view: %d", status)
		}
		status, _, _ = msiViewExecute.Call(uintptr(view), 0)
		msiCloseHandle.Call(uintptr(view))
		if status != 0 {
			t.Fatalf("execute MSI view: %d", status)
		}
	}
	commit := msiDLL.NewProc("MsiDatabaseCommit")
	status, _, _ = commit.Call(uintptr(db))
	if status != 0 {
		t.Fatalf("commit MSI database: %d", status)
	}
	return path
}

func TestMSIEmbeddedMediaValidation(t *testing.T) {
	for _, test := range []struct {
		name, cabinet string
		allowed       bool
	}{
		{"embedded", "#cab1.cab", true}, {"external", "outside.cab", false}, {"loose", "", false},
	} {
		t.Run(test.name, func(t *testing.T) {
			path := makeMediaMSI(t, test.cabinet)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			hash := sha256.Sum256(data)
			pins, err := pinWindowsMSIArtifact(path, hex.EncodeToString(hash[:]))
			if err != nil {
				t.Fatal(err)
			}
			defer pins.Close()
			if err := verifyPinnedMSIEmbeddedMedia(pins); (err == nil) != test.allowed {
				t.Fatalf("allowed=%v error=%v", test.allowed, err)
			}
		})
	}
}
