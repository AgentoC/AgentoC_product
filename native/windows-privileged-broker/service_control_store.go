package main

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"time"
)

type serviceControlRecord struct {
	Grant     serviceControlGrant `json:"grant"`
	Digest    string              `json:"digest"`
	Status    requestStatus       `json:"status"`
	Code      string              `json:"code"`
	CreatedAt time.Time           `json:"createdAt"`
	UpdatedAt time.Time           `json:"updatedAt"`
}

func (s *brokerStore) ClaimServiceControl(grant serviceControlGrant, signature string, now time.Time) (serviceControlRecord, bool, error) {
	digest := fmt.Sprintf("%x", sha256.Sum256(serviceControlSigningBytes(grant)))
	var result serviceControlRecord
	duplicate := false
	err := s.transact(func(state *persistedBrokerState) error {
		if state.AutoInstallSigner == nil || state.AutoInstallSigner.KeyID != grant.KeyID {
			return errServiceControlGrant
		}
		key, err := parseAutoInstallPublicKey(state.AutoInstallSigner.PublicKey)
		if err != nil || verifyServiceControlGrant(grant, signature, key, state.AutoInstallSigner.KeyID, state.InstallationID, state.PolicyGeneration, now) != nil {
			return errServiceControlGrant
		}
		if state.ServiceControls == nil {
			state.ServiceControls = make(map[string]serviceControlRecord)
		}
		if old, ok := state.ServiceControls[grant.Nonce]; ok {
			if old.Digest != digest {
				return errRequestConflict
			}
			result, duplicate = old, true
			return nil
		}
		for _, old := range state.ServiceControls {
			if old.Grant.RequestID == grant.RequestID {
				return errRequestConflict
			}
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
		if _, ok := state.Requests[grant.RequestID]; ok {
			return errRequestConflict
		}
		if len(state.ServiceControls) >= maxStoredRequests {
			return errors.New("APB_REQUEST_CAPACITY_REACHED")
		}
		result = serviceControlRecord{Grant: grant, Digest: digest, Status: statusExecuting, Code: "EXECUTION_STARTED", CreatedAt: now.UTC(), UpdatedAt: now.UTC()}
		state.ServiceControls[grant.Nonce] = result
		return s.appendAudit(state, "service_control.executing", grant.RequestID, result.Code, digest)
	})
	return result, duplicate, err
}

func (s *brokerStore) FinishServiceControl(nonce string, status requestStatus, code string, now time.Time) (serviceControlRecord, error) {
	if status != statusSucceeded && status != statusFailed && status != statusUnknown {
		return serviceControlRecord{}, errStateInvalid
	}
	var result serviceControlRecord
	err := s.transact(func(state *persistedBrokerState) error {
		record, ok := state.ServiceControls[nonce]
		if !ok || record.Status != statusExecuting || !validAuditCode(code) {
			return errStateInvalid
		}
		record.Status, record.Code, record.UpdatedAt = status, code, now.UTC()
		state.ServiceControls[nonce], result = record, record
		return s.appendAudit(state, "service_control."+string(status), record.Grant.RequestID, code, record.Digest)
	})
	return result, err
}

func (s *brokerStore) GetServiceControl(requestID string) (serviceControlRecord, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, record := range s.state.ServiceControls {
		if record.Grant.RequestID == requestID {
			return record, true
		}
	}
	return serviceControlRecord{}, false
}
