/*
 * decisions — the client-safe decision vocabulary shared by the /decisions
 * screens and the decisions store: the draft shape, question scaffolding,
 * validation and answer formatting.
 *
 * Business logic:
 * - DecisionDraft is the editor's working copy of one run and lives only on
 *   the client until it is evaluated: POST /api/decisions with its id stores
 *   it (and re-runs it when the id already exists), so an unrun draft has no
 *   row and survives a reload through localStorage instead.
 * - a question's `name` is the key its answer comes back under, so it is
 *   restricted to an identifier — DECISION_NAME_RE mirrors the server's rule
 *   in server/decisions.ts and decisionProblems() reports a breach before the
 *   request is sent rather than after a 400.
 * - newQuestion seeds what its type needs (two empty choices, two empty
 *   levels) and picks a name that isn't taken yet, so an added question is
 *   ready to fill in instead of failing validation on arrival.
 * - decisionProblems is the run gate: it lists every reason the draft can't
 *   be evaluated (no model, no input, missing instructions, fewer than two
 *   choices or levels, duplicate names or values) and the editor shows the
 *   first one on the Run button. The server re-checks all of it.
 * - the limits here are the server's, restated so the editor can enforce
 *   them while typing: 10 questions, 2–20 choices, 2–10 levels.
 * - answerValue/answerBar reduce one answer to what the list and the editor
 *   print: a percentage for a predicate, the chosen value for a choice, the
 *   weighted index for a score, and "Refused" when the model declined.
 */
import type {
  DecisionAnswer,
  DecisionQuestion,
  DecisionQuestionType,
} from '../types';

export const DECISION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export const MAX_DECISION_QUESTIONS = 10;
export const MIN_DECISION_CHOICES = 2;
export const MAX_DECISION_CHOICES = 20;
export const MIN_DECISION_LEVELS = 2;
export const MAX_DECISION_LEVELS = 10;

/** the editor's working copy of a run; `id` is client-minted until it is evaluated */
export type DecisionDraft = {
  id: string;
  modelId: string;
  title: string;
  input: string;
  questions: DecisionQuestion[];
};

export const QUESTION_TYPES: {
  type: DecisionQuestionType;
  label: string;
  hint: string;
}[] = [
  {
    type: 'predicate',
    label: 'predicate',
    hint: 'Returns the probability that a condition holds.',
  },
  {
    type: 'choice',
    label: 'choice',
    hint: 'Returns one of the values you list.',
  },
  {
    type: 'score',
    label: 'score',
    hint: 'Returns a weighted index across ordered levels.',
  },
];

const NAME_PREFIX: Record<DecisionQuestionType, string> = {
  predicate: 'check',
  choice: 'choice',
  score: 'score',
};

/** the first unused `<prefix>_n` for this question type */
export const nextQuestionName = (
  questions: DecisionQuestion[],
  type: DecisionQuestionType,
): string => {
  const prefix = NAME_PREFIX[type];
  for (let i = 1; ; i++) {
    const name = `${prefix}_${i}`;
    if (!questions.some((q) => q.name === name)) return name;
  }
};

/** a blank question of this type, seeded with the entries its shape requires */
export const newQuestion = (
  type: DecisionQuestionType,
  questions: DecisionQuestion[],
): DecisionQuestion => {
  const name = nextQuestionName(questions, type);
  if (type === 'choice')
    return {
      name,
      type,
      instructions: '',
      choices: [{ value: '' }, { value: '' }],
    };
  if (type === 'score')
    return {
      name,
      type,
      instructions: '',
      levels: [{ label: '' }, { label: '' }],
    };
  return { name, type, instructions: '' };
};

