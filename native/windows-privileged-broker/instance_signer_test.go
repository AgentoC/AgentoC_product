package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"testing"
)

func TestInstanceSignerRequiresMatchingEd25519Identity(t *testing.T) {
	public, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(public)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(der)
	identity := map[string]any{"version": 1, "algorithm": "ed25519", "instanceId": fmt.Sprintf("inst_%x", hash[:16]), "publicKey": string(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: der})), "privateKey": "not-exposed"}
	data, err := json.Marshal(identity)
	if err != nil {
		t.Fatal(err)
	}
	kid, encoded, err := instanceSignerFromJSON(data)
	if err != nil || kid != identity["instanceId"] || encoded != base64.RawURLEncoding.EncodeToString(der) {
		t.Fatalf("valid identity refused: %v", err)
	}
	identity["instanceId"] = "inst_00000000000000000000000000000000"
	data, _ = json.Marshal(identity)
	if _, _, err := instanceSignerFromJSON(data); err == nil {
		t.Fatal("mismatched instance ID accepted")
	}
	identity["instanceId"] = fmt.Sprintf("inst_%x", hash[:16])
	identity["algorithm"] = "rsa"
	data, _ = json.Marshal(identity)
	if _, _, err := instanceSignerFromJSON(data); err == nil {
		t.Fatal("unsupported algorithm accepted")
	}
}
