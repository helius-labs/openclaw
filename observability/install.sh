#!/bin/bash
# Install the Agent Observability Dashboard as a systemd user service
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="openclaw-observability"

mkdir -p ~/.config/systemd/user

cat > ~/.config/systemd/user/${SERVICE_NAME}.service << EOF
[Unit]
Description=OpenClaw Agent Observability Dashboard
After=network.target

[Service]
Type=simple
WorkingDirectory=${SCRIPT_DIR}
ExecStart=/usr/bin/node ${SCRIPT_DIR}/server.mjs --port 9111
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable ${SERVICE_NAME}
systemctl --user start ${SERVICE_NAME}

echo "✅ ${SERVICE_NAME} installed and started"
echo "   Dashboard: http://127.0.0.1:9111"
echo "   Access: ssh -L 9111:127.0.0.1:9111 ubuntu@$(hostname -I | awk '{print $1}')"
echo ""
echo "   systemctl --user status ${SERVICE_NAME}"
echo "   journalctl --user -u ${SERVICE_NAME} -f"
