import { keylessPanelModel, type GiveFund } from "../../donation/give-model";

// Read-only. A keyless session never creates an order, so this panel has no order, capture or paid state to show.
export function KeylessPanel({ funds }: { funds: readonly GiveFund[] }) {
  const model = keylessPanelModel(funds);
  return <section className="paypal-handoff give-panel" aria-label="Donation preview without PayPal credentials" data-testid="give-keyless-panel">
    <h2>{model.headline}</h2>
    <p>This session has no PayPal credentials, so it cannot start Checkout. Below is what a session with credentials would offer and send. Nothing on this page is submitted.</p>
    <dl className="payment-details">
      <dt>State</dt><dd>{model.state}</dd>
      <dt>Funds you could choose</dt><dd>{model.funds.length ? <ul className="give-list">{model.funds.map(fund => <li key={fund.id}>{fund.name}</li>)}</ul> : "No restricted fund is available."}</dd>
      <dt>Amounts you could choose</dt><dd>{model.amounts.join(", ")}</dd>
      <dt>PayPal order ID</dt><dd>{model.ids.paypalOrderId}</dd>
      <dt>Capture ID</dt><dd>{model.ids.captureId}</dd>
    </dl>
    {model.requestShape && <details open><summary>Request shape the server would send</summary>
      <p>Example for {model.exampleLabel}. The amount text is built from integer cents. This is a read-only illustration, never a submitted request.</p>
      <pre>{JSON.stringify(model.requestShape, null, 2)}</pre></details>}
  </section>;
}
