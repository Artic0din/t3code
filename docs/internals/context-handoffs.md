# Context handoffs

Portable handoffs do not claim native provider context parity. They do not
reconstruct provider-native session state, tool state, approvals, or omitted
text.

Provider handoffs use either the full eligible app history or the delta since
that provider last participated. `prepareProviderHandoff` turns each eligible
item into a message with `historicalMessage()` and keeps whole items that fit
the token budget with `selectHistory()`. An item that does not fit is omitted
whole. Provider `summaryText` is `renderHistory` of that selection.

Fork merge-back `summaryText` summarizes eligible delta items from the child.
`compactText` builds only that text. It replaces every whitespace run with one
space, trims the result, and returns at most 240 characters. A truncated value
contains the first 237 characters followed by `...`. That summary includes user
messages, assistant messages, command executions, file changes, checkpoints, and
prior handoffs. It skips other turn item types. File changes carry the filename,
while checkpoints carry only the number of files. The fork record also stores
`history` of whole items chosen with `selectHistory()`.

Delivery selects whole items from each handoff `history` with `selectHistory()`
inside the delivery token budget. It includes `summaryText` only for older
handoffs that have no `history`.

Legacy v1 continuation uses a separate algorithm. It considers only user and
assistant messages, walks backward from the newest message, and builds a
transcript suffix within a 32,000-character budget. Do not describe that
migration budget as the limit for portable handoffs, and do not describe the
240-character prefix as a migration rule.
