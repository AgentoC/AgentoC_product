package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"strings"
)

// The installer and the control plane bind automatic-install grants to the
// existing instance identity. Only the public key is returned; the source
// identity file contains private material and must never be logged.
func instanceSignerFromJSON(data []byte) (string, string, error) {
	if len(data) == 0 || len(data) > 64*1024 {
		return "", "", errAutoInstallGrant
	}
	var value struct {
		Version    int    `json:"version"`
		Algorithm  string `json:"algorithm"`
		InstanceID string `json:"instanceId"`
		PublicKey  string `json:"publicKey"`
	}
	if json.Unmarshal(data, &value) != nil || value.Version != 1 || value.Algorithm != "ed25519" {
		return "", "", errAutoInstallGrant
	}
	block, rest := pem.Decode([]byte(value.PublicKey))
	if block == nil || block.Type != "PUBLIC KEY" || len(block.Headers) != 0 || strings.TrimSpace(string(rest)) != "" {
		return "", "", errAutoInstallGrant
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return "", "", errAutoInstallGrant
	}
	if _, ok := key.(ed25519.PublicKey); !ok {
		return "", "", errAutoInstallGrant
	}
	digest := sha256.Sum256(block.Bytes)
	if value.InstanceID != fmt.Sprintf("inst_%x", digest[:16]) {
		return "", "", errAutoInstallGrant
	}
	return value.InstanceID, base64.RawURLEncoding.EncodeToString(block.Bytes), nil
}
