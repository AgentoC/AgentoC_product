//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestInstalledRuntimePathsAreDerivedFromBroker(t *testing.T) {
	product, payload, vendor, err := installedRuntimePaths(`D:\Programs\AgentoC\Broker\AgentoC.PrivilegedBroker.exe`)
	if err != nil || product != `D:\Programs\AgentoC` || payload != `D:\Programs\AgentoC\payload` || vendor != `D:\Programs\AgentoC\payload\vendor` {
		t.Fatalf("incorrect derived paths: %q %q %q %v", product, payload, vendor, err)
	}
	for _, input := range []string{`relative\Broker\AgentoC.PrivilegedBroker.exe`, `\\server\share\Broker\AgentoC.PrivilegedBroker.exe`, `D:\Apps\Other\fake.exe`, `D:\Broker\AgentoC.PrivilegedBroker.exe`} {
		if _, _, _, err := installedRuntimePaths(input); err == nil {
			t.Fatalf("unexpected executable accepted: %s", input)
		}
	}
	installer, err := windows.StringToSid(trustedInstallerSID)
	if err != nil || !isRuntimeAdministrator(installer) {
		t.Fatal("TrustedInstaller identity was not recognized")
	}
}

func TestOptionalProtectedInstalledLayout(t *testing.T) {
	product := os.Getenv("AGENTOC_TEST_PROTECTED_PRODUCT")
	digest := os.Getenv("AGENTOC_TEST_PROTECTED_DIGEST")
	if product == "" || digest == "" {
		t.Skip("no protected isolated installation fixture supplied")
	}
	checks := 0
	pins, vendor, err := pinInstalledRuntimeWithAncestorCheck(filepath.Join(product, "Broker", "AgentoC.PrivilegedBroker.exe"), digest, func(string) error { checks++; return nil })
	if err != nil {
		t.Fatalf("protected isolated layout rejected: %v", err)
	}
	defer pins.Close()
	if vendor != filepath.Join(product, "payload", "vendor") || checks == 0 {
		t.Fatal("layout or ancestor validation was not applied")
	}
}
