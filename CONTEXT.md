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
A passage that came back materially under the floor its run was given. It is
reported as a warning and never enforced: the prose was written and paid for,
and a count is the one requirement the run can check itself, so the honest move
is to hand the prose over and say what it measured.

**Style**:
A named register the prose is written in, such as reportage or commentary.
Language is not part of a style: the same style can be written in any language.

A style is a specification, not an adjective. "Vivid" reaches the writer as the
average of everything ever called vivid, which is the most worn version of it;
what constrains a sentence is a move the writer can perform and a failure it can
be told to steer around. Every style names both, and `match` is the one with no
register of its own — it takes
the draft's, which is why it is the default under continue and expand, where a
register chosen for the run would show at the seam it exists to hide.
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
The habits that make prose read as machine-made — antithesis-and-uplift, the
three-part list as a default rhythm, meta-commentary, surviving adverbs. They
belong to no style, so they are stated once beside the brief rather than copied
into every style entry, and they hold in every language.

**Partial prose**:
The text a writing run had produced when it was cut short by a timeout, an error,
or an interrupt. It is delivered, marked incomplete — half a draft is useful,
which is why this differs from a report preview, where half the evidence would
mislead.
