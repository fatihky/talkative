/*
 * QuestionCard — interactive wizard for a running ask_user tool call,
 * styled as the clean-layout handoff's `.question-card`.
 *
 * Business logic:
 * - shown only while the call runs; once answered it settles into a
 *   plain ToolCallView in the message body.
 * - args are parsed defensively: max 3 questions, max 3 options each;
 *   an option list is dropped unless ≥2 valid entries remain (free
 *   text only); allow_other defaults true (per question, falling back
 *   to the top level); timeout defaults to 2 min; unparseable args
 *   render "(invalid question)".
 * - one question per step; the first option is badged "Recommended".
 * - picking an option clears the typed answer and vice versa; typed
 *   answers count only when allow_other. on a multi_select question
 *   (per question, falling back to the top level) options toggle and
 *   several may stay picked; the answer is their labels joined by ", "
 *   in the option order, and typing still overrides the picks.
 * - a countdown from timeout_ms disables the whole card at zero
 *   ("timed out") — answers must land before the run gives up waiting.
 * - submit sends every answer in one answerToolCall; a failure returns
 *   the card editable with the error inline, and the sending flag
 *   blocks double submits.
 */
'use client';

import { useState } from 'react';
import { answerToolCall } from '../../lib/api';
import { I } from '../../lib/icons';
import type { ToolCall } from '../../types';

type ParsedOption = { label: string; description: string };
type ParsedQuestion = {
  id: string;
  header: string;
  question: string;
  options: ParsedOption[];
  allow_other: boolean;
  multi_select: boolean;
};
type ParsedAskUser = {
  questions: ParsedQuestion[];
  timeout_ms: number;
};

/* how many picks a multi_select question accepts */
const MAX_PICKS = 3;

const parseAskUserArgs = (raw: string): ParsedAskUser => {
  try {
    const v = JSON.parse(raw || '{}') as Record<string, unknown>;
    const rawQs = Array.isArray(v.questions) ? v.questions : [];
    const questions: ParsedQuestion[] = [];
    for (let i = 0; i < Math.min(rawQs.length, 3); i++) {
      const q = rawQs[i] as Record<string, unknown> | undefined;
      if (!q || typeof q !== 'object') continue;
      const question = typeof q.question === 'string' ? q.question : '';
      if (!question.trim()) continue;
      const id = typeof q.id === 'string' ? q.id : `q${i + 1}`;
      const header =
        typeof q.header === 'string' && q.header.trim()
          ? q.header
          : `Question ${i + 1}`;
      const allow_other =
        typeof q.allow_other === 'boolean'
          ? q.allow_other
          : typeof v.allow_other === 'boolean'
            ? v.allow_other
            : true;
      const multi_select =
        typeof q.multi_select === 'boolean'
          ? q.multi_select
          : typeof v.multi_select === 'boolean'
            ? v.multi_select
            : false;
      let options: ParsedOption[] = [];
      if (Array.isArray(q.options)) {
        for (const o of q.options) {
          if (typeof o === 'string') {
            options.push({ label: o, description: '' });
          } else if (o && typeof o === 'object') {
            const opt = o as Record<string, unknown>;
            const label = typeof opt.label === 'string' ? opt.label : '';
            if (!label.trim()) continue;
            options.push({
              label,
              description:
                typeof opt.description === 'string' ? opt.description : '',
            });
          }
          if (options.length >= 3) break;
        }
      }
      if (options.length < 2) options = [];
      questions.push({
        id,
        header,
        question,
        options,
        allow_other,
        multi_select,
      });
    }
    const timeout_ms =
      typeof v.timeout_ms === 'number' && Number.isFinite(v.timeout_ms)
        ? v.timeout_ms
        : 120_000;
    return { questions, timeout_ms };
  } catch {
    return { questions: [], timeout_ms: 120_000 };
  }
};

