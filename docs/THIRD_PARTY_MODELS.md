# Record model provenance

## 1. State what ships: no model

No AI model, model weights or model runtime ship with this source or run in a session. Earlier
versions of this package pinned a small open-weight model and its runtime image. Both were retired
when the AI moved to the hosted Claude API (see docs/plans/CLAUDE_ONLY_SCOPE.md in the owner
repository). Nothing in this export downloads them, and no container needs their network.

## 2. Record hosted use: one fixed endpoint

AI suggestions call the Anthropic Messages API at its fixed address, https://api.anthropic.com,
through the official @anthropic-ai/sdk package, which is listed with the other dependencies in
THIRD_PARTY_NOTICES.txt. The caller supplies an Anthropic API key in the shell that starts a
session. The launcher passes it to the app container by name only, never writes it to a file and
never prints it. Use of the hosted API is governed by Anthropic's own terms, not by the
application MIT license. This package grants no rights to Anthropic services.

## 3. Bound the cost: sixty requests per process

One app process sends at most 60 Claude requests in total across receipt suggestions, expense
proposals and the analytics explainer. The limit is a constant in the source, not a setting, and
past it AI suggestions are off until the app restarts. Manual review stays available. Without a
key, no request is ever made.
