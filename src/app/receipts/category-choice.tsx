"use client";
import { useState } from "react";
import { CATEGORY_NAMES, SELECTABLE } from "../../ai/categories";
export function CategoryChoice({ lineId, proposed, editable }: { lineId: string; proposed?: string; editable: boolean }) {
  // A legacy or unknown proposed id is never preselected: the form would post an id budgetFor refuses.
  const accepted = proposed && (SELECTABLE as readonly string[]).includes(proposed) ? proposed : "";
  const [category, setCategory] = useState(accepted);
  const manual = !accepted || category !== accepted;
  return <div className="category-choice">
    <label htmlFor={`category${lineId}`}>Category for {lineId}</label>
    <select id={`category${lineId}`} name={`category${lineId}`} value={category} onChange={event => setCategory(event.target.value)} required disabled={!editable}>
      <option value="">Choose a category</option>{SELECTABLE.map(value => <option value={value} key={value}>{CATEGORY_NAMES[value]}</option>)}
    </select>
    <div hidden={!manual} className="manual-reason"><label htmlFor={`reason${lineId}`}>Reason for manual choice {lineId}</label>
      <input id={`reason${lineId}`} name={`reason${lineId}`} aria-describedby={`reasonHint${lineId}`} required={manual} minLength={manual ? 3 : undefined} maxLength={200} disabled={!editable} />
      <p id={`reasonHint${lineId}`} className="muted">Explain this human choice in at least three characters.</p></div>
  </div>;
}
