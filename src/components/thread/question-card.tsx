/*
 * QuestionCard — interactive wizard for a running ask_user tool call.
 *
 * Business logic:
 * - shown only while the call runs; once answered it settles into a
 *   plain ToolCallView in the message body.
 * - args are parsed defensively: max 3 questions, max 3 options each;
 *   an option list is dropped unless ≥2 valid entries remain (free
 *   text only); allow_other defaults true (per question, falling back
 *   to the top level); timeout defaults to 2 min; unparseable args
 *   render "(invalid question)".
 * - one question per step with progress segments and Back/Next; the
 *   first option is badged "Recommended".
 * - picking an option clears the typed answer and vice versa; typed
 *   answers count only when allow_other.
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
};
type ParsedAskUser = {
  questions: ParsedQuestion[];
  timeout_ms: number;
};

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
      questions.push({ id, header, question, options, allow_other });
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

  const selectOption = (qId: string, label: string) => {
    setAnswers((prev) => ({ ...prev, [qId]: label }));
    setTexts((prev) => ({ ...prev, [qId]: '' }));
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
      className="m-0 flex min-w-0 flex-col gap-3 rounded-[6px] border border-[var(--border-strong)] bg-[var(--panel)] p-3 text-[13px]"
      aria-label="questions from the assistant"
      disabled={sending || timedOut}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 font-medium">
          <I n="help" s={12} className="shrink-0 muted" />
          <span>Clarification needed</span>
        </div>
        <div className="flex items-center gap-2">
          {questions.length > 1 && (
            <span className="num text-[11px] muted">
              {currentStep + 1}/{questions.length}
            </span>
          )}
          {!timedOut && (
            <span className="num text-[11px] muted">
              {formatCountdown(remaining)}
            </span>
          )}
          {timedOut && (
            <span className="num text-[11px] text-[var(--danger)]">
              timed out
            </span>
          )}
        </div>
      </div>

      {questions.length > 1 && (
        <div className="flex gap-1">
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
        <p className="m-0 whitespace-pre-wrap">{q.question}</p>

        {q.options.length > 0 && (
          <div className="flex flex-col gap-1">
            {q.options.map((o, oi) => {
              const selected = answers[q.id] === o.label;
              return (
                <button
                  key={o.label}
                  type="button"
                  className={`flex flex-col gap-0.5 rounded-[5px] border px-2.5 py-1.5 text-left transition-colors ${
                    selected
                      ? 'border-[var(--accent)] bg-[var(--accent)]/10'
                      : 'border-[var(--border)] hover:bg-[var(--sunken)]'
                  }`}
                  disabled={sending || timedOut}
                  onClick={() => selectOption(q.id, o.label)}
                >
                  <span className="flex items-center gap-1.5 text-[13px]">
                    {oi === 0 && (
                      <span className="rounded bg-[var(--accent)]/15 px-1 text-[10px] font-medium text-[var(--accent)]">
                        Recommended
                      </span>
                    )}
                    <span>{o.label}</span>
                  </span>
                  {o.description && (
                    <span className="text-[11px] muted">{o.description}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {q.allow_other && (
          <input
            className="h-7 min-w-0 rounded-[6px] border border-[var(--border)] bg-[var(--sunken)] px-2 text-[13px] outline-none focus:border-[var(--accent)]"
            placeholder={
              q.options.length > 0
                ? 'Or type your own answer…'
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

      <div className="flex items-center gap-2">
        {currentStep > 0 && (
          <button
            type="button"
            className="ctl-icon h-7 rounded-[6px] px-3 text-[12px]"
            disabled={sending || timedOut}
            onClick={handleBack}
          >
            Back
          </button>
        )}
        <button
          type="button"
          className="ctl-primary h-7 rounded-[6px] px-4 text-[12px]"
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
