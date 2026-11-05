//go:build windows

package main

import (
	"crypto/x509"
	"crypto/x509/pkix"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestSystemCatalogRequiresMicrosoftWindowsSigner(t *testing.T) {
	for _, test := range []struct {
		cn, org string
		want    bool
	}{
		{"Microsoft Windows", "Microsoft Corporation", true},
		{"Other Publisher", "Microsoft Corporation", false},
		{"Microsoft Windows", "Other Publisher", false},
		{"Microsoft Windows", "", false},
	} {
		cert := &x509.Certificate{Subject: pkix.Name{CommonName: test.cn, Organization: []string{test.org}}}
		if isMicrosoftWindowsCatalogSigner(cert) != test.want {
			t.Fatalf("unexpected signer result for %q / %q", test.cn, test.org)
		}
	}
}

func TestSystemInstallerCatalogVerification(t *testing.T) {
	system, err := windows.GetSystemDirectory()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(system, "msiexec.exe")
	pins, _, err := pinWindowsServiceImage(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if err := verifyPinnedSystemCatalog(pins, path); err != nil {
		t.Fatal(err)
	}
	if verifyPinnedSystemCatalog(pins, filepath.Join(system, "not-the-pinned.exe")) == nil {
		t.Fatal("accepted a different binary path")
	}
	pins.Close()
	if verifyPinnedSystemCatalog(pins, path) == nil {
		t.Fatal("accepted released pins")
	}
}

func TestSystemCatalogRejectsUnsignedBinary(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fixture.exe")
	if err := os.WriteFile(path, []byte("unsigned fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	pins, _, err := pinWindowsServiceImage(path)
	if err != nil {
		t.Fatal(err)
	}
	defer pins.Close()
	if verifyPinnedSystemCatalog(pins, path) == nil {
		t.Fatal("accepted an unsigned file")
	}
}
