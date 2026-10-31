"use client";
import { useEffect, useRef, useState } from "react";
import { ARCHITECTURE_NODES, type ArchitectureStage, type NodeId } from "./stages";

// IAC-403: the locked mock's stage picker with a polite live note. The component highlight from the earlier explorer is kept,
// including the Claude node. Everything is an illustration of the selected explanation: no request is made and nothing is observed.
// As before, choosing a stage or component moves focus to the explanation heading so keyboard and screen reader users land on it.
export function ArchitectureExplorer({ stages }: { stages: ArchitectureStage[] }) {
  const [selected, select] = useState(0);
  const [selection, changedSelection] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const requestedFocus = useRef(false);
  function choose(index: number) { requestedFocus.current = true; select(index); changedSelection(value => value + 1); }
  useEffect(() => {
    if (!requestedFocus.current) return;
    requestedFocus.current = false;
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest(".reference-note")?.scrollIntoView({ block: "start", behavior: "instant" });
  }, [selection]);
  const stage = stages[selected]!;
  const active = new Set<NodeId>(stage.nodes);
  const component = (id: NodeId, target: number) => {
    const node = ARCHITECTURE_NODES.find(item => item.id === id)!;
    return <button className={`architecture-node${active.has(id) ? " active" : ""}${id === "paypal" ? " paypal" : ""}`} aria-label={`Explore ${node.label}`} aria-pressed={active.has(id)} onClick={() => choose(target)}><strong>{node.label}</strong><span>{node.description}</span></button>;
  };
  return <div className="architecture-explorer">
    <div className="reference-links" role="group" aria-label="Architecture stages">{stages.map((item, index) => <button key={item.title} className="secondary" aria-pressed={index === selected} onClick={() => choose(index)}>{item.title}</button>)}</div>
    <div className="reference-note" aria-live="polite" aria-atomic="true" data-testid="architecture-note"><h2 ref={heading} tabIndex={-1} className="explorer-heading">{stage.title}</h2><p className="reference-path">{stage.path}</p><p>{stage.text}</p></div>
    <div className="deployment-flow" role="group" aria-label="Illustrated deployment boundaries">
      <div className="deployment-edge"><p className="eyebrow">User device</p>{component("browser", 2)}</div>
      <div className="deployment-orbstack"><p className="eyebrow">Private Docker containers</p>{component("app", 1)}<p className="container-links" aria-hidden="true">↕</p><div className="deployment-services">{component("db", 1)}</div></div>
      <div className="deployment-external"><p className="eyebrow">External API</p>{component("model", 0)}</div>
      <div className="deployment-edge"><p className="eyebrow">External service</p>{component("paypal", 3)}</div>
    </div>
    <p className="muted">Click a stage or a component. Highlights illustrate the selected explanation; they do not indicate live traffic.</p>
    <details className="architecture-boundaries"><summary>Deployment boundaries</summary><p>Rules, authentication, approvals, the PayPal adapter and the ledger are modules in one Next.js app container. Postgres is a separate Docker container. PayPal Sandbox and the Claude API are external services. This view calls none of them and reads no claim or account data.</p></details>
  </div>;
}
