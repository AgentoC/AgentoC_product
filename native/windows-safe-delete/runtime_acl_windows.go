//go:build windows

package safedelete

import (
	"unsafe"

	"golang.org/x/sys/windows"
)

const trustedInstallerSID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
const replacementRights = windows.DELETE | windows.WRITE_DAC | windows.WRITE_OWNER | windows.GENERIC_WRITE | windows.GENERIC_ALL | 0x00000040
const treeMutationRights = replacementRights | 0x00000002 | 0x00000004 | 0x00000010 | 0x00000100

func trustedRuntimePrincipal(sid *windows.SID) bool {
	return sid != nil && (sid.String() == "S-1-5-18" || sid.String() == "S-1-5-32-544" || sid.String() == trustedInstallerSID)
}

// Ancestors must not allow untrusted replacement; directories within the
// runtime must additionally forbid untrusted creation of new children.
func verifyRuntimeACL(path string, tree bool) error {
	sd, err := windows.GetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.OWNER_SECURITY_INFORMATION)
	if err != nil {
		return ErrExecutableIdentity
	}
	owner, _, err := sd.Owner()
	if err != nil || !trustedRuntimePrincipal(owner) {
		return ErrExecutableIdentity
	}
	acl, _, err := sd.DACL()
	if err != nil || acl == nil {
		return ErrExecutableIdentity
	}
	mask := uint32(replacementRights)
	if tree {
		mask = uint32(treeMutationRights)
	}
	for index := uint32(0); index < uint32(acl.AceCount); index++ {
		var ace *windows.ACCESS_ALLOWED_ACE
		if windows.GetAce(acl, index, &ace) != nil || ace == nil {
			return ErrExecutableIdentity
		}
		if ace.Header.AceType == windows.ACCESS_DENIED_ACE_TYPE {
			continue
		}
		if ace.Header.AceType != windows.ACCESS_ALLOWED_ACE_TYPE {
			return ErrExecutableIdentity
		}
		sid := (*windows.SID)(unsafe.Pointer(&ace.SidStart))
		if sid == nil {
			return ErrExecutableIdentity
		}
		if ace.Header.AceFlags&windows.INHERIT_ONLY_ACE != 0 || trustedRuntimePrincipal(sid) || sid.String() == "S-1-3-0" || sid.String() == "S-1-3-1" {
			continue
		}
		if uint32(ace.Mask)&mask != 0 {
			return ErrExecutableIdentity
		}
	}
	return nil
}
