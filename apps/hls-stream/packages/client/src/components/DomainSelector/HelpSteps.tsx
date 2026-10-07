import type { Help } from './checkSentences';

/** The steps of a fix that takes more than one sentence, with any text to copy set apart as code. */
export function HelpSteps({ help }: { help: Help }) {
  return (
    <div className="gateway-help">
      <p>{help.intro}</p>
      <ul className="gateway-help-steps">
        {help.steps.map((step) => (
          <li key={step.label}>
            <span className="gateway-help-label">{step.label}</span>{' '}
            {step.code !== undefined && <code className="gateway-help-code">{step.code}</code>}
            {step.text}
          </li>
        ))}
      </ul>
      <p>{help.note}</p>
    </div>
  );
}
