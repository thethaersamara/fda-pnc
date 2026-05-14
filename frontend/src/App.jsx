import { useState, useRef, useCallback } from "react";

const BACKEND = "/api";
const SESSION_ID = Math.random().toString(36).slice(2);

async function parseInvoiceWithClaude(fileBase64, mimeType) {
  const response = await fetch(`${BACKEND}/parse-invoice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pdfBase64: fileBase64, mimeType }),
  });
  const data = await response.json();
  if (!data.success) throw new Error(data.error || "Parse failed");
  return data.invoice;
}

const S = {
  app: { minHeight: "100vh", background: "#f7f5f0", fontFamily: "'DM Serif Display', Georgia, serif", color: "#1a1612" },
  header: { background: "#1a1612", padding: "24px 40px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16 },
  logo: { fontSize: 20, fontWeight: 400, color: "#f7f5f0", letterSpacing: "-0.01em" },
  logoAccent: { color: "#c8a96e" },
  body: { maxWidth: 900, margin: "0 auto", padding: "40px 24px" },
  card: { background: "#fff", border: "1px solid #e8e3da", borderRadius: 16, padding: "28px 32px", marginBottom: 20, boxShadow: "0 2px 12px rgba(0,0,0,0.04)" },
  sectionTitle: { fontSize: 13, fontFamily: "'DM Sans', sans-serif", fontWeight: 700, color: "#9b8f7e", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 20 },
  dropzone: (dragging) => ({ border: `2px dashed ${dragging ? "#c8a96e" : "#d6cfc4"}`, borderRadius: 12, padding: "48px 24px", textAlign: "center", cursor: "pointer", transition: "all 0.2s", background: dragging ? "#fdf9f2" : "#faf9f6" }),
  primaryBtn: (disabled) => ({ padding: "11px 24px", borderRadius: 8, fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 600, background: disabled ? "#d6cfc4" : "#1a1612", color: "#f7f5f0", border: "none", cursor: disabled ? "not-allowed" : "pointer" }),
  secondaryBtn: { padding: "11px 24px", borderRadius: 8, fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 600, background: "transparent", color: "#6b5e4e", border: "1px solid #d6cfc4", cursor: "pointer" },
  accentBtn: (disabled) => ({ padding: "11px 24px", borderRadius: 8, fontFamily: "'DM Sans', sans-serif", fontSize: 14, fontWeight: 600, background: disabled ? "#d6cfc4" : "#c8a96e", color: "#fff", border: "none", cursor: disabled ? "not-allowed" : "pointer" }),
  input: { width: "100%", padding: "9px 12px", borderRadius: 8, border: "1px solid #e0d9d0", fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "#1a1612", background: "#faf9f6", outline: "none", boxSizing: "border-box" },
  label: { display: "block", fontSize: 11, fontFamily: "'DM Sans', sans-serif", fontWeight: 700, color: "#9b8f7e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 5 },
  grid3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 },
  tag: (color) => ({ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 99, background: color === "gold" ? "#fef9ee" : color === "green" ? "#f0fdf4" : color === "red" ? "#fef2f2" : "#f3f4f6", color: color === "gold" ? "#92680e" : color === "green" ? "#166534" : color === "red" ? "#991b1b" : "#6b7280", fontSize: 12, fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }),
  logBox: { marginTop: 12, padding: "12px 14px", borderRadius: 8, background: "#0f0e0c", fontFamily: "monospace", fontSize: 12, color: "#a8a090", maxHeight: 130, overflowY: "auto", lineHeight: 1.8 },
  otpBox: { position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 },
  otpCard: { background: "#fff", borderRadius: 20, padding: "40px 36px", maxWidth: 420, width: "90%", textAlign: "center", boxShadow: "0 20px 60px rgba(0,0,0,0.3)" },
};

function Field({ label, value, onChange, type = "text" }) {
  return (
    <div>
      <label style={S.label}>{label}</label>
      <input type={type} value={value || ""} onChange={(e) => onChange(e.target.value)} style={S.input} />
    </div>
  );
}

function OTPModal({ onSubmit, onCancel, loading }) {
  const [otp, setOtp] = useState("");
  return (
    <div style={S.otpBox}>
      <div style={S.otpCard}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>📧</div>
        <div style={{ fontSize: 22, fontWeight: 400, marginBottom: 8 }}>Check your email</div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, color: "#9b8f7e", marginBottom: 28, lineHeight: 1.6 }}>
          FDA sent a one-time password to your email. Enter it below to continue.
        </div>
        <input
          type="text"
          placeholder="Enter OTP code"
          value={otp}
          onChange={(e) => setOtp(e.target.value)}
          style={{ ...S.input, textAlign: "center", fontSize: 24, letterSpacing: "0.2em", marginBottom: 16 }}
          autoFocus
        />
        <div style={{ display: "flex", gap: 10, justifyContent: "center" }}>
          <button onClick={onCancel} style={S.secondaryBtn}>Cancel</button>
          <button onClick={() => onSubmit(otp)} disabled={!otp || loading} style={S.accentBtn(!otp || loading)}>
            {loading ? "Verifying…" : "Continue"}
          </button>
        </div>
      </div>
    </div>
  );
}

function InvoiceCard({ invoice, idx, onUpdate, onSubmit, onRemove, submitting, loggedIn }) {
  const [expanded, setExpanded] = useState(true);
  const status = invoice.pncStatus || "idle";

  const update = (path, val) => {
    const clone = JSON.parse(JSON.stringify(invoice));
    const keys = path.split(".");
    let obj = clone;
    for (let i = 0; i < keys.length - 1; i++) obj = obj[keys[i]];
    obj[keys[keys.length - 1]] = val;
    onUpdate(idx, clone);
  };

  const updateItem = (iIdx, key, val) => {
    const clone = JSON.parse(JSON.stringify(invoice));
    clone.items[iIdx][key] = val;
    onUpdate(idx, clone);
  };

  const statusColor = { idle: "gold", submitting: "gold", success: "green", error: "red" }[status] || "gold";
  const statusLabel = { idle: "Ready", submitting: "Submitting…", success: "Submitted ✓", error: "Failed" }[status];

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: expanded ? 24 : 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 18 }}>Invoice #{idx + 1}</span>
            {invoice.needsPNC && <span style={S.tag("gold")}>⚑ PNC Required</span>}
            {status !== "idle" && <span style={S.tag(statusColor)}>{statusLabel}</span>}
          </div>
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#9b8f7e" }}>
            {invoice.shipper?.name}{invoice.trackingNumber ? ` · AWB: ${invoice.trackingNumber}` : ""}
          </div>
          {invoice.confirmationNumber && (
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#166534", marginTop: 4 }}>
              PNC# <strong>{invoice.confirmationNumber}</strong>
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={() => setExpanded(!expanded)} style={S.secondaryBtn}>{expanded ? "Collapse" : "Edit"}</button>
          {invoice.needsPNC && status !== "success" && (
            <button onClick={() => onSubmit(invoice)} disabled={submitting || !loggedIn} style={S.accentBtn(submitting || !loggedIn)}>
              {status === "submitting" ? "Submitting…" : "Submit PNC"}
            </button>
          )}
          <button onClick={() => onRemove(idx)} style={{ ...S.secondaryBtn, color: "#991b1b", borderColor: "#fca5a5" }}>✕</button>
        </div>
      </div>

      {expanded && (
        <>
          <div style={{ marginBottom: 20 }}>
            <div style={S.sectionTitle}>Shipment Details</div>
            <div style={{ maxWidth: 300 }}>
              <Field label="Tracking Number" value={invoice.trackingNumber} onChange={(v) => update("trackingNumber", v)} />
            </div>
          </div>

          <div style={{ marginBottom: 20 }}>
            <div style={S.sectionTitle}>Shipper</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <Field label="Name"    value={invoice.shipper?.name}    onChange={(v) => update("shipper.name", v)} />
              <Field label="Address" value={invoice.shipper?.address} onChange={(v) => update("shipper.address", v)} />
              <div style={S.grid3}>
                <Field label="City"    value={invoice.shipper?.city}    onChange={(v) => update("shipper.city", v)} />
                <Field label="ZIP"     value={invoice.shipper?.zip}     onChange={(v) => update("shipper.zip", v)} />
                <Field label="Country" value={invoice.shipper?.country} onChange={(v) => update("shipper.country", v)} />
              </div>
            </div>
          </div>

          <div>
            <div style={S.sectionTitle}>Line Items</div>
            {(invoice.items || []).map((item, iIdx) => (
              <div key={iIdx} style={{ background: "#faf9f6", borderRadius: 10, padding: "16px 18px", marginBottom: 12 }}>
                <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 700, color: "#9b8f7e", marginBottom: 12 }}>ITEM {iIdx + 1}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label="Description" value={item.description} onChange={(v) => updateItem(iIdx, "description", v)} />
                  <div style={S.grid3}>
                    <Field label="Quantity"          value={item.quantity}        onChange={(v) => updateItem(iIdx, "quantity", v)} type="number" />
                    <Field label="Unit"              value={item.quantityUnit}    onChange={(v) => updateItem(iIdx, "quantityUnit", v)} />
                    <Field label="Country of Origin" value={item.countryOfOrigin} onChange={(v) => updateItem(iIdx, "countryOfOrigin", v)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {invoice.logs?.length > 0 && (
        <div style={S.logBox}>{invoice.logs.map((l, i) => <div key={i}>{l}</div>)}</div>
      )}
    </div>
  );
}

export default function App() {
  const [invoices, setInvoices] = useState([]);
  const [dragging,    setDragging]    = useState(false);
  const [parsing,     setParsing]     = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [parseError,  setParseError]  = useState("");
  const [fdaUser,     setFdaUser]     = useState("");
  const [fdaPass,     setFdaPass]     = useState("");
  const [showCreds,   setShowCreds]   = useState(false);
  const [loginStatus, setLoginStatus] = useState("idle");
  const [showOTP,     setShowOTP]     = useState(false);
  const [otpLoading,  setOtpLoading]  = useState(false);
  const [loginError,  setLoginError]  = useState("");

  const fileRef  = useRef();
  const loggedIn = loginStatus === "logged_in";

  const toBase64 = (file) => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result.split(",")[1]);
    r.onerror = rej;
    r.readAsDataURL(file);
  });

  const processFiles = useCallback(async (files) => {
    const supported = Array.from(files).filter((f) => f.type === "application/pdf" || f.type.startsWith("image/"));
    if (!supported.length) { setParseError("Please upload PDF or image files."); return; }
    setParsing(true); setParseError("");
    for (const file of supported) {
      try {
        const b64    = await toBase64(file);
        const parsed = await parseInvoiceWithClaude(b64, file.type);
        setInvoices((prev) => [...prev, { ...parsed, _fileName: file.name, pncStatus: "idle", logs: [] }]);
      } catch (e) { setParseError(`Failed to parse ${file.name}: ${e.message}`); }
    }
    setParsing(false);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files);
  }, [processFiles]);

  const startLogin = async () => {
    if (!fdaUser || !fdaPass) { setLoginError("Please enter username and password."); return; }
    setLoginStatus("logging_in");
    setLoginError("");
    try {
      const res = await fetch(`${BACKEND}/start-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, fdaUsername: fdaUser, fdaPassword: fdaPass }),
      });
      if (!res.ok && res.status !== 520) {
        const text = await res.text();
        throw new Error(`Server error ${res.status}: ${text}`);
      }
      if (res.status === 520) {
        setLoginStatus("awaiting_otp"); setShowCreds(false); setShowOTP(true); return;
      }
      const data = await res.json();
      if (data.success) {
        setLoginStatus("awaiting_otp"); setShowCreds(false); setShowOTP(true);
      } else {
        setLoginStatus("error");
        setLoginError(data.error || "Login failed — check your credentials.");
      }
    } catch (e) {
      setLoginStatus("error");
      setLoginError(`Connection error: ${e.message}`);
    }
  };

  const submitOTP = async (otp) => {
    setOtpLoading(true);
    try {
      const res = await fetch(`${BACKEND}/submit-otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, otp }),
      });
      const data = await res.json();
      if (data.success) { setLoginStatus("logged_in"); setShowOTP(false); }
      else setLoginError(data.error || "Invalid OTP");
    } catch (e) { setLoginError(e.message); }
    finally { setOtpLoading(false); }
  };

  const updateInvoice = (idx, data) => setInvoices((prev) => prev.map((inv, i) => i === idx ? data : inv));
  const removeInvoice = (idx) => setInvoices((prev) => prev.filter((_, i) => i !== idx));
  const patchInvoice  = (invoice, patch) =>
    setInvoices((prev) => prev.map((inv) => inv._fileName === invoice._fileName ? { ...inv, ...patch } : inv));

  const submitOne = useCallback(async (invoice) => {
    if (!loggedIn) { setShowCreds(true); return; }
    patchInvoice(invoice, { pncStatus: "submitting", logs: [] });
    setSubmitting(true);
    try {
      const res = await fetch(`${BACKEND}/submit-pnc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: SESSION_ID, invoice }),
      });
      const data = await res.json();
      patchInvoice(invoice, { pncStatus: data.success ? "success" : "error", confirmationNumber: data.confirmationNumber, logs: data.logs || [] });
    } catch (e) {
      patchInvoice(invoice, { pncStatus: "error", logs: [e.message] });
    } finally { setSubmitting(false); }
  }, [loggedIn]);

  const pncPending = invoices.filter((inv) => inv.needsPNC && inv.pncStatus !== "success");

  const loginLabel = {
    idle:         "Login to FDA PNC",
    logging_in:   "Connecting to FDA…",
    awaiting_otp: "Waiting for OTP…",
    logged_in:    "✓ Logged in to FDA",
    error:        "Login Failed — Retry",
  }[loginStatus];

  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet" />

      {showOTP && (
        <OTPModal
          onSubmit={submitOTP}
          onCancel={() => { setShowOTP(false); setLoginStatus("idle"); }}
          loading={otpLoading}
        />
      )}

      <div style={S.header}>
        <div style={S.logo}><span style={S.logoAccent}>FDA </span>Prior Notice Automation</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {pncPending.length > 0 && (
            <button onClick={() => pncPending.forEach(submitOne)} disabled={submitting || !loggedIn} style={S.accentBtn(submitting || !loggedIn)}>
              Submit All ({pncPending.length})
            </button>
          )}
          <button
            onClick={() => { if (!loggedIn) setShowCreds(!showCreds); }}
            style={{ ...S.secondaryBtn, background: "#2a2420", color: loggedIn ? "#c8a96e" : loginStatus === "error" ? "#f87171" : "#9b8f7e", border: "1px solid #3a3430" }}
          >
            {loginLabel}
          </button>
        </div>
      </div>

      <div style={S.body}>
        {showCreds && !loggedIn && (
          <div style={S.card}>
            <div style={S.sectionTitle}>FDA PNC Login</div>
            {loginError && (
              <div style={{ marginBottom: 16, fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#991b1b" }}>⚠ {loginError}</div>
            )}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={S.label}>Username</label>
                <input type="text" value={fdaUser} onChange={(e) => setFdaUser(e.target.value)} style={S.input} placeholder="FDA PNC username" />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={S.label}>Password</label>
                <input type="password" value={fdaPass} onChange={(e) => setFdaPass(e.target.value)} style={S.input} placeholder="FDA PNC password" />
              </div>
              <button
                onClick={startLogin}
                disabled={!fdaUser || !fdaPass || loginStatus === "logging_in"}
                style={S.primaryBtn(!fdaUser || !fdaPass || loginStatus === "logging_in")}
              >
                {loginStatus === "logging_in" ? "Connecting…" : "Login"}
              </button>
            </div>
            <div style={{ marginTop: 12, fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "#9b8f7e" }}>
              Your credentials are sent directly to FDA and never stored.
            </div>
          </div>
        )}

        <div style={S.card}>
          <div style={S.sectionTitle}>Upload Commercial Invoices</div>
          <div
            style={S.dropzone(dragging)}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" multiple accept="application/pdf,image/*" style={{ display: "none" }} onChange={(e) => processFiles(e.target.files)} />
            <div style={{ fontSize: 36, marginBottom: 12 }}>📄</div>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 15, color: "#6b5e4e", marginBottom: 6 }}>
              {parsing ? "Parsing invoice with AI…" : "Drop PDFs or images here, or click to browse"}
            </div>
            <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#9b8f7e" }}>
              Claude will extract all fields automatically. Review and edit before submitting.
            </div>
          </div>
          {parseError && <div style={{ marginTop: 12, fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#991b1b" }}>⚠ {parseError}</div>}
        </div>

        {invoices.map((inv, idx) => (
          <InvoiceCard
            key={idx}
            invoice={inv}
            idx={idx}
            onUpdate={updateInvoice}
            onSubmit={submitOne}
            onRemove={removeInvoice}
            submitting={submitting}
            loggedIn={loggedIn}
          />
        ))}

        {!parsing && invoices.length === 0 && (
          <div style={{ textAlign: "center", padding: "60px 20px", color: "#c2b9ad", fontFamily: "'DM Sans', sans-serif" }}>
            Upload a commercial invoice to get started
          </div>
        )}
      </div>
    </div>
  );
}
