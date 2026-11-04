package main

import (
	"testing"
	"unsafe"

	"golang.org/x/sys/windows"
)

func TestAncestorAclDistinguishesEffectiveWriters(t *testing.T) {
	for _, test := range []struct {
		name  string
		sid   string
		mask  uint32
		flags uint8
		want  bool
	}{
		{name: "creator owner placeholder", sid: "S-1-3-0", mask: windows.GENERIC_ALL, want: false},
		{name: "creator group placeholder", sid: "S-1-3-1", mask: windows.GENERIC_ALL, want: false},
		{name: "inherit only writer", sid: "S-1-5-32-545", mask: windows.GENERIC_ALL, flags: windows.INHERIT_ONLY_ACE, want: false},
		{name: "ordinary user can delete child", sid: "S-1-5-32-545", mask: windows.DELETE | 0x00000040, want: true},
		{name: "system writer", sid: "S-1-5-18", mask: windows.GENERIC_ALL, want: false},
		{name: "administrator writer", sid: "S-1-5-32-544", mask: windows.GENERIC_ALL, want: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			sid, err := windows.StringToSid(test.sid)
			if err != nil {
				t.Fatal(err)
			}
			if got := ancestorACECanReplacePath(sid, test.mask, test.flags); got != test.want {
				t.Fatalf("writer classification: got %v, want %v", got, test.want)
			}
		})
	}
}

func TestAdministratorIdentityUsesWellKnownSid(t *testing.T) {
	admin, err := windows.CreateWellKnownSid(windows.WinBuiltinAdministratorsSid)
	if err != nil || admin.String() != "S-1-5-32-544" || !isLocalAdministratorsSID(admin) || !trustedStatePrincipal(admin) {
		t.Fatalf("well-known administrator SID not recognized: %v", err)
	}
	users, err := windows.CreateWellKnownSid(windows.WinBuiltinUsersSid)
	if err != nil || isLocalAdministratorsSID(users) || trustedStatePrincipal(users) {
		t.Fatalf("ordinary users incorrectly trusted: %v", err)
	}
}

func TestBrokerStateDirectoryAclIsProtectedAndContainsOnlyTrustedPrincipals(t *testing.T) {
	serviceSID, err := windows.StringToSid("S-1-5-80-1-2-3-4-5")
	if err != nil {
		t.Fatal(err)
	}
	sd, err := brokerStateDirectorySecurityDescriptor(serviceSID)
	if err != nil {
		t.Fatalf("state directory descriptor is invalid: %v", err)
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_PROTECTED == 0 {
		t.Fatalf("state directory DACL is not protected: control=%v err=%v", control, err)
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil || uint32(acl.AceCount) != 3 {
		t.Fatalf("state directory DACL should contain exactly three principals: acl=%v err=%v", acl, err)
	}
	principals := map[string]bool{"S-1-5-18": false, "S-1-5-32-544": false, serviceSID.String(): false}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if err := windows.GetAce(acl, index, &ace); err != nil {
			t.Fatal(err)
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE || uint32(ace.Mask) != 0x001F01FF || ace.Header.AceFlags != 0x03 {
			t.Fatalf("state directory ACE grants unexpected rights or inheritance: %+v", ace)
		}
		principal := (*windows.SID)(unsafe.Pointer(&ace.SidStart)).String()
		if _, ok := principals[principal]; !ok || principals[principal] {
			t.Fatalf("state directory grants unexpected or duplicate principal %s", principal)
		}
		principals[principal] = true
	}
	for principal, found := range principals {
		if !found {
			t.Fatalf("state directory ACL omits required principal %s", principal)
		}
	}
}
