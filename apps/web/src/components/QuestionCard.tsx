import { useState } from "react";
import { Check, MessageCircleQuestion } from "lucide-react";
import type { QuestionAnswer, QuestionGroupState } from "../types";

const reasonLabels: Record<string, string> = {
  dismissed: "The user dismissed the question",
  user_prompt: "The user sent a new message instead",
  aborted: "The run was stopped",
  superseded: "Replaced by a newer question",
  deleted: "The session was deleted",
  rollback: "The conversation was rolled back",
};

interface Draft {
  selected: string[];
  custom: string;
}

export function QuestionCard({ group, busy, onSubmit, onDismiss }: { group: QuestionGroupState; busy: boolean; onSubmit: (answers: QuestionAnswer[]) => void; onDismiss: () => void }) {
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const pending = group.status === "pending";
  const draftFor = (index: number): Draft => drafts[index] || { selected: [], custom: "" };
  const update = (index: number, patch: Partial<Draft>) => setDrafts((current) => ({ ...current, [index]: { ...draftFor(index), ...patch } }));
  const toggle = (index: number, label: string, multiSelect: boolean) => {
    const draft = draftFor(index);
    if (multiSelect) update(index, { selected: draft.selected.includes(label) ? draft.selected.filter((item) => item !== label) : [...draft.selected, label] });
    else update(index, { selected: draft.selected.includes(label) ? [] : [label] });
  };
  const answers: QuestionAnswer[] = group.questions.map((question, index) => ({ index, selected: draftFor(index).selected, custom: question.allowCustom ? draftFor(index).custom.trim() : "" }));
  const canSubmit = answers.some((answer) => answer.selected.length > 0 || answer.custom);
  const stateLabel = group.status === "pending" ? "Waiting" : group.status === "answered" ? "Answered" : "Unanswered";
  return <article className={`question-card ${group.status}`} data-question-tool-call={group.toolCallId}>
    <header className="question-card-header">
      <span className="question-card-icon"><MessageCircleQuestion size={15} /></span>
      <div className="question-card-title"><strong>{group.token ? `${group.token} · Question` : "Question"}</strong><span>{group.mode === "background" ? "Answer when you have time" : "Answer to continue"}</span></div>
      <span className={`question-card-state ${group.status}`}>{stateLabel}</span>
    </header>
    {pending ? <div className="question-body">{group.questions.map((question, index) => {
      const draft = draftFor(index);
      return <section className="question-item" key={index}>
        {question.header && <h4>{question.header}</h4>}
        <p>{question.question}</p>
        <div className="question-options" role="group" aria-label={question.header || question.question}>
          {question.options.map((option) => {
            const selected = draft.selected.includes(option.label);
            return <button type="button" className={`question-option ${selected ? "selected" : ""}`} aria-pressed={selected} disabled={busy} onClick={() => toggle(index, option.label, question.multiSelect)} key={option.label}>
              <span className="question-option-mark">{selected && <Check size={11} />}</span>
              <span className="question-option-copy"><strong>{option.label}</strong>{option.description && <small>{option.description}</small>}</span>
            </button>;
          })}
        </div>
        {question.allowCustom && <label className="question-custom"><input value={draft.custom} placeholder="Add your own answer" disabled={busy} onChange={(event) => update(index, { custom: event.target.value })} /></label>}
      </section>;
    })}</div> : <div className="question-body settled">{group.questions.map((question, index) => {
      const answer = group.answers.find((item) => item.index === index);
      const parts = [...(answer?.selected || [])];
      if (answer?.custom) parts.push(answer.custom);
      return <section className="question-item settled" key={index}>
        {question.header && <h4>{question.header}</h4>}
        <p>{question.question}</p>
        <div className="question-answer-text">{group.status === "unanswered" ? reasonLabels[group.reason || ""] || reasonLabels.dismissed : parts.length ? parts.join(" · ") : "No option selected"}</div>
      </section>;
    })}</div>}
    {pending && <div className="question-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={onDismiss}>Unanswered</button>
      <button type="button" className="primary-button" disabled={busy || !canSubmit} onClick={() => onSubmit(answers)}>{busy ? "Sending" : "Submit answers"}</button>
    </div>}
  </article>;
}
