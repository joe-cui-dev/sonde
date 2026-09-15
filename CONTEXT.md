# Sonde

Sonde runs model-backed workflows over a shared spine: configuration, budget
accounting, run history, and streaming output. It has two workflows — research,
which answers a question from retrieved source evidence, and writing, which
produces prose from a brief or an existing draft.

## Language

**Workflow**:
One kind of work Sonde knows how to do end to end. There are two: research and
writing. They share the spine and nothing else.
_Avoid_: Pipeline, job, task

**Run**:
A single execution of a workflow, identified by a run id and recorded in run
history whatever its outcome.

**Run record**:
The stored history of a run. Its `question` and `report_json` columns are named
for the research workflow, which came first; on a writing run they hold the
brief and the finished prose. The names are wrong and the data is right.

## Research

**Synthesis**:
The stage that turns research notes and source evidence into a research report.

**Report preview**:
An incomplete view of a report while synthesis is in progress. Its citations have
not yet undergone final validation.

**Final report**:
The completed research report after structural and citation validation. Citation
validation may remove unsupported references or produce warnings; it does not
establish that every claim is true.

## Writing

**Writing run**:
A run of the writing workflow: one model turn, no retrieval, no citations. Its
product is prose, not evidence.

**Brief**:
The instruction given to a writing run — what to write, or what to do to the
draft. Distinct from the draft itself. Read as a list of requirements, every one
of them binding: a brief that names a passage, a starting point, material to add
and a length is asking for all four, and prose that honours only the first has
not done the job.
_Avoid_: Prompt, question

**Draft**:
The existing prose a writing run works from. Required by the continue and expand
modes, refused by the new mode. Continue carries it into its output; expand
reads it as context only and never reproduces it.
_Avoid_: Input text, source

**Mode**:
Which of the three things a writing run does to its input: **new** writes from a
brief alone; **continue** carries a draft on past its ending; **expand** opens up
the one part of the draft that the brief names.

New and continue produce a whole finished piece — continue emits the draft along
with what it added, never only the increment. Expand is the exception: its
product is the passage alone. Returning the draft with one part opened up would
bury the new writing in prose the user already had, and would let the writer
quietly revise work they were happy with; where the passage goes is theirs to
decide.

**Length**:
The word count a writing run is asked for, as `--length`. It counts the prose the
run is being asked to produce: under new and continue the whole piece, as a soft
target; under expand the passage, as a floor. Characters, not words, for CJK
writing. A length stated in the brief governs over the flag — the brief is the
more specific instruction, and two numbers in front of the writer would
otherwise contradict each other.

**Shortfall**:
Prose that came back materially under the count its run was given. It is
reported as a warning and never enforced: the prose was written and paid for,
and a count is the one requirement the run can check itself, so the honest move
is to hand the prose over and say what it measured.

Every mode that was given a count is measured, but not against the same
margin, because the count does not mean the same thing in each. Under expand it
is a floor, and a few percent under a floor is the estimate's error rather than
a miss. Under new and continue it is a soft target, where the same margin would
fire on a piece delivered at 1,750 of the 2,000 asked for — and a warning that
is noise is a warning nobody reads; what is worth naming there is the
order-of-magnitude failure, prose that stopped in its first paragraph or a
model that answered the brief with a line about not writing it. The warning
reports the measurement and names no cause: a count cannot tell those two
apart, and a cause stated here would be a guess dressed as a finding.

**Style**:
A named register the prose is written in, such as reportage or commentary.
Language is not part of a style: the same style can be written in any language.

A style is a specification, not an adjective. "Vivid" reaches the writer as the
average of everything ever called vivid, which is the most worn version of it;
what constrains a sentence is a move the writer can perform and a failure it can
be told to steer around. Every style names both, and `match` is the one with no
register of its own — it takes
the draft's, which is why it is the default under continue and expand, where a
register chosen for the run would show at the seam it exists to hide. A new run
has no default: unnamed, the style is absent, and the prompt goes out with no
style section and no closing hold at all, rather than a register nobody asked
for.
_Avoid_: Voice, tone, persona

**Styles file**:
Styles of the writer's own, as JSON at `SONDE_STYLES_FILE` (`.sonde/styles.json`,
gitignored). Its entries join the built-in styles, and one named for a built-in
replaces that style outright rather than merging into it — the writer receives
exactly one spec, and the file is the whole of it. Absent is the ordinary case
and means the built-ins alone; present and malformed is an error, because a run
that fell back quietly would write the piece in a register nobody chose and the
prose is paid for by then.
_Avoid_: Style config, custom prompt

**House rules**:
A small language-neutral baseline for clarity: no process commentary or
restatement of the brief, precise rather than vague or inflated wording, and no
modifiers or repetition that add no meaning. It is stated once beside the brief
and deliberately avoids prescribing rhythm, imagery, punctuation, or emotional
distance; those choices belong to the brief and the selected style.
_Avoid_: Language-specific constructions, house style

**Granularity**:
How much story passes per paragraph: how much time, and how much of an action
gets shown rather than reported. Distinct from [[Length]], which says how much
prose to produce and nothing about how finely it moves, and from [[Style]],
which pitches the sentences without saying what they cover.

The failure is drift, not a wrong setting: the cheapest way to reach a count is
to narrate faster, so a piece opens at full grain and thins as it runs, until
the second half reports what the first half showed. Holding one granularity is
therefore stated as habits to steer around — blurred time, a process compressed
into its result, a step outside the scene to explain it — and those hold
whatever the count. A count can additionally be read as a scope, one continuous
stretch of action rather than a summary of several, but only where the figure
means the prose being asked for: under continue it covers the carried draft as
well, and a scope derived from it would describe a piece mostly already written.
_Avoid_: Pacing, detail level

**Partial prose**:
The text a writing run had produced when it was cut short by a timeout, an error,
or an interrupt. It is delivered, marked incomplete — half a draft is useful,
which is why this differs from a report preview, where half the evidence would
mislead.

**Output ceiling**:
The cap on a single model turn's completion. OpenRouter spends reasoning out of
the same allowance as the prose, so the ceiling is not a length for the piece:
it is the room the piece needs plus the room the thinking will take. It is a
stop and never a target — setting it high spends nothing, while a piece cut off
mid-sentence wastes everything already paid for.
_Avoid_: Reading it as the length of the output

**Reasoning headroom**:
The part of an [[Output ceiling]] that exists for the model to think in. An
overhead, not a proportion: how long a provider thinks is set by the task and by
its own reading of the effort level, not by the ceiling it was handed, and a
ceiling too small to hold the thinking does not compress it — it truncates it.
Thinking truncated before the first word of prose returns nothing at all, which
is the worst outcome the writing workflow has, because the run is paid for and
the writer has nothing to read.

Budgeting it as a proportion had the shrinkage the wrong way round. A fixed
overhead costs a short piece most, so the smallest [[Length]] was the one that
failed: measured at 600 words, a proportional ceiling returned prose once in ten
attempts. As an overhead the headroom is the same whatever the count, and the
figures sit well above any measured appetite, since headroom left unspent costs
nothing.

No figure closes the question, because the appetite has a tail the effort level
does not bound — the same brief that thinks for 400 tokens on one attempt thinks
for 3,700 on the next. Headroom sized for a measured tail can only move that
tail, never remove it. So a run whose first attempt reached the ceiling having
written nothing makes a second with reasoning switched off, the one remaining
shape of the request whose whole ceiling belongs to the writing. It is a second
charge, so it is announced as a warning rather than made quietly, and it is
narrow on purpose: [[Partial prose]] is delivered as what it is rather than
thrown away and bought again.
