---
name: systems-cost-model
description: Use before proposing any performance, memory, resource-lifetime, IPC, compiler, database, browser, or cross-process optimisation. Replaces language-level intuition with ownership, boundaries and counts.
---

# The systems cost model

Most wrong optimisations come from reasoning about a mature API as though it were an
ordinary in-process library. Before proposing one, answer these in order, in writing.

1. **Where are the process and isolation boundaries?** Which of these calls crosses one.
2. **Who owns what, for how long, and who disposes it?** Read the ownership contract rather
   than inferring it from the call site.
3. **Classify every operation** as local computation, IPC, serialisation, filesystem, network,
   cache lookup, or resource construction. A call that looks like a property read and is an
   RPC is the whole answer to most of these questions.
4. **What is the intended reuse unit?** A call, a file, a project, a program, a worker, a
   connection, a transaction, a process. Then ask what unit the code is currently using.
5. **Count the operations at real scale.** Not the shape, the count: what scales with the
   2,549 components and what scales with the 29 packages are different curves, and only one
   of them is the problem.
6. **Read the API's own documentation and implementation before overriding its model.** A
   library that batches, caches, or shares by default has usually been asked this question
   before.
7. **Measure wall time, peak resident set, retained objects, request count, and output
   equivalence.** A change that is faster and produces different output is not faster.
8. **Do not call growth a leak.** A leak is retention after the point of expected release,
   and that requires evidence of what is still reachable and why. Memory that is live
   because the work is live is not a leak.
9. **Prefer changing the ownership granularity to adding caps, retries, windows or cleanup
   churn.** A cap is what you add when you have decided not to understand the lifetime.

## The measurement rules that catch most bad numbers

- **Measure the clock before trusting the timing.** Find the smallest non-zero difference
  it reports. A mean of samples that are all 0 or 1 of its ticks is a count of boundaries
  crossed, not a duration, and hundredths of a millisecond in such a figure are an artefact
  of averaging rather than resolution.
- **A pumped or synthetic frame is not a frame.** Work measured inside a harness's own
  callback queue excludes everything the platform does around it, and may not be compared
  to a budget that includes that work.
- **Say what the population was**, not what you intended it to be. A run that did not finish
  draining measured a smaller system than the one you meant to measure.
- **Two readings that disagree are not averaged.** Rule out the clock, the population and
  the arrangement one at a time, and publish them as unreconciled if none of those explains
  the gap.

## What this would have asked, on a real example

Given "documentation generation uses too much memory with per-file TypeScript snapshots":
is each checker call an RPC? Is creating or disposing a snapshot also an RPC? Does a project
already own and cache a program? Is the natural amortisation unit the file or the tsconfig?
Is the memory a leak, or live projects that have not yet become reclaimable? Those questions
are answerable in an hour of reading and settle the design; the intuition that per-file is
"more granular and therefore lighter" is answerable only by a benchmark that was never run.
