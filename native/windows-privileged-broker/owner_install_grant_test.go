package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
	"time"
)

func TestVerifyOwnerInstallGrant(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1_800_000_000_000)
	policy := ownerInstallPolicy{InstanceID: "inst_0123456789abcdef0123456789abcdef", OwnerSID: "S-1-5-21-1-2-3-1001"}
	grant := ownerInstallGrant{Version: 1, KeyID: "key", BrokerInstallationID: "broker", PolicyGeneration: 7,
		InstanceID: policy.InstanceID, OwnerSID: policy.OwnerSID, RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action",
		Nonce: "abcdefghijklmnopqrstuvwx", PackageID: "Vendor.App", PackageVersion: "1.2.3", Source: "winget", InstallScope: "user",
		IssuedMS: now.UnixMilli(), ExpiresMS: now.Add(time.Minute).UnixMilli()}
	message, err := ownerInstallGrantBytes(grant)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, message))
	verify := func(value ownerInstallGrant, pol ownerInstallPolicy, generation uint64, when time.Time) error {
		return verifyOwnerInstallGrant(value, signature, public, "key", "broker", generation, pol, when)
	}
	if err := verify(grant, policy, 7, now); err != nil {
		t.Fatalf("valid grant refused: %v", err)
	}
	for _, change := range []func(*ownerInstallGrant){
		func(g *ownerInstallGrant) { g.PackageID = "Other.App" },
		func(g *ownerInstallGrant) { g.PackageVersion = "9.9.9" },
		func(g *ownerInstallGrant) { g.OwnerSID = "S-1-5-21-1-2-3-1002" },
		func(g *ownerInstallGrant) { g.InstallScope = "machine" },
		func(g *ownerInstallGrant) { g.ExpiresMS++ },
		func(g *ownerInstallGrant) { g.Nonce = "short" },
	} {
		changed := grant
		change(&changed)
		if verify(changed, policy, 7, now) == nil {
			t.Fatal("accepted modified grant")
		}
	}
	changedPolicy := policy
	changedPolicy.OwnerSID = "S-1-5-21-1-2-3-1002"
	if verify(grant, changedPolicy, 7, now) == nil || verify(grant, policy, 8, now) == nil || verify(grant, policy, 7, now.Add(time.Minute)) == nil {
		t.Fatal("accepted mismatched policy, generation or expired grant")
	}
}
