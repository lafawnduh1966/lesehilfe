// Custom pi tools: read-only access to the PR's diff (computed locally against the
// merge base, since GitHub won't serve large diffs), and a structured way for the
// agent to hand back its user-flow overview.
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { getPRState, prGit } from './repo.js';

const MAX_LIST = 400;
const MAX_DIFF_CHARS = 40_000;

const text = (t) => ({ content: [{ type: 'text', text: t }], details: {} });

function range(worktree) {
  const state = getPRState(worktree);
  if (!state?.baseSha) throw new Error('The PR diff is not available (base branch unknown).');
  return [state.baseSha, state.sha];
}

export function diffTools(worktree) {
  const changedFiles = defineTool({
    name: 'pr_changed_files',
    label: 'PR changed files',
    description:
      'List the files this pull request changes (status A/M/D/R, lines added/removed), optionally under a path prefix. Use it to see the shape of the PR before reading code.',
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: 'Only list files under this repo-relative path, e.g. "packages/app"' })),
    }),
    async execute(_id, { path }) {
      const [base, head] = range(worktree);
      const scope = path ? ['--', path] : [];
      const [numstat, status] = await Promise.all([
        prGit(worktree, ['diff', '--numstat', '-M', base, head, ...scope]),
        prGit(worktree, ['diff', '--name-status', '-M', base, head, ...scope]),
      ]);
      const counts = numstat.split('\n').filter(Boolean).map((l) => l.split('\t'));
      const rows = status.split('\n').filter(Boolean).map((line, i) => {
        const [st, ...names] = line.split('\t');
        const [add = '?', del = '?'] = counts[i] || [];
        return `${st[0]} +${add} -${del}\t${names.join(' → ')}`;
      });
      const shown = rows.slice(0, MAX_LIST);
      const more = rows.length > shown.length ? `\n… ${rows.length - shown.length} more (narrow with path)` : '';
      return text(`${rows.length} changed files${path ? ` under ${path}` : ''}:\n${shown.join('\n')}${more}`);
    },
  });

  const diff = defineTool({
    name: 'pr_diff',
    label: 'PR diff',
    description:
      'Show what this pull request changed in a file or directory (unified diff against the base branch). Long diffs are paginated with offset.',
    parameters: Type.Object({
      path: Type.String({ description: 'Repo-relative file or directory path' }),
      offset: Type.Optional(Type.Number({ description: 'Character offset to continue a long diff' })),
    }),
    async execute(_id, { path, offset = 0 }) {
      const [base, head] = range(worktree);
      const out = await prGit(worktree, ['diff', '-M', '--unified=3', base, head, '--', path]);
      if (!out) return text(`No changes in ${path}.`);
      const page = out.slice(offset, offset + MAX_DIFF_CHARS);
      const next = offset + page.length < out.length ? `\n\n[truncated — continue with offset ${offset + page.length} of ${out.length}]` : '';
      return text(page + next);
    },
  });

  return [changedFiles, diff];
}

const Step = Type.Object({
  title: Type.String({ description: 'What happens in this step, in a few words' }),
  explanation: Type.String({ description: '1–3 sentences: what the code does here and why it matters for the flow' }),
  file: Type.String({ description: 'Repo-relative path of the most relevant code' }),
  startLine: Type.Number({ description: 'First relevant line in the PR head version of the file' }),
  endLine: Type.Number({ description: 'Last relevant line' }),
  layer: Type.Union(['ui', 'api', 'backend', 'contract', 'infra', 'other'].map((l) => Type.Literal(l))),
});

const Flow = Type.Object({
  title: Type.String({ description: 'Short name, e.g. "Mint emUSD with leverage via Morpho"' }),
  actor: Type.Union(['user', 'operator', 'admin', 'system'].map((a) => Type.Literal(a)), {
    description: 'user = end user/counterparty/integrator; operator = runs the system day to day; admin = configuration/governance; system = automated jobs',
  }),
  change: Type.Union(['new', 'changed', 'removed'].map((c) => Type.Literal(c))),
  summary: Type.String({ description: '2–4 sentences: what the actor can do and how it works end to end' }),
  preconditions: Type.Optional(Type.String({ description: 'What must be true or set up before this flow can run' })),
  steps: Type.Array(Step, { description: 'The path through the code, in execution order' }),
});

export const OverviewSchema = Type.Object({
  summary: Type.String({ description: 'The core change of the PR in 2–4 sentences' }),
  flows: Type.Array(Flow),
  openQuestions: Type.Optional(Type.Array(Type.String(), { description: 'Things a reviewer should clarify with the author' })),
});

/** Tool the agent calls once with the sub-stops of a tour stop; `onReport` receives them. */
export function reportStopsTool(onReport) {
  return defineTool({
    name: 'report_stops',
    label: 'Report tour stops',
    description: 'Submit the sub-stops for the tour stop you were asked to go deeper into. Call exactly once, at the end.',
    parameters: Type.Object({ stops: Type.Array(Step, { minItems: 2, maxItems: 8 }) }),
    async execute(_id, { stops }) {
      onReport(stops);
      return text(`Saved ${stops.length} stops.`);
    },
  });
}

/** Tool the agent calls once with its finished overview; `onReport` receives the data. */
export function reportFlowsTool(onReport) {
  return defineTool({
    name: 'report_flows',
    label: 'Report user flows',
    description: 'Submit the finished user-flow overview of this pull request. Call exactly once, at the end.',
    parameters: OverviewSchema,
    async execute(_id, overview) {
      onReport(overview);
      return text(`Saved ${overview.flows.length} flows.`);
    },
  });
}
