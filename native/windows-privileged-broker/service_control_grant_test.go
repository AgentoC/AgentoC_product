package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestServiceControlGrantBindsExactOperation(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	now := time.UnixMilli(1800000000000).UTC()
	grant := serviceControlGrant{Version: 1, KeyID: "key", BrokerInstallationID: "broker", PolicyGeneration: 3, RequestID: "request", SessionID: "session", RunID: "run", TurnID: "turn", ActionID: "action", Nonce: "0123456789abcdefghijklmn", ServiceName: "服务 示例 & one", Action: "restart-service", DefinitionHash: strings.Repeat("a", 64), Authorization: "owner", IssuedMS: uint64(now.UnixMilli()), ExpiresMS: uint64(now.Add(time.Minute).UnixMilli())}
	if got := fmt.Sprintf("%x", sha256.Sum256(serviceControlSigningBytes(grant))); got != "3df9a07c89afdafc1f87f75ba2e2cb7cfcb335153c35a8fb2aa99d0826c6b412" {
		t.Fatalf("cross-language signing bytes differ: %s", got)
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(serviceControlOwnerSigningBytes(grant))); got != "e0cb3610783fd33fdc745e5059474811b3dac76415ef91a283cf110df0af9bf1" {
		t.Fatalf("owner proof bytes differ: %s", got)
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(serviceControlOwnerDenialSigningBytes(grant))); got != "2685876afa9faa33edcd29a2ca1dea674a646ad69cfb3143f291614bda1a7363" {
		t.Fatalf("owner denial bytes differ: %s", got)
	}
	if got := fmt.Sprintf("%x", sha256.Sum256(serviceControlBrokerSigningBytes(grant))); got != "d98b2c6f1b2def03d2fffb8eb9d8375dd031ffc42f5a7ae4d861470ae7a026b9" {
		t.Fatalf("review bytes differ: %s", got)
	}
	signature := base64.RawURLEncoding.EncodeToString(ed25519.Sign(private, serviceControlSigningBytes(grant)))
	verify := func(g serviceControlGrant) error {
		return verifyServiceControlGrant(g, signature, public, "key", "broker", 3, now)
	}
	if err := verify(grant); err != nil {
		t.Fatal(err)
	}
	mutations := []func(*serviceControlGrant){func(g *serviceControlGrant) { g.ServiceName = "Other" }, func(g *serviceControlGrant) { g.Action = "stop-service" }, func(g *serviceControlGrant) { g.DefinitionHash = strings.Repeat("b", 64) }, func(g *serviceControlGrant) { g.Nonce = "other0123456789abcdefghijkl" }, func(g *serviceControlGrant) { g.RunID = "other" }, func(g *serviceControlGrant) { g.Authorization = "policy-auto" }}
	for _, mutate := range mutations {
		changed := grant
		mutate(&changed)
		if verify(changed) == nil {
			t.Fatal("changed grant accepted")
		}
	}
	if verifyServiceControlGrant(grant, signature, public, "key", "broker", 4, now) == nil || verifyServiceControlGrant(grant, signature, public, "key", "broker", 3, now.Add(time.Minute)) == nil {
		t.Fatal("stale grant accepted")
	}
}
