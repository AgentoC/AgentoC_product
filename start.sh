#!/bin/bash
set -e
echo "Starting AgentoC services..."

if [[ "$(uname)" == "Darwin" ]]; then
  if [ -f ~/Library/LaunchAgents/com.chatserver.claude.plist ]; then
    launchctl load ~/Library/LaunchAgents/com.chatserver.claude.plist 2>/dev/null || echo "chat-server already loaded"
  fi
  if [ -f ~/Library/LaunchAgents/com.cloudflared.tunnel.plist ]; then
    launchctl load ~/Library/LaunchAgents/com.cloudflared.tunnel.plist 2>/dev/null || echo "cloudflared already loaded"
  fi
if [ -f ~/Library/LaunchAgents/com.agentoc.natapp.dual-proxy.plist ]; then
  launchctl load ~/Library/LaunchAgents/com.agentoc.natapp.dual-proxy.plist 2>/dev/null || echo "natapp prefix bridge already loaded"
fi
  echo "Services started!"
  echo ""
  echo "Check status with:"
  echo "  launchctl list | grep -E 'chatserver|cloudflared|natapp'"
else
  linux_system_unit_exists() {
    local unit="$1"
    systemctl list-unit-files "${unit}.service" &>/dev/null 2>&1 || systemctl status "${unit}.service" &>/dev/null 2>&1
  }

  owner_unit="agentoc"
  if ! linux_system_unit_exists "$owner_unit" && linux_system_unit_exists "agentoc-promoted"; then
    owner_unit="agentoc-promoted"
  fi

  if systemctl list-unit-files agentoc-runner-supervisor.service &>/dev/null 2>&1; then
    sudo systemctl start agentoc-runner-supervisor.service
  fi
  sudo systemctl start "${owner_unit}.service"
  if systemctl list-unit-files agentoc-quick-tunnel.service &>/dev/null 2>&1; then
    sudo systemctl start agentoc-quick-tunnel.service
    sleep 5
  fi
  if systemctl --user list-unit-files agentoc-tunnel.service &>/dev/null 2>&1; then
    systemctl --user start agentoc-tunnel.service
  fi
  echo "Services started!"
  echo ""
  echo "Check status with:"
  echo "  systemctl status ${owner_unit}.service"
  if systemctl list-unit-files agentoc-quick-tunnel.service &>/dev/null 2>&1; then
    echo "  systemctl status agentoc-quick-tunnel.service"
    TUNNEL_URL=$(grep -E '^AGENTOC_PUBLIC_BASE_URL=' /etc/agentoc/agentoc.env 2>/dev/null | tail -1 | cut -d= -f2-)
    if [ -z "$TUNNEL_URL" ]; then
      TUNNEL_URL=$(grep -Eho 'https://[^[:space:]]+trycloudflare\.com' /var/log/agentoc/cloudflared.log /var/log/agentoc/cloudflared.error.log 2>/dev/null | tail -1 || true)
    fi
    ACCESS_TOKEN=$(node -e 'try { process.stdout.write(JSON.parse(require("fs").readFileSync(process.env.HOME + "/.config/agentoc/auth.json", "utf8")).token || "") } catch {}' 2>/dev/null)
    if [ -n "$TUNNEL_URL" ] && [ -n "$ACCESS_TOKEN" ]; then
      echo ""
      echo "Current access URL:"
      echo "  ${TUNNEL_URL}/?token=${ACCESS_TOKEN}"
    fi
  fi
fi
