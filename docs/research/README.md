# Research notes, 2026-07-27

Gathered from live vendor docs during the design session, because pricing and
API surfaces here move faster than any model's training data. Every claim the
agents could not confirm against a primary source is marked UNVERIFIED, and
those markers are load-bearing: treat an unverified price as a guess.

Two findings were checked independently and one of them overturned the
original recommendation:

- AssemblyAI's price was confirmed against its own pricing page: Universal-2 at
  $0.15/hr, Universal-3.5 Pro at $0.21/hr. The Deepgram figure was aggregator
  sourced and never confirmed.
- The Google Voice Takeout parser these notes recommend first was ranked purely
  on recency. It has 1 star and no description, so it was rejected in favour of
  writing the parser against the documented selectors.
