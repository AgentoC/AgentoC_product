//go:build windows

package main

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestLinkedOwnerTokenDoesNotAcceptWrongOwnerOrSession(t *testing.T) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	session, err := tokenUint32(token, windows.TokenSessionId)
	if err != nil || session == 0 {
		t.Skip("interactive token required")
	}
	if linked, err := linkedElevatedOwnerToken(token, "S-1-5-18", session); err == nil {
		linked.Close()
		t.Fatal("accepted wrong owner")
	}
	if linked, err := linkedElevatedOwnerToken(token, user.User.Sid.String(), session+1); err == nil {
		linked.Close()
		t.Fatal("accepted wrong session")
	}
}

func TestLinkedOwnerTokenCurrentUser(t *testing.T) {
	token := windows.GetCurrentProcessToken()
	user, err := token.GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	session, err := tokenUint32(token, windows.TokenSessionId)
	if err != nil || session == 0 {
		t.Skip("interactive token required")
	}
	elevationType, err := tokenUint32(token, windows.TokenElevationType)
	if err != nil {
		t.Fatal(err)
	}
	if elevationType != 3 {
		t.Skip("current account has no limited UAC token")
	}
	linked, err := linkedElevatedOwnerToken(token, user.User.Sid.String(), session)
	if err != nil {
		observed, probeErr := token.GetLinkedToken()
		if probeErr == nil {
			defer observed.Close()
			kind, kindErr := tokenUint32(observed, windows.TokenType)
			elevated, elevationErr := tokenUint32(observed, windows.TokenElevation)
			integrity, integrityErr := ownerTokenIntegritySID(observed)
			first, firstErr := tokenAuthenticationID(token)
			second, secondErr := tokenAuthenticationID(observed)
			observedSession, observedSessionErr := tokenUint32(observed, windows.TokenSessionId)
			observedUser, observedUserErr := observed.GetTokenUser()
			sameUser := observedUserErr == nil && observedUser.User.Sid.Equals(user.User.Sid)
			var duplicate windows.Token
			duplicateErr := windows.DuplicateTokenEx(observed, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY, nil, windows.SecurityIdentification, windows.TokenPrimary, &duplicate)
			if duplicate != 0 {
				_ = duplicate.Close()
			}
			t.Logf("linked token: type=%d typeErr=%v elevated=%d elevationErr=%v integrity=%s integrityErr=%v sameLogon=%v logonErr=%v/%v sameSession=%v sessionErr=%v sameUser=%v userErr=%v duplicateErr=%v", kind, kindErr, elevated, elevationErr, integrity, integrityErr, first == second, firstErr, secondErr, observedSession == session, observedSessionErr, sameUser, observedUserErr, duplicateErr)
		} else {
			t.Logf("linked token query: %v", probeErr)
		}
		t.Skipf("linked token unavailable to this test process: %v", err)
	}
	defer linked.Close()
	if !linked.IsElevated() {
		t.Fatal("linked token is not elevated")
	}
}