/** every reason this draft can't be evaluated yet; empty means it can */
export const decisionProblems = (d: DecisionDraft | null): string[] => {
  if (!d) return ['Nothing to run'];
  const out: string[] = [];
  if (!d.modelId) out.push('Pick a model');
  if (!d.input.trim()) out.push('Add the input to evaluate');
  if (d.questions.length === 0) out.push('Add at least one question');
  if (d.questions.length > MAX_DECISION_QUESTIONS)
    out.push(`At most ${MAX_DECISION_QUESTIONS} questions per run`);
  const names = new Set<string>();
  d.questions.forEach((q, i) => {
    const label = q.name || `Question ${i + 1}`;
    if (!DECISION_NAME_RE.test(q.name))
      out.push(`${label}: name needs letters, digits, "_" or "-"`);
    else if (names.has(q.name)) out.push(`${label}: name is used twice`);
    names.add(q.name);
    if (!q.instructions.trim()) out.push(`${label}: add instructions`);
    if (q.type === 'choice') {
      const values = (q.choices ?? []).map((c) => c.value.trim());
      if (values.some((v) => v === ''))
        out.push(`${label}: every choice needs a value`);
      else if (values.length < MIN_DECISION_CHOICES)
        out.push(`${label}: a choice needs ${MIN_DECISION_CHOICES} options`);
      else if (new Set(values).size !== values.length)
        out.push(`${label}: two choices share a value`);
      else if (values.length > MAX_DECISION_CHOICES)
        out.push(`${label}: at most ${MAX_DECISION_CHOICES} options`);
    }
    if (q.type === 'score') {
      const labels = (q.levels ?? []).map((l) => l.label.trim());
      if (labels.some((l) => l === ''))
        out.push(`${label}: every level needs a label`);
      else if (labels.length < MIN_DECISION_LEVELS)
        out.push(`${label}: a score needs ${MIN_DECISION_LEVELS} levels`);
      else if (labels.length > MAX_DECISION_LEVELS)
        out.push(`${label}: at most ${MAX_DECISION_LEVELS} levels`);
    }
  });
  return out;
};

/** a ready-to-run starting point shown on an empty /decisions list */
export type DecisionExample = {
  title: string;
  blurb: string;
  input: string;
  questions: DecisionQuestion[];
};

