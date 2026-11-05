//go:build windows

package main

import (
	"crypto/x509"
	"encoding/hex"
	"errors"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	wintrustDLL     = windows.NewLazySystemDLL("wintrust.dll")
	catAcquire      = wintrustDLL.NewProc("CryptCATAdminAcquireContext2")
	catHash         = wintrustDLL.NewProc("CryptCATAdminCalcHashFromFileHandle2")
	catEnumerate    = wintrustDLL.NewProc("CryptCATAdminEnumCatalogFromHash")
	catInfo         = wintrustDLL.NewProc("CryptCATCatalogInfoFromContext")
	catRelease      = wintrustDLL.NewProc("CryptCATAdminReleaseCatalogContext")
	catReleaseAdmin = wintrustDLL.NewProc("CryptCATAdminReleaseContext")
)

type catalogInfo struct {
	size uint32
	path [260]uint16
}
type winTrustCatalogInfo struct {
	size               uint32
	version            uint32
	catalogPath        *uint16
	memberTag          *uint16
	memberPath         *uint16
	memberFile         windows.Handle
	calculatedHash     *byte
	calculatedHashSize uint32
	catalogContext     uintptr
	admin              windows.Handle
}

// Verify a pinned OS binary against the system catalog database. This checks
// catalog membership and its Windows trust policy, not a caller-provided path.
func verifyPinnedSystemCatalog(pins *serviceImagePins, path string) error {
	if pins == nil || len(pins.handles) == 0 || !strings.EqualFold(pins.snapshot.Path, path) {
		return errors.New("system binary binding invalid")
	}
	var admin windows.Handle
	alg, _ := windows.UTF16PtrFromString("SHA256")
	result, _, _ := catAcquire.Call(uintptr(unsafe.Pointer(&admin)), 0, uintptr(unsafe.Pointer(alg)), 0, 0)
	if result == 0 || admin == 0 {
		return errors.New("system catalog context unavailable")
	}
	defer catReleaseAdmin.Call(uintptr(admin), 0)
	file := pins.handles[len(pins.handles)-1]
	var length uint32
	catHash.Call(uintptr(admin), uintptr(file), uintptr(unsafe.Pointer(&length)), 0, 0)
	if length == 0 || length > 128 {
		return errors.New("system catalog hash unavailable")
	}
	hash := make([]byte, length)
	result, _, _ = catHash.Call(uintptr(admin), uintptr(file), uintptr(unsafe.Pointer(&length)), uintptr(unsafe.Pointer(&hash[0])), 0)
	if result == 0 || length != uint32(len(hash)) {
		return errors.New("system catalog hash failed")
	}
	catalog, _, _ := catEnumerate.Call(uintptr(admin), uintptr(unsafe.Pointer(&hash[0])), uintptr(length), 0, 0)
	if catalog == 0 {
		return errors.New("system catalog entry unavailable")
	}
	defer catRelease.Call(uintptr(admin), catalog, 0)
	info := catalogInfo{size: uint32(unsafe.Sizeof(catalogInfo{}))}
	result, _, _ = catInfo.Call(catalog, uintptr(unsafe.Pointer(&info)), 0)
	if result == 0 || info.path[0] == 0 {
		return errors.New("system catalog path unavailable")
	}
	member, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return errors.New("system binary path invalid")
	}
	tag, _ := windows.UTF16PtrFromString(strings.ToUpper(hex.EncodeToString(hash)))
	ci := winTrustCatalogInfo{size: uint32(unsafe.Sizeof(winTrustCatalogInfo{})), catalogPath: &info.path[0], memberTag: tag,
		memberPath: member, memberFile: file, calculatedHash: &hash[0], calculatedHashSize: length, admin: admin}
	data := windows.WinTrustData{Size: uint32(unsafe.Sizeof(windows.WinTrustData{})), UIChoice: windows.WTD_UI_NONE,
		RevocationChecks: windows.WTD_REVOKE_WHOLECHAIN, UnionChoice: windows.WTD_CHOICE_CATALOG,
		StateAction: windows.WTD_STATEACTION_VERIFY, ProvFlags: windows.WTD_REVOCATION_CHECK_CHAIN_EXCLUDE_ROOT,
		FileOrCatalogOrBlobOrSgnrOrCert: unsafe.Pointer(&ci)}
	verifyErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &data)
	trustedFingerprint := ""
	if verifyErr == nil {
		trustedFingerprint = verifiedTrustSignerFingerprint(&data)
	}
	data.StateAction = windows.WTD_STATEACTION_CLOSE
	closeErr := windows.WinVerifyTrustEx(windows.InvalidHWND, &windows.WINTRUST_ACTION_GENERIC_VERIFY_V2, &data)
	if verifyErr != nil || closeErr != nil || trustedFingerprint == "" {
		return errors.New("system catalog trust verification failed")
	}
	var cert *windows.CertContext
	status, _, _ := msiSignatureInformation.Call(uintptr(unsafe.Pointer(&info.path[0])), 1, uintptr(unsafe.Pointer(&cert)), 0, 0)
	if status != 0 || cert == nil {
		return errors.New("system catalog signer unavailable")
	}
	defer windows.CertFreeCertificateContext(cert)
	if cert.EncodedCert == nil || cert.Length == 0 || cert.Length > 1024*1024 {
		return errors.New("system catalog signer invalid")
	}
	fingerprint, err := certificateFingerprint(cert)
	if err != nil || fingerprint != trustedFingerprint {
		return errors.New("system catalog verified signer mismatch")
	}
	parsed, err := x509.ParseCertificate(unsafe.Slice(cert.EncodedCert, int(cert.Length)))
	if err != nil || !isMicrosoftWindowsCatalogSigner(parsed) {
		return errors.New("system catalog signer is not Microsoft Windows")
	}
	return nil
}

func isMicrosoftWindowsCatalogSigner(cert *x509.Certificate) bool {
	if cert == nil || cert.Subject.CommonName != "Microsoft Windows" {
		return false
	}
	for _, org := range cert.Subject.Organization {
		if org == "Microsoft Corporation" {
			return true
		}
	}
	return false
}
