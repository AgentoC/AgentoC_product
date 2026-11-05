//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var msiSignatureInformation = windows.NewLazySystemDLL("msi.dll").NewProc("MsiGetFileSignatureInformationW")

// Verify the Windows trust chain and match the actual signer certificate to
// the policy-issued fingerprint while the exact file and ancestors remain
// pinned. Chain validity alone is not authorization to execute a publisher.
func verifyPinnedMSIPublisher(pins *msiArtifactPins, expected string) error {
	if pins == nil || len(pins.handles) == 0 || pins.path == "" || !msiDigestPattern.MatchString(expected) {
		return errors.New("MSI publisher binding invalid")
	}
	path, err := windows.UTF16PtrFromString(pins.path)
	if err != nil {
		return errors.New("MSI publisher path invalid")
	}
	file := windows.WinTrustFileInfo{Size: uint32(unsafe.Sizeof(windows.WinTrustFileInfo{})), FilePath: path}
	data := windows.WinTrustData{Size: uint32(unsafe.Sizeof(windows.WinTrustData{})), UIChoice: windows.WTD_UI_NONE,
		RevocationChecks: windows.WTD_REVOKE_WHOLECHAIN, UnionChoice: windows.WTD_CHOICE_FILE,
		StateAction: windows.WTD_STATEACTION_VERIFY, ProvFlags: windows.WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&file)}
	verifyErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &data)
	data.StateAction = windows.WTD_STATEACTION_CLOSE
	closeErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &data)
	if verifyErr != nil || closeErr != nil {
		return errors.New("MSI publisher trust verification failed")
	}
	var cert *windows.CertContext
	// MSI_INVALID_HASH_IS_FATAL prevents extracting a certificate from a
	// signature whose signed content does not match the file.
	status, _, _ := msiSignatureInformation.Call(uintptr(unsafe.Pointer(path)), 1, uintptr(unsafe.Pointer(&cert)), 0, 0)
	if status != 0 || cert == nil {
		return errors.New("MSI signer certificate unavailable")
	}
	defer windows.CertFreeCertificateContext(cert)
	if cert.EncodedCert == nil || cert.Length == 0 || cert.Length > 1024*1024 {
		return errors.New("MSI signer certificate invalid")
	}
	digest := sha256.Sum256(unsafe.Slice(cert.EncodedCert, int(cert.Length)))
	if !strings.EqualFold(hex.EncodeToString(digest[:]), expected) {
		return errors.New("MSI signer certificate mismatch")
	}
	return nil
}
