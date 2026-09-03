// The MCP `instructions` field: the only channel this server has for standing
// guidance.
//
// Why it exists, written the day it was needed: an artifact built from this
// server's data came back with no CloudYali palette, no ECharts, no logo, no
// timestamp and no AI notice. Every one of those rules was already written down
// and correct — in `cloudyali://design`, which is an MCP *resource*.
//
// Resources are pull-only. Tool definitions are pushed into the model's context
// on every session; a resource is read when something decides to read it, and
// nothing in the pushed surface said the design system existed. So the rules
// were, in the precise sense this codebase keeps rediscovering, correct in
// isolation and inert in place — the same defect as a verification code on
// stderr, or a countdown cancelled by the click that starts it.
//
// `instructions` is the fix because clients MAY add it to the system prompt,
// which is the only way a rule about output reaches a model that has not asked.
// Note MAY, not MUST: this is a hint, and the artifact is assembled by the
// client, not here. Nothing on this side can enforce it. So keep this short
// enough that a client which does inject it is not paying much, and specific
// enough to be actionable without a second read.
export const SERVER_INSTRUCTIONS = `CloudYali FinOps data (read-only).

Before drawing ANY chart, dashboard, report or artifact from this data, read the
resource cloudyali://design. It is short, and it carries three things you cannot
guess: the categorical palette, which colours are reserved for meaning
(increase/decrease/forecast are NOT free to reuse), and the provenance stamp
every generated artifact must carry at the TOP — CloudYali mark, the time it was
generated, and a one-line notice that it is AI-generated and the figures should
be verified. Charts are Apache ECharts; register the theme from
cloudyali://echarts-theme rather than hand-picking hex values.

Two rules about what you write:

- If a tool result starts with a WARNING, the number under it is qualified.
  Carry that qualification into whatever you build. A caveat that stops at the
  chat and does not reach the artifact has protected nobody.
- Say what the reader observes, never how it works underneath — and never what
  CloudYali has or has not built. Neither you nor this server can see behind the
  API, so any such account would be invented.`;
