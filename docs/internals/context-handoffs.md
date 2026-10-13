# Context handoffs

Portable provider and fork handoffs are textual summaries. They do not claim native provider context
parity.

Provider handoff command records have an 8 KiB JSON-encoded text limit.
Long inputs and outputs retain their beginning and end, the exit code, and a retrieval marker.
Outputs retain at most the first and last 20 lines, with byte limits within those lines.
History selection keeps each transformed command record whole and preserves recency after pinned conversation and plan items.
Native-context estimates include retired native plans, full native commands, and the saved text of the handoff that actually delivered imported commands.
Older delivery receipts can assign differing copies of an item to several handoffs.
Those ambiguous receipts use the largest saved text as a conservative estimate until native token telemetry is available, which can reduce the allowance for additional history.

`ContextHandoffServiceV2` includes user messages, assistant messages, command executions, file
changes, checkpoints, and prior handoffs. It skips other turn item types. For text-bearing items,
`compactText` replaces every whitespace run with one space, trims the result, and returns at most
240 characters. A truncated value contains the first 237 characters followed by `...`. File changes
carry the filename, while checkpoints carry only the number of files.

Provider handoffs use either the full eligible app history or the delta since that provider last
participated. Fork merge-back handoffs summarize eligible delta items from the child. Neither path
reconstructs provider-native session state, tool state, approvals, or omitted text.

Legacy v1 continuation uses a separate algorithm. It considers only user and assistant messages,
walks backward from the newest message, and builds a transcript suffix within a 32,000-character
budget. Do not describe that migration budget as the limit for portable handoffs, and do not describe
the 240-character prefix as a migration rule.
