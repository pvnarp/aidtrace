"use client";
import { useState } from "react";

const steps = [
  { name: "1. Receipt", actor: "Maria", heading: "A person enters the expense.", text: "Maria paid $6: a $3 science kit, a $2 notebook and $1 of refreshments. She enters the amounts and receipt text. Nothing is approved or paid.", path: ["browser", "app", "db"], input: "Receipt text and person-entered amounts", output: "An unpaid draft", boundary: "The browser cannot post a journal or pay a claim." },
  { name: "2. AI suggestion", actor: "Local model", heading: "AI suggests categories. It cannot spend.", text: "The app asks the local model to suggest a category for each line and quote the receipt. The app validates the response. Maria must check and confirm every category; a matching quote alone does not prove a category is right.", path: ["app", "model", "app", "db"], input: "Saved receipt text", output: "Suggestions for human review", boundary: "The model has no PayPal tools, approval authority or ledger access." },
  { name: "3. Funding rules", actor: "Policy engine", heading: "Approved rules decide what each fund may cover.", text: "Illustrative split: $5 from an eligible education fund, $1 from General. Categories, program, date, balances and shared caps constrain the result. Maria reviews the split and freezes the terms. General still follows organization-wide bans.", path: ["app", "db", "app"], input: "Human-confirmed categories and current fund rules", output: "A funding split, then frozen terms and reservations", boundary: "AI does not choose an exception. A rule failure stops the allocation." },
  { name: "4. Two approvals", actor: "Tara + Ben", heading: "Two different people approve the same terms.", text: "Tara reviews the expense, categories, recipient and split. Ben reviews the same frozen decision. One approval is not enough. Changed financial terms invalidate old approvals. On the second approval, the app recognizes the obligation, not a payment.", path: ["browser", "app", "db"], input: "Frozen terms and each authenticated reviewer", output: "Two approvals and a reimbursement payable", boundary: "Maria cannot approve her own claim. AI cannot approve for anyone." },
  { name: "5. PayPal", actor: "Authorized approver", heading: "A person explicitly sends. Accepted is not paid.", text: "After two approvals, an authorized approver must confirm and select Send. The adapter submits to PayPal Sandbox using saved sender IDs. The app independently fetches the individual payout item. Pending or unknown does not mean paid; an unknown outcome must be reconciled before another attempt.", path: ["browser", "app", "paypal", "app", "db"], input: "Explicit authorized send of the approved terms", output: "Saved payout attempt and provider status", boundary: "This walkthrough sends nothing. Real payment controls live on the authorized claim page." },
  { name: "6. Ledger", actor: "Ledger module", heading: "Verified success closes the payable once.", text: "Only a verified successful payout item permits settlement. The ledger records the payment and reported fee. Re-reading the same result must not post it twice. Book cash is an accounting figure, not a current PayPal balance.", path: ["app", "db"], input: "Independently fetched success and reported fee", output: "Settlement, fee and a read-only cash view", boundary: "Only the ledger module writes journals. No success is invented by an animation." },
] as const;
const nodes = [
  { id: "browser", label: "Browser", description: "Maria, Tara or Ben" },
  { id: "app", label: "AidTrace app", description: "Rules, approvals, adapter, ledger" },
  { id: "model", label: "Local AI model", description: "Separate container" },
  { id: "db", label: "Postgres", description: "Separate container" },
  { id: "paypal", label: "PayPal Sandbox", description: "External service" },
] as const;
const nodeNames = Object.fromEntries(nodes.map(node => [node.id, node.label]));

export function ArchitectureExplorer() {
  const [selected, select] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const step = steps[selected]!;
  const stopped = blocked && selected >= 2;
  const path: readonly string[] = stopped ? ["app", "db", "app"] : step.path;
  const component = (id: typeof nodes[number]["id"], target: number) => {
    const node = nodes.find(item => item.id === id)!;
    return <button className={`architecture-node${path.includes(id) ? " active" : ""}`} aria-label={`Explore ${node.label}`} aria-pressed={path.includes(id)} onClick={() => select(target)}><strong>{node.label}</strong><span>{node.description}</span></button>;
  };
  return <div className="architecture-explorer">
    <div className="explorer-case" role="group" aria-label="Illustrative scenario"><button aria-pressed={!blocked} onClick={() => { setBlocked(false); select(0); }}>Allowed expense: $6</button><button className="secondary" aria-pressed={blocked} onClick={() => { setBlocked(true); select(2); }}>What if the receipt includes alcohol?</button></div>
    <p className="explorer-disclaimer">Interactive explanation using fictional data. No model, provider or financial requests are executed. This is not live telemetry.</p>
    <nav aria-label="Architecture steps" className="explorer-steps">{steps.map((item, index) => <button key={item.name} aria-pressed={selected === index} onClick={() => select(index)}>{item.name}</button>)}</nav>
    <div className="deployment-flow" role="group" aria-label="Illustrated deployment boundaries">
      <div className="deployment-edge"><p className="eyebrow">User device</p>{component("browser", 0)}</div>
      <div className="deployment-orbstack"><p className="eyebrow">OrbStack / Private containers</p>{component("app", 2)}<p className="container-links" aria-hidden="true">↕</p><div className="deployment-services">{component("model", 1)}{component("db", 5)}</div></div>
      <div className="deployment-edge"><p className="eyebrow">External service</p>{component("paypal", 4)}</div>
    </div>
    <p className="muted">Click a component or a step. Highlights illustrate the selected handoff; they do not indicate live traffic.</p>
    <div className="explorer-detail" aria-live="polite" aria-atomic="true">
      <p className="eyebrow">{stopped ? "Policy stop / No bypass" : `Step ${selected + 1} of 6 / ${step.actor}`}</p>
      <h2>{stopped ? "The expense stops at the rules." : step.heading}</h2>
      <p>{stopped ? "In this example, organization policy prohibits alcohol. General cannot cover it either. No allocation is frozen, no approval authorizes it, and nothing reaches PayPal. Choosing later stages here explains the stop; it does not bypass it." : step.text}</p>
      <p className="route-caption">Illustrated handoff</p><ol className="handoff-path" aria-label="Illustrated request path">{path.map((id, index) => <li key={`${id}:${index}`}>{nodeNames[id]}{index < path.length - 1 && <span aria-hidden="true"> → </span>}</li>)}</ol>
      <dl><dt>What goes in</dt><dd>{stopped ? "A confirmed prohibited item and organization policy" : step.input}</dd><dt>What comes out</dt><dd>{stopped ? "A blocked proposal requiring human correction, no funding authorization" : step.output}</dd></dl>
      <p className="notice">{stopped ? "No human or AI approval in this flow can override the organization-wide ban." : step.boundary}</p>
    </div>
    <div className="explorer-navigation"><button className="secondary" disabled={selected === 0} onClick={() => select(selected - 1)}>Previous step</button><span>{selected + 1} / 6</span><button disabled={selected === 5} onClick={() => select(selected + 1)}>Next step</button></div>
    <details className="architecture-boundaries"><summary>Where the components actually run</summary><p>Logical modules are not separate services. The rule engine, auth, approvals, PayPal adapter and ledger run inside the same Next.js app container. Postgres and the model are separate containers in OrbStack. PayPal Sandbox is outside OrbStack.</p>
      <p className="muted">Highlighted components belong to the selected illustration. The view does not observe traffic or confirm that a request occurred. It reads no claim or account data.</p>
    </details>
  </div>;
}
