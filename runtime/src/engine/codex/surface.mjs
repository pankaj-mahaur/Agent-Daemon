// Stable server notifications ad deliberately does not turn into events, each
// with the reason. events.mjs handles the rest; the exhaustiveness test checks
// that every notification of the pinned Codex (protocol-notifications.json) is
// in exactly one of the two places, so a Codex release that adds one fails the
// test until someone decides.
//
// Experimental notifications never reach us: the stable-only front ends don't
// opt in to experimentalApi, and `ad tui`, which does (for the allowlist
// below), opts out of every experimental notification it doesn't handle. They
// are listed with the reason "experimental", except the allowlisted ones,
// which events.mjs handles.

import notifications from "./protocol-notifications.json" with { type: "json" };

export const IGNORED_NOTIFICATIONS = {
  "thread/attachment/updated": "thread attachments are not part of ad's UI",
  "rawResponseItem/completed": "raw model output, only for debugging clients",
  "rawResponse/completed": "raw model output, only for debugging clients",
  "command/exec/outputDelta": "ad doesn't use the standalone command/exec request",
  "account/gatewayOAuth/changed": "gateway sign-in is not part of ad",
  "app/list/updated": "ChatGPT apps are not part of ad's UI",
  "remoteControl/status/changed": "remote control is not part of ad",
  "externalAgentConfig/import/progress": "ad doesn't import other agents' config through Codex",
  "externalAgentConfig/import/completed": "ad doesn't import other agents' config through Codex",
  "fs/changed": "ad doesn't use Codex's file watching",
  "fuzzyFileSearch/sessionUpdated": "ad uses one-shot fuzzyFileSearch, not search sessions",
  "fuzzyFileSearch/sessionCompleted": "ad uses one-shot fuzzyFileSearch, not search sessions",
};

// The experimental app-server calls ad may make (codex-parity-2 P0): `ad tui`
// opts into experimentalApi for these only; every other request stays on the
// stable surface. The fake app-server rejects anything experimental outside
// this list (testkit/protocol-check.mjs), so a new use has to be added here on
// purpose. Plan mode (Part 4) and /stop (Part 5) use them.
export const EXPERIMENTAL_ALLOWLIST = {
  methods: ["collaborationMode/list", "thread/settings/update", "thread/backgroundTerminals/clean"],
  // method → params fields that only exist with experimentalApi
  fields: { "turn/start": ["collaborationMode"] },
  // experimental notifications ad handles; every other one is opted out of
  notifications: ["thread/settings/updated"],
};

for (const method of notifications.experimental) {
  if (!EXPERIMENTAL_ALLOWLIST.notifications.includes(method)) IGNORED_NOTIFICATIONS[method] ??= "experimental: opted out (ad tui) or never sent without experimentalApi";
}

export const PINNED_NOTIFICATIONS = notifications;

/**
 * initialize capabilities for the front end that uses the allowlist (`ad tui`):
 * experimentalApi on, and every experimental notification it doesn't handle
 * opted out, so the traffic stays what ad knows how to render.
 */
export function experimentalCapabilities() {
  return {
    experimentalApi: true,
    optOutNotificationMethods: notifications.experimental.filter((m) => !EXPERIMENTAL_ALLOWLIST.notifications.includes(m)),
  };
}
