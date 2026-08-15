/**
 * Take the model's private thinking out of what the caller hears.
 *
 * WHY THIS EXISTS. Every cheap model on Telnyx that caches the prompt is a
 * reasoning model, and reasoning models narrate. MiniMax-M3 prefixes the turn
 * right after a tool call with `</mm:think>`, measured 3 times out of 3 on
 * 2026-08-15, and on the assistant path there is nowhere to catch it: Telnyx runs
 * the model and hands its text straight to TTS, so the caller hears the tag read
 * aloud. It fires on the turn that follows `text_me_the_list`, which is the most
 * common good outcome on this line.
 *
 * NO SETTING TURNS IT OFF. `reasoning_effort: none`, `reasoning_effort: low`,
 * `chat_template_kwargs.enable_thinking: false` and `thinking: {type: disabled}`
 * are each accepted with a 200 and each leaked 3 out of 3, the same
 * accepted-and-ignored shape as the top-level `voice` and `voice_speed` fields.
 * And the prompt cannot fix it either: adding a generic "never emit internal
 * tags" line took the rehearsal DOWN from 18/21 to 15/21, because naming the
 * class of thing is what primes a model to produce it.
 *
 * So the strip has to happen in the one place we control, which is the proxy
 * between Telnyx and the model. That is what makes a caching model usable here,
 * and it is the whole reason `external_llm` is worth the extra hop.
 *
 * WHAT IT REMOVES: any XML-ish tag, plus everything inside a thinking block.
 * Stripping every tag is safe because this text is spoken: a caller is never
 * owed a `<` and TTS reads one out as punctuation, so a tag in the stream is a
 * defect whatever produced it.
 *
 * STREAMING IS THE HARD PART. Tokens arrive in chunks and a tag is routinely
 * split across two of them, so a stateless regex over each chunk passes `</mm:`
 * through and then `think>` after it. `Stripper` holds back any trailing text
 * that could still become a tag and re-joins it with the next chunk.
 */

/** Openers whose CONTENT is dropped too, not just the tag. */
const THINK = /^(mm:think|think|thinking|reasoning|reason|scratchpad|analysis)$/i;

/** A complete tag: `<name ...>` or `</name>`. */
const TAG = /^<\/?([a-zA-Z][a-zA-Z0-9:_-]*)[^>]*>/;

/**
 * Could this trailing text still grow into a tag?
 *
 * Only a `<` starts one, so the holdback is the text from the last unclosed `<`
 * to the end. Bounded at 64 characters: past that it is not a tag, it is a
 * caller who said something with a bracket in it, and holding it forever would
 * stall the stream.
 */
function partialTagStart(s: string): number {
  const i = s.lastIndexOf('<');
  if (i === -1) return -1;
  if (s.includes('>', i)) return -1;
  if (s.length - i > 64) return -1;
  // Only hold back something that could still BECOME a tag. A `<` followed by a
  // space never can, and a caller saying "under 5 < 10 cases" is entitled to
  // hear it rather than have it swallowed waiting for a `>` that never comes.
  const after = s.slice(i + 1);
  if (after !== '' && !/^\/?[a-zA-Z]/.test(after) && after !== '/') return -1;
  return i;
}

export class Stripper {
  private held = '';
  private inThink = false;

  /** Feed a chunk, get back only what is safe to speak. */
  push(chunk: string): string {
    let work = this.held + chunk;
    this.held = '';
    let out = '';

    for (;;) {
      if (this.inThink) {
        // Inside a thinking block: everything is private until it closes.
        const close = work.search(/<\/[a-zA-Z][a-zA-Z0-9:_-]*[^>]*>/);
        if (close === -1) {
          // Keep only what might be the start of the closing tag.
          const p = partialTagStart(work);
          this.held = p === -1 ? '' : work.slice(p);
          return out;
        }
        const m = TAG.exec(work.slice(close));
        if (!m) {
          this.held = work.slice(close);
          return out;
        }
        this.inThink = false;
        work = work.slice(close + m[0].length);
        continue;
      }

      const lt = work.indexOf('<');
      if (lt === -1) {
        // No tag in flight. Everything is speakable.
        out += work;
        return out;
      }

      out += work.slice(0, lt);
      const rest = work.slice(lt);
      const m = TAG.exec(rest);
      if (!m) {
        // An incomplete tag, or a stray `<` that is not one.
        const p = partialTagStart(rest);
        if (p === -1) {
          out += rest;
          return out;
        }
        this.held = rest;
        return out;
      }

      // A whole tag. Drop it, and swallow the block if it opens thinking.
      // An ORPHAN CLOSER IS THE COMMON CASE, not an error: MiniMax opens its
      // block before the first streamed token, so the turn starts mid-block and
      // `</mm:think>` is the first thing we see. Dropping the tag alone is
      // exactly right there, which is why this does not try to pair them up.
      if (!m[0].startsWith('</') && THINK.test(m[1])) this.inThink = true;
      work = rest.slice(m[0].length);
    }
  }

  /** End of stream: release anything held that never became a tag. */
  flush(): string {
    const rest = this.held;
    this.held = '';
    // A dangling partial tag is markup that got cut off, so it is not spoken.
    if (this.inThink || TAG.test(rest) || /^<\/?[a-zA-Z][a-zA-Z0-9:_-]*$/.test(rest)) return '';
    return rest;
  }
}

/** One-shot strip, for a non-streamed completion. */
export function stripMarkup(text: string): string {
  const s = new Stripper();
  return (s.push(text) + s.flush()).trim();
}
