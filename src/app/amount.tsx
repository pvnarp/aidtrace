/** A large amount: "$500.00" renders as $500 with the ".00" smaller and lighter. The text content stays "$500.00". */
export function Amount({ value }: { value: string }) {
  const match = /^(.*)(\.\d{2})$/.exec(value);
  return match ? <>{match[1]}<small className="cents">{match[2]}</small></> : <>{value}</>;
}
