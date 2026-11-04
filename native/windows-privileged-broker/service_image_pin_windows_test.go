//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestServiceImagePinsPreventReplacementAndWrites(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "image-dir")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	image := filepath.Join(dir, "service.exe")
	if err := os.WriteFile(image, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias.exe")
	linked := os.Link(image, alias) == nil
	pins, snapshot, err := pinWindowsServiceImage(image)
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if snapshot.Path != image || snapshot.Digest == "" {
		t.Fatal("image snapshot missing")
	}
	if err := os.WriteFile(image, []byte("changed"), 0600); err == nil {
		t.Fatal("write succeeded while image was pinned")
	}
	if linked {
		if err := os.WriteFile(alias, []byte("changed through hard link"), 0600); err == nil {
			t.Fatal("hard link bypassed image write pin")
		}
		// Removing a different hard-link name may succeed, but must not
		// remove or make the pinned service path writable.
		_ = os.Remove(alias)
		if err := os.WriteFile(image, []byte("changed after unlink"), 0600); err == nil {
			t.Fatal("unlinking a hard link bypassed image write pin")
		}
	}
	if err := os.Rename(image, filepath.Join(dir, "renamed.exe")); err == nil {
		t.Fatal("image replacement succeeded while pinned")
	}
	if err := os.Rename(dir, filepath.Join(root, "renamed-dir")); err == nil {
		t.Fatal("ancestor replacement succeeded while pinned")
	}
	pins.Close()
	if err := os.WriteFile(image, []byte("after"), 0600); err != nil {
		t.Fatalf("released image remains locked: %v", err)
	}
}

func TestServiceTargetImagesRemainPinned(t *testing.T) {
	root := t.TempDir()
	image := filepath.Join(root, "service with spaces.exe")
	if err := os.WriteFile(image, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	pins, err := pinWindowsServiceImages("Fixture", mgr.Config{ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, BinaryPathName: `"` + image + `" -service`})
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		for _, pin := range pins {
			pin.Close()
		}
	}()
	if len(pins) != 1 {
		t.Fatalf("unexpected pin count: %d", len(pins))
	}
	if err := os.WriteFile(image, []byte("changed"), 0600); err == nil {
		t.Fatal("pinned service image was writable")
	}
}
