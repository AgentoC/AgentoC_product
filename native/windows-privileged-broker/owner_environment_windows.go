//go:build windows

package main

import (
	"path/filepath"
	"strings"
)

// ownerInstallEnvironment takes profile paths only from CreateEnvironmentBlock
// for the verified owner token. It deliberately excludes PATH, PowerShell and
// .NET startup variables and all caller-supplied variables.
func ownerInstallEnvironment(userEnvironment []string, root, systemDir, vendor string) ([]string, error) {
	for _, value := range []string{root, systemDir, vendor} {
		if !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
			return nil, errOwnerSessionUnavailable
		}
	}
	keys := map[string]string{"USERPROFILE": "", "LOCALAPPDATA": "", "APPDATA": "", "TEMP": "", "TMP": ""}
	seen := make(map[string]bool)
	for _, item := range userEnvironment {
		key, value, ok := strings.Cut(item, "=")
		key = strings.ToUpper(key)
		if _, wanted := keys[key]; !ok || !wanted {
			continue
		}
		if seen[key] || !filepath.IsAbs(value) || strings.ContainsRune(value, 0) {
			return nil, errOwnerSessionUnavailable
		}
		seen[key] = true
		keys[key] = value
	}
	if keys["USERPROFILE"] == "" || keys["LOCALAPPDATA"] == "" || keys["APPDATA"] == "" {
		return nil, errOwnerSessionUnavailable
	}
	// The user's profile may be on a non-system drive or a redirected share.
	// Don't substitute the service account's temporary directory.
	if keys["TEMP"] == "" {
		keys["TEMP"] = filepath.Join(keys["LOCALAPPDATA"], "Temp")
	}
	if keys["TMP"] == "" {
		keys["TMP"] = keys["TEMP"]
	}
	values := []string{"SystemRoot=" + root, "WINDIR=" + root, "SystemDrive=" + filepath.VolumeName(root),
		"PATH=" + systemDir, "PSModulePath=" + filepath.Join(vendor, "PowerShell", "Modules"),
		"POWERSHELL_TELEMETRY_OPTOUT=1", "DOTNET_CLI_TELEMETRY_OPTOUT=1",
		"AGENTOC_INSTALL_MODULE=" + filepath.Join(vendor, "Microsoft.WinGet.Client", "Microsoft.WinGet.Client.psd1")}
	for _, key := range []string{"USERPROFILE", "LOCALAPPDATA", "APPDATA", "TEMP", "TMP"} {
		values = append(values, key+"="+keys[key])
	}
	return values, nil
}
