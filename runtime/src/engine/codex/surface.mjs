// Stable server notifications ad deliberately does not turn into events, each
// with the reason. events.mjs handles the rest; the exhaustiveness test checks
// that every notification of the pinned Codex (protocol-notifications.json) is
// in exactly one of the two places, so a Codex release that adds one fails the
// test until someone decides.
//
// Experimental notifications are never sent to us (we don't opt in to
// experimentalApi), so they are listed with the reason "experimental".

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

for (const method of notifications.experimental) IGNORED_NOTIFICATIONS[method] ??= "experimental: never sent without experimentalApi";

export const PINNED_NOTIFICATIONS = notifications;
