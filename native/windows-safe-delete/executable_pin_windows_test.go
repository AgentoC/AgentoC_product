//go:build windows

package safedelete

import (
	"crypto/sha256"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestPinnedExecutablePreventsReplacementAndRequiresDigest(t *testing.T) {
	root := t.TempDir()
	image := filepath.Join(root, "程序 fixture.exe")
	if err := os.WriteFile(image, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("original"))
	for _, invalid := range []string{"git.exe", image + ":stream.exe", filepath.Join(root, "document.txt")} {
		if p, err := OpenPinnedExecutable(invalid, digest); err == nil {
			p.Close()
			t.Fatalf("invalid executable path accepted: %q", invalid)
		}
	}
	if _, err := OpenPinnedExecutable(image, sha256.Sum256([]byte("wrong"))); err == nil {
		t.Fatal("wrong digest accepted")
	}
	pin, err := OpenPinnedExecutable(image, digest)
	if err != nil {
		t.Fatal(err)
	}
	if pin.Path() != image {
		t.Fatal("pinned wrong path")
	}
	if err := os.WriteFile(image, []byte("replacement"), 0600); err == nil {
		t.Fatal("pinned executable was overwritten")
	}
	if err := os.Rename(image, image+".old"); err == nil {
		t.Fatal("pinned executable was renamed")
	}
	if err := os.Remove(image); err == nil {
		t.Fatal("pinned executable was deleted")
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := pin.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(image, []byte("replacement"), 0600); err != nil {
		t.Fatalf("pin not released: %v", err)
	}
	link := filepath.Join(root, "linked.exe")
	if err := os.Link(image, link); err != nil {
		t.Skipf("hard links unavailable: %v", err)
	}
	if p, err := OpenPinnedExecutable(image, sha256.Sum256([]byte("replacement"))); err == nil {
		p.Close()
		t.Fatal("hard-linked executable accepted")
	}
}

func TestPinnedExecutableRemainsLaunchable(t *testing.T) {
	image, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(image)
	if err != nil {
		t.Fatal(err)
	}
	pin, err := OpenPinnedExecutable(image, sha256.Sum256(data))
	if err != nil {
		t.Fatal(err)
	}
	defer pin.Close()
	marker := filepath.Join(t.TempDir(), "child.txt")
	child := exec.Command(pin.Path(), "-test.run=^TestPinnedExecutableChild$")
	child.Env = append(os.Environ(), "AGENTOC_PIN_TEST_MARKER="+marker)
	if out, err := child.CombinedOutput(); err != nil {
		t.Fatalf("pinned image failed to launch: %v: %s", err, out)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatal("pinned child did not run")
	}
}

func TestPinnedExecutableChild(t *testing.T) {
	marker := os.Getenv("AGENTOC_PIN_TEST_MARKER")
	if marker == "" {
		t.Skip("child fixture")
	}
	if err := os.WriteFile(marker, []byte("ran"), 0600); err != nil {
		t.Fatal(err)
	}
}
