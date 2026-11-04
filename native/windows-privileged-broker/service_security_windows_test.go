//go:build windows

package main

import (
	"fmt"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func TestServiceDefinitionSecuritySeparatesControlAndMutation(t *testing.T) {
	mask := uint32(windows.SERVICE_CHANGE_CONFIG | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL)
	cases := []struct {
		name, owner string
		rights      uint32
		allowed     bool
	}{
		{"ordinary start and stop", "SY", windows.SERVICE_START | windows.SERVICE_STOP | windows.SERVICE_QUERY_STATUS, true},
		{"change config", "SY", windows.SERVICE_CHANGE_CONFIG, false},
		{"change owner", "SY", windows.WRITE_OWNER, false},
		{"delete service", "SY", windows.DELETE, false},
		{"untrusted owner", "BU", windows.SERVICE_QUERY_STATUS, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("O:%sD:(A;;GA;;;SY)(A;;0x%08x;;;BU)", tc.owner, tc.rights))
			if err != nil {
				t.Fatal(err)
			}
			if got := validateServiceDefinitionSecurity(sd, mask) == nil; got != tc.allowed {
				t.Fatalf("got %v want %v", got, tc.allowed)
			}
		})
	}
}

func TestServiceRegistrySecurityRejectsWriteAndAllowsRead(t *testing.T) {
	mask := uint32(registry.SET_VALUE | registry.CREATE_SUB_KEY | registry.CREATE_LINK | windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL)
	for _, tc := range []struct {
		rights  uint32
		allowed bool
	}{{registry.QUERY_VALUE, true}, {registry.SET_VALUE, false}, {registry.CREATE_SUB_KEY, false}, {windows.WRITE_DAC, false}} {
		sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("O:SYD:(A;;GA;;;SY)(A;;0x%08x;;;BU)", tc.rights))
		if err != nil {
			t.Fatal(err)
		}
		if got := validateServiceDefinitionSecurity(sd, mask) == nil; got != tc.allowed {
			t.Fatalf("rights %x got %v", tc.rights, got)
		}
	}
}

func TestServiceImageDirectoryRejectsUntrustedSiblingWrites(t *testing.T) {
	for _, tc := range []struct {
		name    string
		rights  uint32
		allowed bool
	}{
		{"read", windows.FILE_GENERIC_READ, true},
		{"add file", 0x0002, false},
		{"add directory", 0x0004, false},
		{"delete child", 0x0040, false},
		{"change dacl", windows.WRITE_DAC, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			sd, err := windows.SecurityDescriptorFromString(fmt.Sprintf("O:SYD:(A;;GA;;;SY)(A;;0x%08x;;;BU)", tc.rights))
			if err != nil {
				t.Fatal(err)
			}
			if got := validateServiceImageDirectorySecurity(sd) == nil; got != tc.allowed {
				t.Fatalf("got %v want %v", got, tc.allowed)
			}
		})
	}
}
