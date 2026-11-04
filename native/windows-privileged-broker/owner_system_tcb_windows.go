//go:build windows

package main

import (
	"runtime"
	"unsafe"

	"golang.org/x/sys/windows"
)

var ownerPrivilegeCheck = windows.NewLazySystemDLL("advapi32.dll").NewProc("PrivilegeCheck")

type ownerPrivilegeSet struct {
	Count, Control uint32
	Privilege      windows.LUIDAndAttributes
}

// enableOwnerThreadTCB changes only the already-impersonating thread token.
// AdjustTokenPrivileges can succeed without assigning the privilege, so verify
// that it is enabled rather than trusting the API's return value alone.
func enableOwnerThreadTCB(token windows.Token) error {
	name, err := windows.UTF16PtrFromString("SeTcbPrivilege")
	if err != nil {
		return errOwnerSessionUnavailable
	}
	var luid windows.LUID
	if windows.LookupPrivilegeValue(nil, name, &luid) != nil {
		return errOwnerSessionUnavailable
	}
	requested := windows.Tokenprivileges{PrivilegeCount: 1, Privileges: [1]windows.LUIDAndAttributes{{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}}}
	if windows.AdjustTokenPrivileges(token, false, &requested, 0, nil, nil) != nil {
		return errOwnerSessionUnavailable
	}
	check := ownerPrivilegeSet{Count: 1, Control: 1, Privilege: windows.LUIDAndAttributes{Luid: luid, Attributes: windows.SE_PRIVILEGE_ENABLED}}
	var enabled int32
	result, _, _ := ownerPrivilegeCheck.Call(uintptr(token), uintptr(unsafe.Pointer(&check)), uintptr(unsafe.Pointer(&enabled)))
	if result == 0 || enabled == 0 {
		return errOwnerSessionUnavailable
	}
	return nil
}

// systemLinkedElevatedOwnerToken is an execution primitive, not authorization.
// Its caller must first verify the exact install request and must not expose
// the returned token to a requester. Only a LocalSystem broker may use it.
// A dedicated locked thread confines impersonation and the enabled privilege.
func systemLinkedElevatedOwnerToken(ordinary windows.Token, ownerSID string, session uint32) (windows.Token, error) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil || user.User.Sid.String() != "S-1-5-18" {
		return 0, errOwnerSessionUnavailable
	}
	type outcome struct {
		token windows.Token
		err   error
	}
	completed := make(chan outcome, 1)
	go func() {
		runtime.LockOSThread()
		unlock := true
		defer func() {
			if unlock {
				runtime.UnlockOSThread()
			}
		}()
		fail := func() { completed <- outcome{err: errOwnerSessionUnavailable} }
		thread, err := windows.GetCurrentThread()
		if err != nil {
			fail()
			return
		}
		var previous windows.Token
		if err = windows.OpenThreadToken(thread, windows.TOKEN_QUERY, true, &previous); err == nil {
			_ = previous.Close()
			fail()
			return
		} else if err != windows.ERROR_NO_TOKEN {
			fail()
			return
		}
		if windows.ImpersonateSelf(windows.SecurityImpersonation) != nil {
			fail()
			return
		}
		// A failed revert must never return this OS thread to the Go runtime.
		unlock = false
		var threadToken windows.Token
		var elevated windows.Token
		if windows.OpenThreadToken(thread, windows.TOKEN_QUERY|windows.TOKEN_ADJUST_PRIVILEGES, true, &threadToken) == nil {
			if enableOwnerThreadTCB(threadToken) == nil {
				elevated, _ = linkedElevatedOwnerToken(ordinary, ownerSID, session)
			}
			_ = threadToken.Close()
		}
		if windows.RevertToSelf() != nil {
			if elevated != 0 {
				_ = elevated.Close()
			}
			fail()
			return
		}
		unlock = true
		if elevated == 0 {
			fail()
			return
		}
		completed <- outcome{token: elevated}
	}()
	result := <-completed
	return result.token, result.err
}
