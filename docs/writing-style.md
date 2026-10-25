# Writing style

All docs and code comments in this repo follow ASD-STE100 (Simplified
Technical English). Use the rules on this page when you write or change
prose. The goal is clear English that has only one meaning. Do not make a
sentence worse only to replace a word.

## Words

- Use approved words with their approved meaning. Common replacements:

  | Do not write | Write |
  | --- | --- |
  | utilize, make use of | use |
  | perform, carry out | do |
  | prior to | before |
  | in order to | to |
  | via | through, with |
  | e.g. | for example |
  | i.e. | that is |
  | ensure | make sure |
  | require, need (verb) | must, is necessary |
  | obtain | get |
  | spawn (in prose) | start |

- Technical names and technical verbs are permitted. Use these project
  terms as they are, with one meaning each: guest, host, capability,
  runner, worker, run (noun), registry, facade, proxy, supersede, respawn,
  settle, queue, abort, timeout, backstop, heap, WASM, RPC, bundler.
- Do not use contractions. Write "cannot", not "can't".
- Do not use a phrasal verb when a single verb is available. Write
  "start", not "spin up".
- Do not use more than three nouns in a cluster. Use "of" or "for" to
  break up a longer cluster.
- Keep the articles ("the", "a").

## Verbs

- Use only the simple tenses: present, past and future ("will").
- Do not use an -ing form as a noun or an adjective. Write "before you
  start the worker", not "before starting the worker".
- Use the active voice. In descriptions, use the passive voice only when
  the agent is not known or not important.
- In procedures, use the imperative. Write one instruction in each
  sentence.

## Sentences and paragraphs

- Procedural sentences: 20 words or fewer. Descriptive sentences: 25
  words or fewer.
- Write one topic in each sentence. Do not join sentences with a
  semicolon.
- Use a vertical list for a long series of items.
- Write one topic in each paragraph, with six sentences or fewer.
- Put a warning or a caution before the step that it applies to. Give the
  instruction first, then the risk.

## Exceptions

- Do not change code, identifiers, text in backticks, runtime error
  messages or test names (`it()` and `describe()` strings).
- Short JSDoc summaries and headings can be noun phrases. STE permits
  titles and labels.
- Keep "MUST" and "SHOULD" in the [proxy protocol](proxy-protocol.md).
  They are requirement keywords.
- Do not change the wording of the security goal in `README.md`,
  `SECURITY.md` and [threat-model.md](threat-model.md) unless the meaning
  stays the same.
