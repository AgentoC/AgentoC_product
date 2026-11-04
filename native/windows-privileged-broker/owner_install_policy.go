package main

import (
	"bytes"
	"encoding/json"
	"io"
	"regexp"
)

// ownerInstallPolicy is administrative installation state, not request data.
// Parsing alone does not establish filesystem ownership or trusted provenance.
type ownerInstallPolicy struct {
	Version     int    `json:"version"`
	InstanceID  string `json:"instanceId"`
	ControlSID  string `json:"controlSid"`
	ExecutorSID string `json:"executorSid"`
	OwnerSID    string `json:"ownerSid"`
	Port        int    `json:"port"`
}

var ownerPolicyInstance = regexp.MustCompile(`^inst_[a-f0-9]{32}$`)
var ownerPolicyAccountSID = regexp.MustCompile(`^S-1-5-21-(?:[0-9]+-){3}[0-9]+$`)
var ownerPolicyServiceSID = regexp.MustCompile(`^S-1-5-80-(?:[0-9]+-){4}[0-9]+$`)

func parseOwnerInstallPolicy(data []byte) (ownerInstallPolicy, error) {
	var policy ownerInstallPolicy
	if len(data) == 0 || len(data) > 8192 {
		return policy, errOwnerSessionUnavailable
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return policy, errOwnerSessionUnavailable
	}
	seen := make(map[string]bool)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok || seen[key] {
			return ownerInstallPolicy{}, errOwnerSessionUnavailable
		}
		seen[key] = true
		switch key {
		case "version":
			err = decoder.Decode(&policy.Version)
		case "instanceId":
			err = decoder.Decode(&policy.InstanceID)
		case "controlSid":
			err = decoder.Decode(&policy.ControlSID)
		case "executorSid":
			err = decoder.Decode(&policy.ExecutorSID)
		case "ownerSid":
			err = decoder.Decode(&policy.OwnerSID)
		case "port":
			err = decoder.Decode(&policy.Port)
		default:
			return ownerInstallPolicy{}, errOwnerSessionUnavailable
		}
		if err != nil {
			return ownerInstallPolicy{}, errOwnerSessionUnavailable
		}
	}
	token, err = decoder.Token()
	if err != nil || token != json.Delim('}') {
		return ownerInstallPolicy{}, errOwnerSessionUnavailable
	}
	if _, err = decoder.Token(); err != io.EOF {
		return ownerInstallPolicy{}, errOwnerSessionUnavailable
	}
	if len(seen) != 6 || policy.Version != 1 || policy.Port != 7690 || !ownerPolicyInstance.MatchString(policy.InstanceID) ||
		!ownerPolicyAccountSID.MatchString(policy.OwnerSID) || !ownerPolicyServiceSID.MatchString(policy.ControlSID) ||
		!ownerPolicyServiceSID.MatchString(policy.ExecutorSID) || policy.ControlSID == policy.ExecutorSID {
		return ownerInstallPolicy{}, errOwnerSessionUnavailable
	}
	return policy, nil
}
