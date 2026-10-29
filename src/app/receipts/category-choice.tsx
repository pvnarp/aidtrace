"use client";
import { useState } from "react";
const options = { science_kits: "Science kits", notebooks: "Notebooks", hospitality: "Food and refreshments", alcohol: "Alcohol: prohibited" };
export function CategoryChoice({ lineId, proposed, editable }: { lineId: string; proposed?: string; editable: boolean }) {
  const accepted = proposed && proposed !== "UNKNOWN" ? proposed : "";
  const [category, setCategory] = useState(accepted);
  const manual = !accepted || category !== accepted;
  return <div className="category-choice">
    <label htmlFor={`category${lineId}`}>Category for {lineId}</label>
    <select id={`category${lineId}`} name={`category${lineId}`} value={category} onChange={event => setCategory(event.target.value)} required disabled={!editable}>
      <option value="">Choose a category</option>{Object.entries(options).map(([value, name]) => <option value={value} key={value}>{name}</option>)}
    </select>
    <div hidden={!manual} className="manual-reason"><label htmlFor={`reason${lineId}`}>Reason for manual choice {lineId}</label>
      <input id={`reason${lineId}`} name={`reason${lineId}`} aria-describedby={`reasonHint${lineId}`} required={manual} minLength={manual ? 3 : undefined} maxLength={200} disabled={!editable} />
      <p id={`reasonHint${lineId}`} className="muted">Explain this human choice in at least three characters.</p></div>
  </div>;
}
