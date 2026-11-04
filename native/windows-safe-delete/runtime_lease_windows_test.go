//go:build windows

package safedelete

import (
	"crypto/sha256"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func runtimeLeaseFixture(t *testing.T) (string, string, []RuntimeManifestFile) {
	t.Helper()
	root := t.TempDir()
	dir := filepath.Join(root, "运行 时")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "git.exe")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	manifest := []RuntimeManifestFile{{Path: "运行 时/git.exe", Size: 7, SHA256: sha256.Sum256([]byte("fixture"))}}
	return root, file, manifest
}

func TestRuntimeLeasePinsManifestFilesAndNames(t *testing.T) {
	root, file, manifest := runtimeLeaseFixture(t)
	checked := map[string]bool{}
	lease, err := openRuntimeManifestLease(root, manifest, func(path string, tree bool) error { checked[path] = tree; return nil })
	if err != nil {
		t.Fatal(err)
	}
	if !checked[root] || !checked[filepath.Dir(file)] {
		lease.Close()
		t.Fatal("runtime directories not checked")
	}
	if err := os.WriteFile(file, []byte("changed"), 0600); err == nil {
		lease.Close()
		t.Fatal("pinned file was overwritten")
	}
	if err := os.Rename(filepath.Dir(file), filepath.Dir(file)+"-moved"); err == nil {
		lease.Close()
		t.Fatal("pinned directory renamed")
	}
	// The test callback deliberately bypasses production ACL checks. A lease
	// alone cannot prevent additions, and the content verifier detects them.
	extra := filepath.Join(root, "extra.dll")
	if err := os.WriteFile(extra, []byte("extra"), 0600); err != nil {
		lease.Close()
		t.Fatal(err)
	}
	if err := VerifyRuntimeManifestContent(root, manifest); err == nil {
		lease.Close()
		t.Fatal("late extra file not detected")
	}
	if err := os.Remove(extra); err != nil {
		lease.Close()
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := lease.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte("changed"), 0600); err != nil {
		t.Fatalf("file remained locked: %v", err)
	}
}

func TestRuntimeLeaseRefusesUntrustedACLAndReleasesHandles(t *testing.T) {
	root, file, manifest := runtimeLeaseFixture(t)
	if lease, err := openRuntimeManifestLease(root, manifest, nil); err == nil {
		lease.Close()
		t.Fatal("missing ACL verifier accepted")
	}
	if lease, err := openRuntimeManifestLease(root, manifest, func(path string, tree bool) error {
		if path == filepath.Dir(file) {
			return errors.New("untrusted directory")
		}
		return nil
	}); err == nil {
		lease.Close()
		t.Fatal("untrusted directory accepted")
	}
	if err := os.Rename(filepath.Dir(file), filepath.Dir(file)+"-moved"); err != nil {
		t.Fatalf("failed lease retained directory handles: %v", err)
	}
}

func TestProductionRuntimeACLRefusesUserWritableFixture(t *testing.T) {
	root, _, manifest := runtimeLeaseFixture(t)
	if lease, err := OpenRuntimeManifestLease(root, manifest); err == nil {
		lease.Close()
		t.Fatal("user-owned fixture accepted as protected runtime")
	}
}
