//go:build windows

package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func setFixtureDACL(t *testing.T, path string, owner *windows.SID, extra string) {
	t.Helper()
	sddl := fmt.Sprintf("D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;%s)%s", owner.String(), extra)
	sd, err := windows.SecurityDescriptorFromString(sddl)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		t.Fatal(err)
	}
	if err := windows.SetNamedSecurityInfo(path, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
}

func TestPinnedInstanceSignerChecksIdentityAndPrivateACL(t *testing.T) {
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	control := user.User.Sid
	root := t.TempDir()
	config := filepath.Join(root, "config")
	if err := os.Mkdir(config, 0700); err != nil {
		t.Fatal(err)
	}
	setFixtureDACL(t, config, control, "")
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(der)
	identity := map[string]any{"version": 1, "algorithm": "ed25519", "instanceId": fmt.Sprintf("inst_%x", digest[:16]), "publicKey": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), "privateKey": "fixture"}
	data, err := json.Marshal(identity)
	if err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(config, "instance-identity.json")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	setFixtureDACL(t, file, control, "")
	checked := 0
	checkAncestor := func(string) error { checked++; return nil }
	kid, _, err := readPinnedInstanceSigner(config, control, checkAncestor)
	if err != nil || kid != identity["instanceId"] || checked == 0 {
		t.Fatalf("protected identity was refused: %v", err)
	}
	setFixtureDACL(t, file, control, "(A;;GR;;;BU)")
	if _, _, err := readPinnedInstanceSigner(config, control, checkAncestor); err == nil {
		t.Fatal("identity readable by ordinary users was accepted")
	}
}
