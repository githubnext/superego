// "Where it got lost": what a run read of the shipped help (counted from its tool calls), and a model's reading of the
// transcript (wrong guesses about the API, detours outside the help); then all runs' stumbles, rolled up and ranked.
import { toolCalls } from './transcript.ts'

/** What a run looked at, from its tool calls: help it read, and where it went beyond it. */
export function helpUsed(entries: any[], installDir: string) {
  const help = new Set<string>(); const source = new Set<string>(); const web = new Set<string>(); const blocked = new Set<string>()
  for (const call of toolCalls(entries)) {
    const text = call.name === 'bash' ? String(call.args?.command ?? '') : String(call.args?.path ?? call.args?.file_path ?? '')
    if (call.name === 'bash') {
      for (const m of text.matchAll(/superego\s+--skill(?:\s+([a-z-]+))?/g)) help.add(`superego --skill${m[1] ? ` ${m[1]}` : ''}`)
      for (const m of text.matchAll(/superego\s+(?:help|([a-z-]+)(?:\s+[a-z-]+)?\s+(?:--help|-h))\b/g)) help.add(m[0].replace(/\s+/g, ' '))
      if (/\b(?:curl|wget)\b[^|;&]*https?:\/\/(?!wttr|api\.open-meteo|geocoding|api\.openweathermap|localhost|127\.)/.test(text)) web.add(text.slice(0, 160))
    }
    for (const m of text.matchAll(/[\w./~-]*(?:SKILL\.md|\/skill\/[\w-]+\.md|docs\/[\w./-]+|out\/types\/[\w./-]+|\.superego\/types[\w./-]*)/g)) help.add(m[0].replace(installDir, '<install>'))
    for (const m of text.matchAll(/[\w./~-]*out\/(?:main|renderer|preload)\/[\w./-]+/g)) source.add(m[0].replace(installDir, '<install>'))
    if (/Operation not permitted/.test(call.result ?? '')) blocked.add(text.slice(0, 160))
  }
  return { help: [...help], source: [...source], web: [...web], sandboxBlocked: [...blocked] }
}

export type Analysis = {
  docs_read: string[]
  wrong_guesses: { what: string; evidence: string; fix: string }[]
  detours: { what: string; evidence: string }[]
  stumbles: { summary: string; area: 'skill' | 'docs' | 'sdk' | 'cli' | 'ego' | 'daemon' | 'eval-setup' | 'other'; cost: 'minor' | 'major' | 'fatal'; fix: string }[]
  outcome: string
}

const HELP = `The shipped help an agent extending Superego has:
- The superego skill: SKILL.md in its skills folder (listed in its system prompt), printed too by \`superego --skill\`; topics by \`superego --skill <topic>\`: cli, profiles, tools, daemon, ui, bundled, debugging.
- docs/writing-extensions.md (linked from the skill as a local file in this setup) and docs/examples/ (build-queue, build-queue-ui).
- The CLI: \`superego help\`, \`superego extension new|test|reload\`, \`superego profile new|types|allow\`, \`superego actions\`, \`superego do\`.
- The SDK's types: a profile's node_modules linked to ~/.superego/types (declarations of 'superego', 'superego/ui', 'superego/testing').
Anything else (reading the app's bundled JavaScript in out/main or out/renderer, guessing at paths, web searches, the GitHub repository) is a detour outside the help.`

