package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"time"
)

type msiInstallRecord struct {
	Grant     msiInstallGrant `json:"grant"`
	Digest    string          `json:"digest"`
	Status    requestStatus   `json:"status"`
	Code      string          `json:"code"`
	CreatedAt time.Time       `json:"createdAt"`
	UpdatedAt time.Time       `json:"updatedAt"`
}

func msiRequestIDExists(state *persistedBrokerState, id string) bool {
	for _, record := range state.MSIInstalls {
		if record.Grant.RequestID == id {
			return true
		}
	}
	return false
}

// Claim is durably persisted before execution. An identical replay returns the
// original record, never a second permission to start an installer.
func (s *brokerStore) ClaimMSIInstall(grant msiInstallGrant, signature string, now time.Time) (msiInstallRecord, bool, error) {
	message, err := msiInstallSigningBytes(grant)
	if err != nil {
		return msiInstallRecord{}, false, err
	}
	digest := fmt.Sprintf("%x", sha256.Sum256(message))
	var result msiInstallRecord
	duplicate := false
	err = s.transact(func(state *persistedBrokerState) error {
		if grant.BrokerInstallationID != state.InstallationID || grant.PolicyGeneration != state.PolicyGeneration || state.AutoInstallSigner == nil || state.AutoInstallSigner.KeyID != grant.KeyID {
			return errMSIInstallGrant
		}
		key, err := parseAutoInstallPublicKey(state.AutoInstallSigner.PublicKey)
		if err != nil || verifyMSIInstallGrant(grant, signature, key, now) != nil {
			return errMSIInstallGrant
		}
		if state.MSIInstalls == nil {
			state.MSIInstalls = make(map[string]msiInstallRecord)
		}
		if old, ok := state.MSIInstalls[grant.Nonce]; ok {
			if old.Digest != digest {
				return errRequestConflict
			}
			result, duplicate = old, true
			return nil
		}
		if msiRequestIDExists(state, grant.RequestID) {
			return errRequestConflict
		}
		for _, old := range state.AutoInstalls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
		}
		for _, old := range state.OwnerInstalls {
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
		if len(state.MSIInstalls) >= maxStoredRequests {
			return errors.New("APB_REQUEST_CAPACITY_REACHED")
		}
		result = msiInstallRecord{Grant: grant, Digest: digest, Status: statusExecuting, Code: "EXECUTION_STARTED", CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		state.MSIInstalls[grant.Nonce] = result
		return s.appendAudit(state, "msi_install.executing", grant.RequestID, result.Code, digest)
	})
	return result, duplicate, err
}

func (s *brokerStore) FinishMSIInstall(nonce string, status requestStatus, code string, now time.Time) (msiInstallRecord, error) {
	if status != statusSucceeded && status != statusFailed && status != statusUnknown {
		return msiInstallRecord{}, errStateInvalid
	}
	var result msiInstallRecord
	err := s.transact(func(state *persistedBrokerState) error {
		record, ok := state.MSIInstalls[nonce]
		if !ok || record.Status != statusExecuting || !validAuditCode(code) {
			return errStateInvalid
		}
		record.Status, record.Code, record.UpdatedAt = status, code, now.UTC()
		state.MSIInstalls[nonce], result = record, record
		return s.appendAudit(state, "msi_install."+string(status), record.Grant.RequestID, code, record.Digest)
	})
	return result, err
}

func (s *brokerStore) GetMSIInstall(requestID string) (msiInstallRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range s.state.MSIInstalls {
		if record.Grant.RequestID == requestID {
			return record, true
		}
	}
	return msiInstallRecord{}, false
}
