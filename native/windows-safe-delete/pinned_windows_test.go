//go:build windows

package safedelete

import (
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPinnedChildRejectsReplacementAndSensitiveNames(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "output.txt")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	workspace, err := OpenWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	if err := workspace.DeletePinned(); err == nil {
		t.Fatal("workspace root must never be deletable")
	}
	for _, name := range []string{".ssh", ".env.local", ".git", "NTUSER.DAT", "ntuser.dat.LOG1", "..", `a\b`, "NUL.txt", "output.txt:stream", "file.", "*.txt"} {
		if child, err := workspace.OpenChild(name); err == nil {
			child.Close()
			t.Fatalf("accepted protected or ambiguous child %q", name)
		}
	}
	child, err := workspace.OpenChild("output.txt")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(file, filepath.Join(root, "replaced.txt")); err == nil {
		child.Close()
		t.Fatal("pinned file was renamed while its handle was open")
	}
	if err = child.Close(); err != nil {
		t.Fatal(err)
	}
	if err = os.Rename(file, filepath.Join(root, "replaced.txt")); err != nil {
		t.Fatalf("rename should succeed after handle closes: %v", err)
	}
}

func TestDirectoryShareReadDoesNotGuaranteeImmutableChildren(t *testing.T) {
	root := t.TempDir()
	name, err := windows.UTF16PtrFromString(root)
	if err != nil {
		t.Fatal(err)
	}
	h, err := windows.CreateFile(name, windows.FILE_LIST_DIRECTORY|windows.FILE_READ_ATTRIBUTES,
		windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	err = os.WriteFile(filepath.Join(root, "new-child.txt"), []byte("fixture"), 0600)
	if err == nil {
		t.Log("directory share flags do not prevent child creation")
	} else {
		t.Logf("child creation was denied: %v", err)
	}
}

func TestPinnedChildRefusesReparsePoint(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "target"), 0700); err != nil {
		t.Fatal(err)
	}
	createTestReparsePoint(t, filepath.Join(root, "target"), filepath.Join(root, "link"))
	workspace, err := OpenWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	if child, err := workspace.OpenChild("link"); err == nil {
		child.Close()
		t.Fatal("accepted reparse point")
	}
}

func createTestReparsePoint(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		systemRoot := os.Getenv("SystemRoot")
		if systemRoot == "" {
			systemRoot = os.Getenv("WINDIR")
		}
		if !filepath.IsAbs(systemRoot) {
			t.Skip("Windows system directory unavailable for junction fixture")
		}
		cmd := exec.Command(filepath.Join(systemRoot, "System32", "cmd.exe"), "/c", "mklink", "/J", link, target)
		if output, junctionErr := cmd.CombinedOutput(); junctionErr != nil {
			t.Skipf("creating a test reparse point is unavailable: %v: %s", junctionErr, output)
		}
	}
}

func TestDeletePinnedPreservesLateChildren(t *testing.T) {
	root := t.TempDir()
	directory := filepath.Join(root, "build")
	if err := os.Mkdir(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "old.txt"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	workspace, err := OpenWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	build, err := workspace.OpenChild("build")
	if err != nil {
		t.Fatal(err)
	}
	defer build.Close()
	if err = os.Rename(directory, filepath.Join(root, "moved")); err == nil {
		t.Fatal("pinned parent directory was renamed")
	}
	old, err := build.OpenChild("old.txt")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "late.txt"), []byte("preserve"), 0600); err != nil {
		old.Close()
		t.Fatal(err)
	}
	if err = old.DeletePinned(); err != nil {
		t.Fatalf("delete inspected file: %v", err)
	}
	if err = build.DeletePinned(); err == nil {
		t.Fatal("non-empty directory unexpectedly deleted")
	}
	if data, err := os.ReadFile(filepath.Join(directory, "late.txt")); err != nil || string(data) != "preserve" {
		t.Fatalf("late file was not preserved: %v", err)
	}
}

func TestEnumerationIdentityRejectsReplacedChild(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "output.txt")
	if err := os.WriteFile(path, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	workspace, err := OpenWorkspace(root)
	if err != nil {
		t.Fatal(err)
	}
	defer workspace.Close()
	entries, err := workspace.snapshotChildren()
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected one child, got %d", len(entries))
	}
	child, err := workspace.openListedChild(entries[0])
	if err != nil {
		t.Fatalf("unchanged child should be pinned: %v", err)
	}
	child.Close()
	if err = os.Rename(path, filepath.Join(root, "old.txt")); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(path, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	if child, err = workspace.openListedChild(entries[0]); err == nil {
		child.Close()
		t.Fatal("replacement accepted as enumerated object")
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "replacement" {
		t.Fatalf("replacement was modified: %v", err)
	}
}
