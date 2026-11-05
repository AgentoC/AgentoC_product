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
var trustProviderState = windows.NewLazySystemDLL("wintrust.dll").NewProc("WTHelperProvDataFromStateData")
var trustProviderSigner = windows.NewLazySystemDLL("wintrust.dll").NewProc("WTHelperGetProvSignerFromChain")
var trustProviderCertificate = windows.NewLazySystemDLL("wintrust.dll").NewProc("WTHelperGetProvCertFromChain")

// All-zero fingerprint explicitly represents an unsigned MSI; it is not a
// publisher identity. The artifact digest and run-bound authorization remain
// mandatory, and signed files must still pass full trust verification.
const unsignedMSIPublisher = "0000000000000000000000000000000000000000000000000000000000000000"
const trustENoSignature = 0x800b0100

type trustProviderCertHead struct {
	Size uint32
	Cert *windows.CertContext
}

func certificateFingerprint(cert *windows.CertContext) (string, error) {
	if cert == nil || cert.EncodedCert == nil || cert.Length == 0 || cert.Length > 1024*1024 {
		return "", errors.New("MSI signer certificate invalid")
	}
	digest := sha256.Sum256(unsafe.Slice(cert.EncodedCert, int(cert.Length)))
	return hex.EncodeToString(digest[:]), nil
}

// Bind the observed signature state and, for signed files, the trusted signer
// to the grant while the exact artifact remains pinned.
func verifyPinnedMSIPublisher(pins *msiArtifactPins, expected string) error {
	actual, err := inspectPinnedMSIPublisher(pins)
	if err != nil {
		return err
	}
	if !msiDigestPattern.MatchString(expected) || !strings.EqualFold(actual, expected) {
		return errors.New("MSI signer certificate mismatch")
	}
	return nil
}

func verifiedTrustSignerFingerprint(data *windows.WinTrustData) string {
	if data == nil || data.StateData == 0 {
		return ""
	}
	provider, _, _ := trustProviderState.Call(uintptr(data.StateData))
	if provider == 0 {
		return ""
	}
	signer, _, _ := trustProviderSigner.Call(provider, 0, 0, 0)
	if signer == 0 {
		return ""
	}
	certPointer, _, _ := trustProviderCertificate.Call(signer, 0)
	if certPointer == 0 {
		return ""
	}
	certificate := (*trustProviderCertHead)(unsafe.Pointer(certPointer))
	if certificate.Size < uint32(unsafe.Sizeof(trustProviderCertHead{})) {
		return ""
	}
	fingerprint, _ := certificateFingerprint(certificate.Cert)
	return fingerprint
}

func inspectPinnedMSIPublisher(pins *msiArtifactPins) (string, error) {
	if pins == nil || len(pins.handles) == 0 || pins.path == "" {
		return "", errors.New("MSI publisher binding invalid")
	}
	path, err := windows.UTF16PtrFromString(pins.path)
	if err != nil {
		return "", errors.New("MSI publisher path invalid")
	}
	var cert *windows.CertContext
	// Only the documented no-signature result selects the unsigned path.
	// Invalid, revoked, unsupported and untrusted signatures fail closed.
	status, _, _ := msiSignatureInformation.Call(uintptr(unsafe.Pointer(path)), 1, uintptr(unsafe.Pointer(&cert)), 0, 0)
	if uint32(status) == trustENoSignature && cert == nil {
		return unsignedMSIPublisher, nil
	}
	if status != 0 || cert == nil {
		return "", errors.New("MSI signer certificate unavailable")
	}
	defer windows.CertFreeCertificateContext(cert)
	file := windows.WinTrustFileInfo{Size: uint32(unsafe.Sizeof(windows.WinTrustFileInfo{})), FilePath: path}
	data := windows.WinTrustData{Size: uint32(unsafe.Sizeof(windows.WinTrustData{})), UIChoice: windows.WTD_UI_NONE,
		RevocationChecks: windows.WTD_REVOKE_WHOLECHAIN, UnionChoice: windows.WTD_CHOICE_FILE,
		StateAction: windows.WTD_STATEACTION_VERIFY, ProvFlags: windows.WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&file)}
	verifyErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &data)
	trustedFingerprint := ""
	if verifyErr == nil {
		trustedFingerprint = verifiedTrustSignerFingerprint(&data)
	}
	data.StateAction = windows.WTD_STATEACTION_CLOSE
	closeErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &data)
	if verifyErr != nil || closeErr != nil || trustedFingerprint == "" {
		return "", errors.New("MSI publisher trust verification failed")
	}
	fingerprint, err := certificateFingerprint(cert)
	if err != nil || fingerprint != trustedFingerprint {
		return "", errors.New("MSI verified signer mismatch")
	}
	return fingerprint, nil
}
