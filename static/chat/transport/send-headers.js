"use strict";

// Compatibility-free outbound message header surface. The regular message
// transport already owns its content type and does not need session-specific
// privilege headers.

(function attachAgentocSendHeadersCore(root) {
  root.AgentocSendHeadersCore = Object.freeze({});
})(typeof globalThis !== "undefined" ? globalThis : {});
