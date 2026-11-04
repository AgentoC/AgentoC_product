//go:build windows

package safedelete

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"testing"
	"time"
)

func TestRuntimeAttestationBindsIssuerInstanceRootContentAndTime(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Unix(1700000000, 0)
	manifest := []byte(`{"schemaVersion":1}`)
	a := RuntimeAttestation{InstanceID: "inst_fixture", Root: `G:\Protected\Git`, Manifest: sha256.Sum256(manifest), IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := RuntimeAttestationMessage(a)
	if err != nil {
		t.Fatal(err)
	}
	sig := ed25519.Sign(private, message)
	verify := func(v RuntimeAttestation, key ed25519.PublicKey, instance, root string, content []byte, at time.Time, signature []byte) error {
		return VerifyRuntimeAttestation(v, signature, key, instance, root, content, at)
	}
	if err := verify(a, public, a.InstanceID, `g:\protected\git`, manifest, now, sig); err != nil {
		t.Fatal(err)
	}
	checks := []struct {
		name           string
		a              RuntimeAttestation
		key            ed25519.PublicKey
		instance, root string
		content        []byte
		at             time.Time
		signature      []byte
	}{
		{"wrong key", a, other, a.InstanceID, a.Root, manifest, now, sig},
		{"wrong instance", a, public, "inst_other", a.Root, manifest, now, sig},
		{"wrong root", a, public, a.InstanceID, `G:\Other\Git`, manifest, now, sig},
		{"changed content", a, public, a.InstanceID, a.Root, []byte("different"), now, sig},
		{"expired", a, public, a.InstanceID, a.Root, manifest, now.Add(time.Minute), sig},
		{"not yet valid", a, public, a.InstanceID, a.Root, manifest, now.Add(-time.Millisecond), sig},
		{"invalid signature", a, public, a.InstanceID, a.Root, manifest, now, make([]byte, ed25519.SignatureSize)},
	}
	changed := a
	changed.ExpiresMS++
	checks = append(checks, struct {
		name           string
		a              RuntimeAttestation
		key            ed25519.PublicKey
		instance, root string
		content        []byte
		at             time.Time
		signature      []byte
	}{"changed expiry", changed, public, a.InstanceID, a.Root, manifest, now, sig})
	for _, c := range checks {
		t.Run(c.name, func(t *testing.T) {
			if verify(c.a, c.key, c.instance, c.root, c.content, c.at, c.signature) == nil {
				t.Fatal("invalid attestation accepted")
			}
		})
	}
	for _, root := range []string{`G:\`, `G:\Protected\..\Git`, `\\server\share\git`, `relative`} {
		bad := a
		bad.Root = root
		if _, err := RuntimeAttestationMessage(bad); err == nil {
			t.Fatalf("invalid root accepted: %q", root)
		}
	}
	bad := a
	bad.ExpiresMS = bad.IssuedMS + int64((5*time.Minute)/time.Millisecond) + 1
	if _, err := RuntimeAttestationMessage(bad); err == nil {
		t.Fatal("excessive validity accepted")
	}
}
