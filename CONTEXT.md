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
draft. Distinct from the draft itself.
_Avoid_: Prompt, question

**Draft**:
The existing prose a writing run works from. Required by the continue and expand
modes, refused by the new mode.
_Avoid_: Input text, source

**Mode**:
Which of the three things a writing run does to its input: **new** writes from a
brief alone; **continue** carries a draft on past its ending; **expand** makes
the same material fuller. All three produce a whole finished piece, never an
increment — continue emits the draft along with what it added.

**Style**:
A named register the prose is written in, such as reportage or commentary.
Language is not part of a style: the same style can be written in any language.
_Avoid_: Voice, tone, persona

**Partial prose**:
The text a writing run had produced when it was cut short by a timeout, an error,
or an interrupt. It is delivered, marked incomplete — half a draft is useful,
which is why this differs from a report preview, where half the evidence would
mislead.
