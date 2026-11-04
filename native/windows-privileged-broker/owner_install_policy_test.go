package main

import (
	"strings"
	"testing"
)

func TestParseOwnerInstallPolicy(t *testing.T) {
	const good = `{"version":1,"instanceId":"inst_0123456789abcdef0123456789abcdef","controlSid":"S-1-5-80-1-2-3-4-5","executorSid":"S-1-5-80-1-2-3-4-6","ownerSid":"S-1-5-21-100-200-300-1001","port":7690}`
	policy, err := parseOwnerInstallPolicy([]byte(good))
	if err != nil || policy.OwnerSID != "S-1-5-21-100-200-300-1001" {
		t.Fatalf("valid policy rejected: %+v %v", policy, err)
	}
	for _, input := range []string{
		strings.Replace(good, `"port":7690`, `"port":7690,"port":7690`, 1),
		strings.Replace(good, `"port":7690`, `"port":7690,"extra":true`, 1),
		strings.Replace(good, `"ownerSid":"S-1-5-21-100-200-300-1001"`, `"ownerSid":"S-1-5-18"`, 1),
		strings.Replace(good, `"executorSid":"S-1-5-80-1-2-3-4-6"`, `"executorSid":"S-1-5-80-1-2-3-4-5"`, 1),
		good + `{}`,
		strings.Repeat(" ", 8193),
	} {
		if _, err := parseOwnerInstallPolicy([]byte(input)); err == nil {
			t.Fatalf("invalid policy accepted: %q", input[:min(len(input), 180)])
		}
	}
}
