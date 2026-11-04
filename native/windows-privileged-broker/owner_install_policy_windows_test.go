//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func TestOwnerPolicySecurity(t *testing.T) {
	for _, tc := range []struct {
		name, sddl         string
		directory, allowed bool
	}{
		{"admin-owned read access", "O:BAD:(A;;FA;;;SY)(A;;GR;;;BU)", false, true},
		{"ordinary file write", "O:BAD:(A;;FA;;;SY)(A;;GW;;;BU)", false, false},
		{"ordinary directory child deletion", "O:BAD:(A;;FA;;;SY)(A;;0x00000040;;;BU)", true, false},
		{"ordinary ancestor file creation", "O:BAD:(A;;FA;;;SY)(A;;0x00000002;;;BU)", true, true},
		{"ordinary owner", "O:BUD:(A;;FA;;;SY)", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString(tc.sddl)
			if err != nil {
				t.Fatal(err)
			}
			if (validateOwnerPolicySecurity(sd, tc.directory) == nil) != tc.allowed {
				t.Fatal("unexpected ACL decision")
			}
		})
	}
}

func TestOwnerPolicyRefusesUserWritableFixture(t *testing.T) {
	dir := t.TempDir()
	file := filepath.Join(dir, "owner-bootstrap-install.json")
	if err := os.WriteFile(file, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readPinnedOwnerPolicy(file); err == nil {
		t.Fatal("accepted a user-owned or user-writable policy")
	}
	if _, err := readPinnedOwnerPolicy("relative.json"); err == nil {
		t.Fatal("accepted a relative policy path")
	}
}
