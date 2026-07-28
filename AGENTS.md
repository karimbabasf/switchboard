<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# The same applies to AssemblyAI

Fetch https://www.assemblyai.com/docs/llms.txt before writing or changing any
AssemblyAI code. Parameter names have moved and memorized ones are wrong:
`speech_models` is a plural array taking exactly `universal-3-5-pro` or
`universal-2`, the singular `speech_model` is deprecated, and `auto_chapters`,
`summarization`, `summary_model` and `summary_type` are gone (we summarize
through NEAR AI Cloud instead). A cast written to silence the SDK's types means
read the docs, not that the SDK is behind.
