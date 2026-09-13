---
type: regex
pattern: "\\b\\d{1,3}\\s?%\\s?(confiden|verified|sure|certain)|confidence[:=]\\s?\\d"
flags: i
match: not_contains
weight: 1
---
