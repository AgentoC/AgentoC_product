//go:build windows

package safedelete

import (
	"context"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"testing"
)

func createFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	build := filepath.Join(root, "build")
	if err := os.MkdirAll(filepath.Join(build, "nested"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(build, "nested", "output.txt"), []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	return root, build
}

func TestCaptureForestChecksAllTargetsBeforeDeleting(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"first.txt", "second.txt", ".ssh"} {
		if name == ".ssh" {
			if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.Background()
	for _, paths := range [][]string{{"first.txt", ".ssh"}, {"first.txt", "FIRST.TXT"}, {"first.txt", "missing.txt"}} {
		if forest, err := CaptureForest(ctx, root, paths); err == nil {
			forest.Close()
			t.Fatalf("accepted %v", paths)
		}
		if _, err := os.Stat(filepath.Join(root, "first.txt")); err != nil {
			t.Fatalf("partial deletion: %v", err)
		}
	}
	forest, err := CaptureForest(ctx, root, []string{"first.txt", "second.txt"})
	if err != nil {
		t.Fatal(err)
	}
	count, err := forest.Commit(ctx)
	if err != nil || count != 2 {
		t.Fatalf("count=%d err=%v", count, err)
	}
	for _, name := range []string{"first.txt", "second.txt"} {
		if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatalf("%s remains: %v", name, err)
		}
	}
}

func TestCaptureRefusesWindowsProfileCredentialTree(t *testing.T) {
	root, build := createFixture(t)
	protected := filepath.Join(build, "profile", "AppData", "Roaming", "Microsoft", "Credentials")
	if err := os.MkdirAll(protected, 0700); err != nil {
		t.Fatal(err)
	}
	fixture := filepath.Join(protected, "fixture")
	if err := os.WriteFile(fixture, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if tree, err := CaptureTree(context.Background(), root, "build", false); err == nil {
		tree.Close()
		t.Fatal("credential subtree was accepted")
	}
	if contents, err := os.ReadFile(fixture); err != nil || string(contents) != "fixture" {
		t.Fatalf("credential fixture changed: %v", err)
	}
}

func TestCaptureTreeDeletesOnlyPinnedSubtree(t *testing.T) {
	root, build := createFixture(t)
	tree, err := CaptureTree(context.Background(), root, "build", false)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Close()
	if count, err := tree.Commit(context.Background()); err != nil || count != 3 {
		t.Fatalf("commit count=%d err=%v", count, err)
	}
	if _, err := os.Stat(build); !os.IsNotExist(err) {
		t.Fatalf("target remains: %v", err)
	}
	if _, err := os.Stat(root); err != nil {
		t.Fatalf("workspace removed: %v", err)
	}
	if _, err := tree.Commit(context.Background()); err == nil {
		t.Fatal("capture was reusable")
	}
}

func TestCaptureTreeNeverDeletesLateSensitiveChild(t *testing.T) {
	root, build := createFixture(t)
	tree, err := CaptureTree(context.Background(), root, "build", false)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Close()
	late := filepath.Join(build, ".ssh")
	if err = os.Mkdir(late, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(late, "key"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = tree.Commit(context.Background()); err == nil {
		t.Fatal("non-empty target unexpectedly removed")
	}
	if data, err := os.ReadFile(filepath.Join(late, "key")); err != nil || string(data) != "preserve" {
		t.Fatalf("late sensitive file changed: %v", err)
	}
}

func TestCaptureChildrenDoesNotExpandAgain(t *testing.T) {
	root, build := createFixture(t)
	tree, err := CaptureTree(context.Background(), root, "build", true)
	if err != nil {
		t.Fatal(err)
	}
	defer tree.Close()
	if err = os.WriteFile(filepath.Join(build, "late.txt"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	if count, err := tree.Commit(context.Background()); err != nil || count != 2 {
		t.Fatalf("commit count=%d err=%v", count, err)
	}
	if data, err := os.ReadFile(filepath.Join(build, "late.txt")); err != nil || string(data) != "preserve" {
		t.Fatalf("late file changed: %v", err)
	}
}

func TestCaptureRefusesSensitiveTreeBeforeDeletion(t *testing.T) {
	root, build := createFixture(t)
	if err := os.Mkdir(filepath.Join(build, ".ssh"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{"build", ".", `build\..\build`, `..\outside`} {
		if tree, err := CaptureTree(context.Background(), root, target, false); err == nil {
			tree.Close()
			t.Fatalf("accepted %q", target)
		}
	}
	if _, err := os.Stat(filepath.Join(build, "nested", "output.txt")); err != nil {
		t.Fatalf("preflight removed an ordinary file: %v", err)
	}
}

func TestCaptureRefusesJunctionBeforeDeletion(t *testing.T) {
	root, build := createFixture(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "keep.txt"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	createTestReparsePoint(t, outside, filepath.Join(build, "junction"))
	if tree, err := CaptureTree(context.Background(), root, "build", false); err == nil {
		tree.Close()
		t.Fatal("accepted junction")
	}
	if data, err := os.ReadFile(filepath.Join(outside, "keep.txt")); err != nil || string(data) != "preserve" {
		t.Fatalf("outside data changed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(build, "nested", "output.txt")); err != nil {
		t.Fatalf("preflight removed an ordinary file: %v", err)
	}
}

func TestCancelledCaptureAndCommitDoNotStartDeletion(t *testing.T) {
	root, build := createFixture(t)
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if tree, err := CaptureTree(cancelled, root, "build", false); err == nil {
		tree.Close()
		t.Fatal("cancelled capture succeeded")
	}
	tree, err := CaptureTree(context.Background(), root, "build", false)
	if err != nil {
		t.Fatal(err)
	}
	if count, err := tree.Commit(cancelled); err == nil || count != 0 {
		t.Fatalf("cancelled commit count=%d err=%v", count, err)
	}
	if _, err := os.Stat(filepath.Join(build, "nested", "output.txt")); err != nil {
		t.Fatalf("cancelled operation changed fixture: %v", err)
	}
}

func TestForceDeletesReadOnlyPinnedFile(t *testing.T) {
	root, build := createFixture(t)
	file := filepath.Join(build, "nested", "output.txt")
	if err := os.Chmod(file, 0400); err != nil {
		t.Fatal(err)
	}
	tree, err := CaptureTree(context.Background(), root, "build", false)
	if err != nil {
		os.Chmod(file, 0600)
		t.Fatal(err)
	}
	defer tree.Close()
	if count, err := tree.CommitWithOptions(context.Background(), true); err != nil || count != 3 {
		os.Chmod(file, 0600)
		t.Fatalf("forced commit count=%d err=%v", count, err)
	}
	if _, err := os.Stat(build); !os.IsNotExist(err) {
		t.Fatalf("target remains: %v", err)
	}
}

func TestHiddenTargetsRequireForceWithoutPartialDeletion(t *testing.T) {
	root, build := createFixture(t)
	file := filepath.Join(build, "nested", "output.txt")
	name, err := windows.UTF16PtrFromString(file)
	if err != nil {
		t.Fatal(err)
	}
	attributes, err := windows.GetFileAttributes(name)
	if err != nil {
		t.Fatal(err)
	}
	if err = windows.SetFileAttributes(name, attributes|windows.FILE_ATTRIBUTE_HIDDEN); err != nil {
		t.Fatal(err)
	}
	tree, err := CaptureTree(context.Background(), root, "build", false)
	if err != nil {
		t.Fatal(err)
	}
	if count, err := tree.Commit(context.Background()); err == nil || count != 0 {
		t.Fatalf("unforced count=%d err=%v", count, err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("unforced deletion changed fixture: %v", err)
	}
	tree, err = CaptureTree(context.Background(), root, "build", false)
	if err != nil {
		t.Fatal(err)
	}
	if count, err := tree.CommitWithOptions(context.Background(), true); err != nil || count != 3 {
		t.Fatalf("forced count=%d err=%v", count, err)
	}
}
