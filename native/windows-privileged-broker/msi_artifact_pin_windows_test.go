//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMSIArtifactPinBindsFileAndAncestors(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "packages")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	artifact := filepath.Join(dir, "fixture.msi")
	data := []byte("controlled installation fixture")
	if err := os.WriteFile(artifact, data, 0600); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(dir, "alias.msi")
	linked := os.Link(artifact, alias) == nil
	digest := sha256.Sum256(data)
	pins, err := pinWindowsMSIArtifact(artifact, hex.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if err := os.WriteFile(artifact, []byte("replacement"), 0600); err == nil {
		t.Fatal("pinned artifact was writable")
	}
	if linked {
		if err := os.WriteFile(alias, []byte("replacement through hard link"), 0600); err == nil {
			t.Fatal("hard link bypassed the artifact pin")
		}
	}
	if err := os.Rename(artifact, filepath.Join(dir, "replacement.msi")); err == nil {
		t.Fatal("pinned artifact was renamed")
	}
	if err := os.Rename(dir, filepath.Join(root, "replacement-dir")); err == nil {
		t.Fatal("pinned ancestor was renamed")
	}
	pins.Close()
	if err := os.WriteFile(artifact, []byte("after release"), 0600); err != nil {
		t.Fatalf("released artifact remains locked: %v", err)
	}
}

func TestMSIArtifactPinRejectsInvalidBinding(t *testing.T) {
	root := t.TempDir()
	artifact := filepath.Join(root, "fixture.msi")
	if err := os.WriteFile(artifact, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct{ path, digest string }{
		{artifact, strings.Repeat("0", 64)},
		{artifact, "not-a-digest"},
		{filepath.Join(root, "fixture.exe"), strings.Repeat("0", 64)},
		{"relative.msi", strings.Repeat("0", 64)},
	} {
		pins, err := pinWindowsMSIArtifact(test.path, test.digest)
		if err == nil {
			pins.Close()
			t.Fatalf("accepted invalid binding: %q", test.path)
		}
	}
}
