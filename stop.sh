#!/bin/bash
set -e
echo "Stopping AgentoC services..."

if [[ "$(uname)" == "Darwin" ]]; then
  launchctl unload ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server not loaded"
  if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
    launchctl unload ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared not loaded"
  fi
if [ -f ~/Library/LaunchAgents/com.agentoc.natapp.dual-proxy.plist ]; then
  launchctl unload ~/Library/LaunchAgents/com.agentoc.natapp.dual-proxy.plist 2>/dev/null || echo "natapp prefix bridge not loaded"
fi
else
  linux_system_unit_exists() {
    local unit="$1"
    systemctl list-unit-files "${unit}.service" &>/dev/null 2>&1 || systemctl status "${unit}.service" &>/dev/null 2>&1
  }

  owner_unit="agentoc"
  if ! linux_system_unit_exists "$owner_unit" && linux_system_unit_exists "agentoc-promoted"; then
    owner_unit="agentoc-promoted"
  fi

  sudo systemctl stop agentoc-quick-tunnel.service 2>/dev/null || true
  sudo systemctl stop "${owner_unit}.service" 2>/dev/null || echo "chat-server not running"
  sudo systemctl stop agentoc-runner-supervisor.service 2>/dev/null || true
  systemctl --user stop agentoc-tunnel.service 2>/dev/null || true
fi

echo "Services stopped!"
