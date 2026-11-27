// Where Clerk's form goes, so the shell around it can be looked at without a Clerk instance.
export function ClerkStandIn({ heading, sub }: { heading: string; sub?: string }) {
  return (
    <div style={{ display: "grid", gap: 12, padding: "12px 8px", border: "1px dashed" }}>
      <p style={{ font: "400 36px/1 var(--larper-os-font-pixel)" }}>{heading}</p>
      {sub && <p>{sub}</p>}
      <button type="button" className="larper-os-button">continue with Google</button>
      <p style={{ textAlign: "center" }}>or</p>
      <label style={{ display: "grid", gap: 6 }}>
        email address
        <input type="email" style={{ minHeight: 44, border: "1px solid", background: "#fff" }} />
      </label>
      <button type="button" className="larper-os-button larper-os-button-primary">continue</button>
    </div>
  );
}
