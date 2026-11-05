//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"testing"
)

func TestMSIInspectionSignedFixture(t *testing.T) {
	path, publisher := os.Getenv("AGENTOC_TEST_SIGNED_MSI"), os.Getenv("AGENTOC_TEST_SIGNED_MSI_PUBLISHER_SHA256")
	if path == "" || publisher == "" {
		t.Skip("signed fixture not configured")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(data)
	request := msiInspectRequest{ArtifactPath: path, ArtifactSHA256: hex.EncodeToString(sum[:])}
	facts, err := inspectWindowsMSI(request)
	if err != nil || facts.PublisherSHA256 != publisher {
		t.Fatalf("inspection: %+v %v", facts, err)
	}
	server := &brokerIPCServer{msiInspector: inspectWindowsMSI}
	result := server.handleRequest(mustJSON(t, brokerRequest{Version: protocolVersion, Type: "msi_install.inspect", MSIInspect: &request}), false)
	if result.Type != "msi_install_inspection" || result.MSIFacts == nil || result.MSIFacts.PublisherSHA256 != publisher {
		t.Fatalf("IPC: %+v", result)
	}
	request.ArtifactSHA256 = publisher
	if _, err = inspectWindowsMSI(request); err == nil {
		t.Fatal("accepted incorrect digest")
	}
}
