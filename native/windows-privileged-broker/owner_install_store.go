package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"time"
)

type ownerInstallRecord struct {
	Grant     ownerInstallGrant `json:"grant"`
	Digest    string            `json:"digest"`
	Status    requestStatus     `json:"status"`
	Code      string            `json:"code"`
	CreatedAt time.Time         `json:"createdAt"`
	UpdatedAt time.Time         `json:"updatedAt"`
}

// policy must come from the broker's protected installed-policy reader. The
// signed grant is claimed durably before execution, and never retried after an
// ambiguous transport or service restart.
func (s *brokerStore) ClaimOwnerInstall(grant ownerInstallGrant, signature string, policy ownerInstallPolicy, now time.Time) (ownerInstallRecord, bool, error) {
	message, err := ownerInstallGrantBytes(grant)
	if err != nil {
		return ownerInstallRecord{}, false, err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(message))
	var result ownerInstallRecord
	duplicate := false
	err = s.transact(func(state *persistedBrokerState) error {
		if state.AutoInstallSigner == nil {
			return errOwnerSessionUnavailable
		}
		key, err := parseAutoInstallPublicKey(state.AutoInstallSigner.PublicKey)
		if err != nil || verifyOwnerInstallGrant(grant, signature, key, state.AutoInstallSigner.KeyID, state.InstallationID, state.PolicyGeneration, policy, now) != nil {
			return errOwnerSessionUnavailable
		}
		if state.OwnerInstalls == nil {
			state.OwnerInstalls = make(map[string]ownerInstallRecord)
		}
		if old, ok := state.OwnerInstalls[grant.Nonce]; ok {
			if old.Digest != digest {
				return errRequestConflict
			}
			result, duplicate = old, true
			return nil
		}
		if msiRequestIDExists(state, grant.RequestID) {
			return errRequestConflict
		}
		for _, old := range state.OwnerInstalls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, old := range state.AutoInstalls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, old := range state.ServiceControls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		if _, ok := state.Requests[grant.RequestID]; ok {
			return errRequestConflict
		}
		if len(state.OwnerInstalls) >= maxStoredRequests {
			return errors.New("APB_REQUEST_CAPACITY_REACHED")
		}
		result = ownerInstallRecord{Grant: grant, Digest: digest, Status: statusExecuting, Code: "EXECUTION_STARTED", CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		state.OwnerInstalls[grant.Nonce] = result
		return s.appendAudit(state, "owner_install.executing", grant.RequestID, result.Code, digest)
	})
	return result, duplicate, err
}

func (s *brokerStore) FinishOwnerInstall(nonce string, status requestStatus, code string, now time.Time) (ownerInstallRecord, error) {
	if status != statusSucceeded && status != statusFailed && status != statusUnknown {
		return ownerInstallRecord{}, errStateInvalid
	}
	var result ownerInstallRecord
	err := s.transact(func(state *persistedBrokerState) error {
		record, ok := state.OwnerInstalls[nonce]
		if !ok || record.Status != statusExecuting || !validAuditCode(code) {
			return errStateInvalid
		}
		record.Status, record.Code, record.UpdatedAt = status, code, now.UTC()
		state.OwnerInstalls[nonce], result = record, record
		return s.appendAudit(state, "owner_install."+string(status), record.Grant.RequestID, code, record.Digest)
	})
	return result, err
}

func (s *brokerStore) GetOwnerInstall(requestID string) (ownerInstallRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range s.state.OwnerInstalls {
		if record.Grant.RequestID == requestID {
			return record, true
		}
	}
	return ownerInstallRecord{}, false
}