export async function analyzeRun({ request, route, transcript, pass, checks, notes = [] }: { request: string; route: string; transcript: string; pass: boolean; checks: Record<string, boolean>; notes?: string[] }): Promise<{ analysis?: Analysis; cost: number; error?: string }> {
  const prompt = `${HELP}

An agent was asked to extend Superego for a user. Route: ${route === 'ego' ? "the user asked Ego (Superego's own agent, which reads and explains and hands building work to an ordinary thread it starts)" : 'the user asked an ordinary thread directly'}. The user's request: "${request}".
Acceptance afterwards: ${pass ? 'PASSED' : 'FAILED'} (${Object.entries(checks).map(([k, v]) => `${k}=${v}`).join(', ')}). What it found:
${notes.map((n) => `- ${n.slice(0, 600)}`).join('\n')}

Read the transcript below (every thread of the run; tool results are cut) and report where the agent got lost, as JSON only, no prose around it:
{
  "docs_read": ["each piece of shipped help it read, in order: e.g. 'superego --skill', 'superego --skill ui', 'docs/writing-extensions.md', 'docs/examples/build-queue-ui', 'superego extension new --help', 'types: superego/ui index.d.ts'"],
  "wrong_guesses": [{"what": "a wrong belief about Superego's API, CLI or behaviour it acted on (an import that doesn't exist, a wrong hook signature, a wrong path or command)", "evidence": "the call or error that shows it, briefly", "fix": "the concrete change to the skill, docs, SDK or CLI that would have prevented it"}],
  "detours": [{"what": "time spent outside the shipped help: reading the app's bundled code, searching the web, guessing, probing the sandbox", "evidence": "briefly"}],
  "stumbles": [{"summary": "one line, specific: what went wrong or was slow", "area": "skill|docs|sdk|cli|ego|daemon|eval-setup|other", "cost": "minor|major|fatal", "fix": "a concrete change to the docs, skill, SDK or CLI (name the file or command)"}],
  "outcome": "two sentences: what it built and where, and why it passed or failed"
}
Be specific and only report what the transcript shows. Mark as eval-setup anything caused by the test setup itself (a sandbox denial, no window open, an isolated home), not by Superego.

<transcript>
${transcript}
</transcript>`
  try {
    const { text, cost } = await claude(prompt, 6000)
    const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
    return { analysis: JSON.parse(json), cost }
  } catch (error) {
    return { cost: 0, error: (error as Error).message }
  }
}

export type Rollup = { items: { summary: string; area: string; runs: number; ofRuns: string[]; fatal: number; fix: string }[]; cost: number; error?: string }

export async function rollUp(runs: { runId: string; task: string; route: string; model: string; pass: boolean; analysis?: Analysis }[]): Promise<Rollup> {
  const input = runs.filter((r) => r.analysis).map((r) => ({ run: r.runId, task: r.task, route: r.route, model: r.model, pass: r.pass, stumbles: r.analysis!.stumbles, wrong_guesses: r.analysis!.wrong_guesses, detours: r.analysis!.detours }))
  const prompt = `${HELP}

Below are per-run reports of where agents got lost extending Superego. Merge the stumbles, wrong guesses and detours across runs into distinct problems (the same underlying problem counts once per run), and rank them by how many runs hit them (fatal ones first among equals). For each, give the most concrete fix (a change to a named skill topic, doc, SDK export or CLI command). Leave out anything area "eval-setup" unless it changed outcomes. JSON only:
{"items": [{"summary": "...", "area": "skill|docs|sdk|cli|ego|daemon|eval-setup|other", "runs": <number of runs>, "ofRuns": ["run ids"], "fatal": <runs where it was fatal>, "fix": "..."}]}

${JSON.stringify(input, null, 1)}`
  try {
    const { text, cost } = await claude(prompt, 12000)
    return { ...JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), cost }
  } catch (error) {
    return { items: [], cost: 0, error: (error as Error).message }
  }
}

/** One request to Anthropic's API (the analysis model), and what it cost. */
export const ANALYSIS_MODEL = 'claude-opus-5-5'
const PRICE = { input: 4, output: 20 } // $ per million tokens

async function claude(prompt: string, maxTokens: number): Promise<{ text: string; cost: number }> {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set')
  // The answer as a tool's input, so it comes back as valid JSON.
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: ANALYSIS_MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: `${prompt}\n\nGive it by calling the report tool, with the JSON as its input.` }],
      tools: [{ name: 'report', description: 'Give the JSON asked for.', input_schema: { type: 'object', additionalProperties: true } }],
    }),
    signal: AbortSignal.timeout(300_000),
  })
  const body = await response.json() as any
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body).slice(0, 300)}`)
  const cost = (body.usage.input_tokens * PRICE.input + body.usage.output_tokens * PRICE.output) / 1e6
  const input = body.content.find((b: any) => b.type === 'tool_use')?.input
  return { text: input ? JSON.stringify(input) : body.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(''), cost }
}