export const DECISION_EXAMPLES: DecisionExample[] = [
  {
    title: 'Triage a support ticket',
    blurb: 'Route one message and flag whether it is urgent.',
    input:
      'Hi — my card was charged twice for order #4421 and I can’t find any way to get a refund. Please fix this today.',
    questions: [
      {
        name: 'is_billing',
        type: 'predicate',
        instructions: 'Is this message about a payment or billing problem?',
        criteria: {
          true: 'A charge, refund, invoice or subscription issue.',
          false: 'Anything else — a bug, a question, a feature ask.',
        },
      },
      {
        name: 'category',
        type: 'choice',
        instructions: 'Which team should own this ticket?',
        choices: [
          { value: 'billing', description: 'Payments, refunds, invoices.' },
          { value: 'bug', description: 'Something is broken.' },
          { value: 'account', description: 'Login, access, profile.' },
          { value: 'feature', description: 'Asking for something new.' },
        ],
      },
      {
        name: 'urgency',
        type: 'score',
        instructions: 'How quickly must this be handled?',
        levels: [
          { label: 'Can wait', description: 'No deadline pressure.' },
          { label: 'Soon', description: 'Within a few days.' },
          { label: 'Today' },
          { label: 'ASAP', description: 'Blocked or at risk right now.' },
        ],
      },
    ],
  },
  {
    title: 'Read a product review',
    blurb: 'Pull a rating, a sentiment and the key complaint.',
    input:
      'Ordered this coffee grinder last month. Grind setting drifts between cups and the funnel is a pain to clean, but the motor is quiet and it looks great.',
    questions: [
      {
        name: 'recommends',
        type: 'predicate',
        instructions: 'Would the reviewer recommend this product to a friend?',
      },
      {
        name: 'star_rating',
        type: 'choice',
        instructions: 'Which star rating does the review imply?',
        choices: [
          { value: '1' },
          { value: '2' },
          { value: '3' },
          { value: '4' },
          { value: '5' },
        ],
      },
      {
        name: 'sentiment',
        type: 'score',
        instructions: 'Overall tone of the review.',
        levels: [
          { label: 'Very negative' },
          { label: 'Negative' },
          { label: 'Neutral' },
          { label: 'Positive' },
          { label: 'Very positive' },
        ],
      },
    ],
  },
  {
    title: 'Screen a pull request',
    blurb: 'Judge whether a change is ready to merge.',
    input:
      'Refactors the payment service into smaller modules and adds a retry wrapper for idempotency. Touches 14 files, no tests, and the retry wrapper swallows timeout errors.',
    questions: [
      {
        name: 'ready_to_merge',
        type: 'predicate',
        instructions: 'Is this change ready to merge as-is?',
        criteria: {
          true: 'Tested, focused, and safe to ship.',
          false: 'Missing tests, risky, or out of scope.',
        },
      },
      {
        name: 'review_effort',
        type: 'choice',
        instructions: 'How much review does it need?',
        choices: [
          { value: 'glance', description: 'Small and obviously correct.' },
          { value: 'normal' },
          { value: 'deep', description: 'Large diff or subtle behaviour.' },
          { value: 'blocker', description: 'Needs changes before review.' },
        ],
      },
    ],
  },
  {
    title: 'Moderate a comment',
    blurb: 'Flag abuse and pick a moderation action.',
    input:
      'I guess you and your shill army already cashed out. Total scam — everyone should know you bought those reviews.',
    questions: [
      {
        name: 'is_tos_violation',
        type: 'predicate',
        instructions: 'Does this comment break the community guidelines?',
        criteria: {
          true: 'Harassment, hate, spam, threats or personal attacks.',
          false: 'Within the rules, even if critical or disagreeing.',
        },
      },
      {
        name: 'action',
        type: 'choice',
        instructions: 'What should a moderator do?',
        choices: [
          { value: 'approve', description: 'Leave it visible.' },
          { value: 'warn', description: 'Show it but notify the author.' },
          { value: 'hide', description: 'Remove from public view.' },
          { value: 'suspend', description: 'Hide and suspend the account.' },
        ],
      },
      {
        name: 'severity',
        type: 'score',
        instructions: 'How severe is the violation?',
        levels: [
          { label: 'None' },
          { label: 'Mild' },
          { label: 'Moderate' },
          { label: 'Severe' },
          { label: 'Extreme', description: 'Immediate harm or threat.' },
        ],
      },
    ],
  },
  {
    title: 'Qualify a job application',
    blurb: 'Score a candidate against the role requirements.',
    input:
      'Five years at a fintech scale-up building Node services, led a team of four, and shipped a payments integration used by two million people. Comfortable in Go and Rust, but no formal management training.',
    questions: [
      {
        name: 'meets_requirements',
        type: 'predicate',
        instructions:
          'Does the candidate meet the stated requirements on paper?',
        criteria: {
          true: 'Has the required skills and experience.',
          false: 'Missing a stated must-have.',
        },
      },
      {
        name: 'seniority',
        type: 'choice',
        instructions: 'Which level should they be interviewed at?',
        choices: [
          { value: 'junior' },
          { value: 'mid' },
          { value: 'senior' },
          { value: 'staff', description: 'Technical lead or architect.' },
        ],
      },
      {
        name: 'role_fit',
        type: 'score',
        instructions: 'How well does the candidate fit the role overall?',
        levels: [
          { label: 'Not a fit' },
          { label: 'Weak fit' },
          { label: 'Reasonable' },
          { label: 'Strong' },
          { label: 'Outstanding' },
        ],
      },
    ],
  },
  {
    title: 'Classify a headline',
    blurb: 'Tag a news headline and check for clickbait.',
    input:
      '“You won’t believe what this city banned next — residents are furious!”',
    questions: [
      {
        name: 'is_clickbait',
        type: 'predicate',
        instructions:
          'Is the headline clickbait, withholding the key fact to draw clicks?',
      },
      {
        name: 'section',
        type: 'choice',
        instructions: 'Which section does this belong in?',
        choices: [
          { value: 'politics' },
          { value: 'business', description: 'Markets, companies, money.' },
          { value: 'science', description: 'Research and discoveries.' },
          { value: 'culture', description: 'Arts, media, lifestyle.' },
          { value: 'other' },
        ],
      },
    ],
  },
  {
    title: 'Triage a bug report',
    blurb: 'Confirm it is a real bug, pick the owner, gauge severity.',
    input:
      'Steps to reproduce: open the export dialog, pick CSV, click Export with the date filter on. Progress bar reaches 100% but no file downloads; console shows “ERR_BLOCKED_BY_CLIENT” on /api/export. Happens on Chrome 128, fine in Safari. Free plan, if that matters.',
    questions: [
      {
        name: 'is_bug',
        type: 'predicate',
        instructions: 'Is this a reproducible defect in the product?',
        criteria: {
          true: 'A user-visible behaviour that should not happen, with steps to trigger it.',
          false:
            'Expected behaviour, a question, or a request for something new.',
        },
      },
      {
        name: 'area',
        type: 'choice',
        instructions: 'Which component should own the investigation?',
        choices: [
          {
            value: 'frontend',
            description: 'UI, dialogs, browser-side downloads.',
          },
          { value: 'backend', description: 'APIs, jobs, data.' },
          {
            value: 'integration',
            description: 'Auth, billing, third-party hooks.',
          },
          { value: 'unknown', description: 'Not enough signal to say.' },
        ],
      },
      {
        name: 'severity',
        type: 'score',
        instructions: 'How badly does this affect users?',
        levels: [
          { label: 'Trivial' },
          { label: 'Minor', description: 'Annoying but workaroundable.' },
          {
            label: 'Major',
            description: 'A key flow is broken for some users.',
          },
          {
            label: 'Critical',
            description: 'Data loss or a blocked core flow.',
          },
        ],
      },
    ],
  },
  {
    title: 'Extract actions from meeting notes',
    blurb: 'Spot the open loops and the most useful follow-up.',
    input:
      'Sync notes — 12 Aug. Marketing wants the launch email out before the pricing page flips; needs final numbers from Finance by Thursday. We agreed to ship the waitlist without SMS verification and revisit in Q4. Dave took the migration write-up; nobody owns the pricing copy yet.',
    questions: [
      {
        name: 'has_open_loops',
        type: 'predicate',
        instructions: 'Does anything in the notes lack an owner or a deadline?',
      },
      {
        name: 'next_action',
        type: 'choice',
        instructions: 'What is the most useful follow-up for these notes?',
        choices: [
          { value: 'assign', description: 'Name owners for the open items.' },
          { value: 'schedule', description: 'Book the next check-in.' },
          {
            value: 'decide',
            description: 'A decision was deferred and needs closing.',
          },
          { value: 'none', description: 'Everything is already settled.' },
        ],
      },
      {
        name: 'deadline_pressure',
        type: 'score',
        instructions: 'How tight are the dates mentioned in the notes?',
        levels: [
          { label: 'No dates' },
          { label: 'Relaxed', description: 'Weeks of slack.' },
          { label: 'This week' },
          { label: 'Overdue', description: 'Something is already late.' },
        ],
      },
    ],
  },
  {
    title: 'Qualify an inbound lead',
    blurb: 'Decide if the lead is worth a call and who takes it.',
    input:
      'Inbound from the contact form: “We’re a 40-person logistics company evaluating tools for route planning. Budget approved for next quarter, around 15k. Our ops team is drowning in spreadsheets and the trial import keeps failing on our CSVs — can someone walk us through it this week?”',
    questions: [
      {
        name: 'is_qualified',
        type: 'predicate',
        instructions: 'Does this lead meet the qualification bar?',
        criteria: {
          true: 'Right size and use case, with budget and a timeline.',
          false: 'Too small, no budget, or just browsing.',
        },
      },
      {
        name: 'owner',
        type: 'choice',
        instructions: 'Who should follow up?',
        choices: [
          { value: 'sales_rep' },
          {
            value: 'sales_engineer',
            description: 'Needs a technical walkthrough.',
          },
          { value: 'support', description: 'It is really a help request.' },
          {
            value: 'nurture',
            description: 'Not ready; send to the drip campaign.',
          },
        ],
      },
      {
        name: 'deal_size',
        type: 'score',
        instructions: 'How large does this deal look?',
        levels: [
          { label: 'Small' },
          { label: 'Medium' },
          { label: 'Large' },
          { label: 'Enterprise' },
        ],
      },
    ],
  },
  {
    title: 'Grade a short answer',
    blurb: 'Check correctness, pick a grade, rate the explanation.',
    input:
      'Question: “Why does ice float on water?” — Answer: “Ice floats because when water freezes it expands and becomes less dense than liquid water, so it displaces its own weight and stays on top, which is also why lakes freeze from the surface down and fish survive underneath.”',
    questions: [
      {
        name: 'is_correct',
        type: 'predicate',
        instructions: 'Is the science in the answer correct?',
      },
      {
        name: 'grade',
        type: 'choice',
        instructions: 'Which grade does this answer deserve?',
        choices: [
          { value: 'A' },
          { value: 'B' },
          { value: 'C' },
          { value: 'D' },
          { value: 'F', description: 'Wrong or off-topic.' },
        ],
      },
      {
        name: 'explanation_quality',
        type: 'score',
        instructions: 'How well is the answer explained?',
        levels: [
          { label: 'Confused' },
          { label: 'Partial', description: 'Right idea, gaps in reasoning.' },
          { label: 'Clear' },
          {
            label: 'Exemplary',
            description: 'Correct, complete and well argued.',
          },
        ],
      },
    ],
  },
  {
    title: 'Screen a transaction for fraud',
    blurb: 'Flag the charge, pick an action, rate the risk.',
    input:
      'Card ending 4482, $2,300 of electronics at 3:12 AM, shipping to an address added 20 minutes ago. The account was created 6 months ago with steady grocery purchases; the velocity check shows 4 declined attempts on other cards in the last hour.',
    questions: [
      {
        name: 'is_suspicious',
        type: 'predicate',
        instructions: 'Does this transaction show signs of fraud?',
        criteria: {
          true: 'Unusual amount, timing or destination for this account.',
          false: 'Consistent with the account’s history.',
        },
      },
      {
        name: 'action',
        type: 'choice',
        instructions: 'What should happen to the transaction?',
        choices: [
          { value: 'approve' },
          { value: 'review', description: 'Hold for a human to check.' },
          { value: 'challenge', description: 'Ask the customer to verify.' },
          { value: 'block', description: 'Decline and secure the account.' },
        ],
      },
      {
        name: 'risk',
        type: 'score',
        instructions: 'How risky is this transaction overall?',
        levels: [
          { label: 'Safe' },
          { label: 'Low' },
          { label: 'Elevated' },
          { label: 'High', description: 'Fraud is more likely than not.' },
        ],
      },
    ],
  },
  {
    title: 'Prioritize a feature request',
    blurb: 'Weigh revenue impact and find its roadmap bucket.',
    input:
      'Request from a 200-seat team: shared read-only links for reports, so finance can see the weekly numbers without buying 12 extra seats. They say it is blocking their renewal decision next quarter, and two competitors already offer it.',
    questions: [
      {
        name: 'is_revenue_blocking',
        type: 'predicate',
        instructions: 'Is this request blocking a renewal or a deal?',
      },
      {
        name: 'bucket',
        type: 'choice',
        instructions: 'Where should this land on the roadmap?',
        choices: [
          { value: 'now', description: 'Slot into the current cycle.' },
          { value: 'next', description: 'Plan it for the upcoming quarter.' },
          { value: 'backlog', description: 'Track it, no commitment yet.' },
          { value: 'decline', description: 'Not something we will build.' },
        ],
      },
      {
        name: 'customer_impact',
        type: 'score',
        instructions: 'How much would this help the customers asking?',
        levels: [
          { label: 'Nice to have' },
          { label: 'Helpful' },
          { label: 'Saves real work' },
          {
            label: 'Unblocks them',
            description: 'They cannot proceed without it.',
          },
        ],
      },
    ],
  },
];