/* countdown hook; ticks every second while active */
const useCountdown = (ms: number, active: boolean) => {
  const [remaining, setRemaining] = useState(ms);
  useState(() => {
    /* sync on mount only */
    if (active) setRemaining(ms);
  });
  useState(() => {
    if (!active) return;
    const t0 = Date.now();
    const id = setInterval(() => {
      const elapsed = Date.now() - t0;
      const left = Math.max(0, ms - elapsed);
      setRemaining(left);
      if (left <= 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  });
  return remaining;
};

const formatCountdown = (ms: number) => {
  const s = Math.ceil(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${sec}s`;
};

/* a waiting ask_user call; once answered it settles into a plain ToolCallView */
export function QuestionCard({ msgId, c }: { msgId: string; c: ToolCall }) {
  const { questions, timeout_ms } = parseAskUserArgs(c.args);
  const [currentStep, setCurrentStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remaining = useCountdown(timeout_ms, true);

  /* the picked labels in option order, read off the joined answer string */
  const pickedLabels = (q: ParsedQuestion): string[] => {
    if (!q.multi_select) return [];
    const seen = answers[q.id];
    if (!seen) return [];
    return q.options
      .map((o) => o.label)
      .filter((l) => seen.split(', ').includes(l));
  };

  const toggleOption = (q: ParsedQuestion, label: string) => {
    const current = pickedLabels(q);
    const next = current.includes(label)
      ? current.filter((l) => l !== label)
      : [...current, label];
    setAnswers((prev) => {
      const out = { ...prev };
      /* replace whatever was stored (typed text clears picks) with the toggled set */
      if (next.length)
        out[q.id] = q.options
          .map((o) => o.label)
          .filter((l) => next.includes(l))
          .slice(0, MAX_PICKS)
          .join(', ');
      else delete out[q.id];
      return out;
    });
    setTexts((prev) => ({ ...prev, [q.id]: '' }));
  };

  const selectOption = (q: ParsedQuestion, label: string) => {
    if (q.multi_select) return toggleOption(q, label);
    setAnswers((prev) => ({ ...prev, [q.id]: label }));
    setTexts((prev) => ({ ...prev, [q.id]: '' }));
  };

  const canProceed = () => {
    const q = questions[currentStep];
    if (!q) return false;
    const picked = answers[q.id];
    const typed = texts[q.id]?.trim();
    return !!(picked || (q.allow_other && typed));
  };

  const handleNext = () => {
    const q = questions[currentStep];
    if (!q) return;
    const picked = answers[q.id];
    const typed = texts[q.id]?.trim();
    const val = picked || (q.allow_other ? typed : '');
    if (!val) {
      setError(`Please answer "${q.header}"`);
      return;
    }
    setError(null);
    if (currentStep < questions.length - 1) {
      setCurrentStep((prev) => prev + 1);
    } else {
      void submit();
    }
  };

  const handleBack = () => {
    if (currentStep > 0) {
      setError(null);
      setCurrentStep((prev) => prev - 1);
    }
  };

  const submit = async () => {
    const finalAnswers: Record<string, string> = {};
    for (const q of questions) {
      const picked = answers[q.id];
      const typed = texts[q.id]?.trim();
      const val = picked || (q.allow_other ? typed : '');
      if (!val) {
        setError(`Please answer "${q.header}"`);
        return;
      }
      finalAnswers[q.id] = val;
    }
    setSending(true);
    setError(null);
    try {
      await answerToolCall(msgId, c.id, finalAnswers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSending(false);
    }
  };

  if (questions.length === 0) {
    return (
      <div className="rounded-[6px] border border-[var(--border)] bg-[var(--panel)] px-2 py-1.5 text-[12px] muted">
        (invalid question)
      </div>
    );
  }

  const timedOut = remaining <= 0;
  /* safe: we returned above if empty, and currentStep is clamped by navigation */
  const q = questions[currentStep]!;
  const isLastStep = currentStep === questions.length - 1;

  return (
    <fieldset
      className="question-card disabled:opacity-60"
      aria-label="questions from the assistant"
      disabled={sending || timedOut}
    >
      <div className="flex items-center justify-between">
        <div className="q-head">
          <I n="help" s={13} />
          <span>PAUSED TO ASK</span>
          {questions.length > 1 && (
            <span className="num">
              · {currentStep + 1}/{questions.length}
            </span>
          )}
        </div>
        {!timedOut ? (
          <span className="pill w">{formatCountdown(remaining)}</span>
        ) : (
          <span className="pill d">timed out</span>
        )}
      </div>

      {questions.length > 1 && (
        <div className="mb-2 flex gap-1">
          {questions.map((q, i) => (
            <div
              key={q.id}
              className={`h-1 flex-1 rounded-full transition-colors ${
                i <= currentStep ? 'bg-[var(--accent)]' : 'bg-[var(--border)]'
              }`}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <div className="text-[11px] font-medium uppercase tracking-wide muted">
          {q.header}
        </div>
        <p className="m-0 whitespace-pre-wrap text-[14px] font-semibold">
          {q.question}
        </p>

        {q.options.length > 0 && (
          // biome-ignore lint/a11y/useAriaPropsSupportedByRole: group and radiogroup both take aria-label
          <div
            className="q-options"
            role={q.multi_select ? 'group' : 'radiogroup'}
            aria-label={q.header}
          >
            {q.options.map((o, oi) => {
              const selected = q.multi_select
                ? pickedLabels(q).includes(o.label)
                : answers[q.id] === o.label;
              /* a multi_select question stops taking picks at MAX_PICKS */
              const full =
                q.multi_select &&
                !selected &&
                pickedLabels(q).length >= MAX_PICKS;
              return (
                <button
                  key={o.label}
                  type="button"
                  className={selected ? 'chosen' : undefined}
                  aria-pressed={q.multi_select ? selected : undefined}
                  disabled={sending || timedOut || full}
                  onClick={() => selectOption(q, o.label)}
                  title={o.description || undefined}
                >
                  {oi === 0 && (
                    <span className="mr-1 rounded bg-[var(--accent)]/15 px-1 text-[10px] font-medium text-[var(--accent)]">
                      Recommended ·{' '}
                    </span>
                  )}
                  {o.label}
                </button>
              );
            })}
          </div>
        )}

        {q.multi_select && q.options.length > 0 && (
          <span className="num text-[10px] muted">
            select up to {MAX_PICKS}
            {pickedLabels(q).length > 0 &&
              ` · ${pickedLabels(q).length} picked`}
          </span>
        )}

        {q.allow_other && (
          <input
            className="mt-2 h-7 min-w-0 rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]"
            placeholder={
              q.options.length > 0
                ? q.multi_select
                  ? 'Or type a different answer…'
                  : 'Or type your own answer…'
                : 'Type your answer…'
            }
            value={texts[q.id] ?? ''}
            disabled={sending || timedOut}
            onChange={(e) => {
              setTexts((prev) => ({ ...prev, [q.id]: e.target.value }));
              /* clear any selected option when typing */
              setAnswers((prev) => {
                if (prev[q.id] === undefined) return prev;
                const next = { ...prev };
                delete next[q.id];
                return next;
              });
            }}
          />
        )}
      </div>

      <div className="mt-3 flex items-center gap-2">
        {currentStep > 0 && (
          <button
            type="button"
            className="ctl h-7 px-3 text-[12px]"
            disabled={sending || timedOut}
            onClick={handleBack}
          >
            Back
          </button>
        )}
        <button
          type="button"
          className="ctl-primary h-7 px-4 text-[12px]"
          disabled={sending || timedOut || !canProceed()}
          onClick={handleNext}
        >
          {sending ? 'Sending…' : isLastStep ? 'Submit' : 'Next'}
        </button>
        {error && (
          <span className="num text-[11px] text-[var(--danger)]">{error}</span>
        )}
      </div>
    </fieldset>
  );
}
