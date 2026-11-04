//go:build windows

package main

import (
	"strings"

	"golang.org/x/sys/windows"
)

// linkedElevatedOwnerToken returns a caller-owned linked token only for the
// same already-verified owner and logon session. It is a private primitive;
// an independently verified exact install grant is required before use.
func linkedElevatedOwnerToken(ordinary windows.Token, ownerSID string, session uint32) (windows.Token, error) {
	if verifyOwnerSessionToken(ordinary, ownerSID, session) != nil {
		return 0, errOwnerSessionUnavailable
	}
	elevationType, err := tokenUint32(ordinary, windows.TokenElevationType)
	if err != nil || elevationType != 3 {
		return 0, errOwnerSessionUnavailable
	} // TokenElevationTypeLimited
	linked, err := ordinary.GetLinkedToken()
	if err != nil || linked == 0 {
		return 0, errOwnerSessionUnavailable
	}
	defer linked.Close()
	user, err := linked.GetTokenUser()
	if err != nil || user == nil || user.User.Sid == nil || !strings.EqualFold(user.User.Sid.String(), ownerSID) {
		return 0, errOwnerSessionUnavailable
	}
	actualSession, sessionErr := tokenUint32(linked, windows.TokenSessionId)
	typeID, typeErr := tokenUint32(linked, windows.TokenType)
	elevated, elevationErr := tokenUint32(linked, windows.TokenElevation)
	integrity, integrityErr := ownerTokenIntegritySID(linked)
	if sessionErr != nil || typeErr != nil || elevationErr != nil || integrityErr != nil ||
		actualSession != session || (typeID != windows.TokenPrimary && typeID != windows.TokenImpersonation) || elevated != 1 || integrity != "S-1-16-12288" {
		return 0, errOwnerSessionUnavailable
	}
	// Linked tokens may be impersonation tokens and may have a different
	// AuthenticationId. Their relationship is established by Windows itself;
	// duplicate the validated token into a primary token for child creation.
	var primary windows.Token
	if windows.DuplicateTokenEx(linked, windows.TOKEN_QUERY|windows.TOKEN_DUPLICATE|windows.TOKEN_ASSIGN_PRIMARY, nil,
		windows.SecurityIdentification, windows.TokenPrimary, &primary) != nil || primary == 0 {
		return 0, errOwnerSessionUnavailable
	}
	keep := false
	defer func() {
		if !keep {
			_ = primary.Close()
		}
	}()
	primaryUser, userErr := primary.GetTokenUser()
	primarySession, primarySessionErr := tokenUint32(primary, windows.TokenSessionId)
	primaryType, primaryTypeErr := tokenUint32(primary, windows.TokenType)
	primaryElevation, primaryElevationErr := tokenUint32(primary, windows.TokenElevation)
	primaryIntegrity, primaryIntegrityErr := ownerTokenIntegritySID(primary)
	if userErr != nil || primaryUser == nil || primaryUser.User.Sid == nil || !strings.EqualFold(primaryUser.User.Sid.String(), ownerSID) ||
		primarySessionErr != nil || primaryTypeErr != nil || primaryElevationErr != nil || primaryIntegrityErr != nil ||
		primarySession != session || primaryType != windows.TokenPrimary || primaryElevation != 1 || primaryIntegrity != "S-1-16-12288" {
		return 0, errOwnerSessionUnavailable
	}
	keep = true
	return primary, nil
}