/** 0.9234 → "92%" */
export const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** the answer's headline: a probability, the chosen value, a score, or "Refused" */
export const answerValue = (a: DecisionAnswer): string => {
  if (a.type === 'refusal') return 'Refused';
  if (a.type === 'predicate')
    return a.probability === undefined ? '—' : pct(a.probability);
  if (a.type === 'choice') return a.choice ?? '—';
  return a.score === undefined ? '—' : a.score.toFixed(2);
};

/** what to draw as the answer's bar: its own probability, else its confidence */
export const answerBar = (a: DecisionAnswer): number | null => {
  if (a.type === 'refusal') return null;
  if (a.type === 'predicate') return a.probability ?? null;
  if (a.confidence !== undefined) return a.confidence;
  const best = (a.probabilities ?? []).reduce(
    (max, p) => Math.max(max, p.probability),
    0,
  );
  return best > 0 ? best : null;
};

/** a score answer's level labels, from its legend or from the question that asked it */
export const levelLabels = (
  a: DecisionAnswer,
  q: DecisionQuestion | undefined,
): Record<string, string> => {
  const fromLegend = a.legend ?? {};
  const fromQuestion = Object.fromEntries(
    (q?.levels ?? []).map((l, i) => [String(i), l.label]),
  );
  return { ...fromQuestion, ...fromLegend };
};
