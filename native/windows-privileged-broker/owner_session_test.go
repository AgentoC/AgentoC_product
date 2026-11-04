package main

import "testing"

func TestSelectOwnerSession(t *testing.T) {
	const owner = "S-1-5-21-1-2-3-1001"
	tests := []struct {
		name     string
		owner    string
		sessions []ownerSessionCandidate
		want     uint32
	}{
		{"single owner", owner, []ownerSessionCandidate{{3, owner, true, true}}, 3},
		{"case insensitive SID", owner, []ownerSessionCandidate{{3, "s-1-5-21-1-2-3-1001", true, true}}, 3},
		{"other account excluded", owner, []ownerSessionCandidate{{4, "S-1-5-21-1-2-3-1002", true, true}, {3, owner, true, true}}, 3},
		{"service session excluded", owner, []ownerSessionCandidate{{0, owner, true, true}}, 0},
		{"disconnected owner remains usable", owner, []ownerSessionCandidate{{3, owner, false, true}}, 3},
		{"unusable token excluded", owner, []ownerSessionCandidate{{3, owner, true, false}}, 0},
		{"ambiguous owner", owner, []ownerSessionCandidate{{3, owner, true, true}, {4, owner, true, true}}, 0},
		{"missing owner", "", []ownerSessionCandidate{{3, owner, true, true}}, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := selectOwnerSession(tt.owner, tt.sessions)
			if got != tt.want || (err == nil) != (tt.want != 0) {
				t.Fatalf("got (%d, %v), want session %d", got, err, tt.want)
			}
		})
	}
}
