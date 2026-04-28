import { useState, useRef, useCallback } from "react";

const BACKEND = "https://fda-pnc-production.up.railway.app";


async function parseInvoiceWithClaude(fileBase64, mimeType) {
  const isImage = mimeType.startsWith("image/");
  const contentBlock = isImage
    ? { type: "image", source: { type: "base64", media_type: mimeType, data: fileBase64 } }
    : { type: "document", source: { type: "base64", media_type: "application/pdf", data: fileBase64 } };

  const prompt = `You are a customs document parser. Extract all relevant fields from this commercial invoice and return ONLY a valid JSON object (no markdown, no explanation) with this exact structure:

{
  "invoiceNumber": "",
  "invoiceDate": "",
  "trackingNumber": "",
  "portOfEntry": "",
  "estimatedArrival": "",
  "originCountry": "",
  "shipper": {
    "name": "",
    "address": "",
    "city": "",
    "zip": "",
    "country": ""
  },
  "consignee": {
    "name": "",
    "address": "",
    "city": "",
    "zip": "",
    "country": ""
  },
  "items": [
    {
      "description": "",
      "hsCode": "",
      "quantity": 0,
      "quantityUnit": "",
      "unitValue": 0,
      "totalValue": 0,
      "countryOfOrigin": "",
      "manufacturer": "",
      "needsPNC": true
    }
  ],
  "totalValue": 0,
  "currency": "USD",
  "needsPNC": true
}

Rules:
- needsPNC = true if any item HS code starts with 02-24 (food/beverage chapters) AND destination is US
- If a field is not found, use empty string or 0
- Return ONLY the JSON, nothing else`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      messages: [{ role: "user", content: [contentBlock, { type: "text", text: prompt }] }],
    }),
  });

  const data  = await response.json();
  const raw   = data.content?.find((b) => b.type === "text")?.text || "{}";
  const clean = raw.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
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
  grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
  grid3: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16 },
  tag: (color) => ({ display: "inline-flex", alignItems: "center", gap: 5, padding: "3px 10px", borderRadius: 99, background: color === "gold" ? "#fef9ee" : color === "green" ? "#f0fdf4" : color === "red" ? "#fef2f2" : "#f3f4f6", color: color === "gold" ? "#92680e" : color === "green" ? "#166534" : color === "red" ? "#991b1b" : "#6b7280", fontSize: 12, fontFamily: "'DM Sans', sans-serif", fontWeight: 600 }),
  logBox: { marginTop: 12, padding: "12px 14px", borderRadius: 8, background: "#0f0e0c", fontFamily: "monospace", fontSize: 12, color: "#a8a090", maxHeight: 130, overflowY: "auto", lineHeight: 1.8 },
};

function Field({ label, value, onChange, type = "text" }) {
  return (
    <div>
      <label style={S.label}>{label}</label>
      <input type={type} value={value || ""} onChange={(e) => onChange(e.target.value)} style={S.input} />
    </div>
  );
}

function InvoiceCard({ invoice, idx, onUpdate, onSubmit, onRemove, submitting, fdaReady }) {
  const [expanded, setExpanded] = useState(true);
  const status = invoice.pncStatus || "idle";
  const update = (path, val) => {
    const clone = JSON.parse(JSON.stringify(invoice));
    const keys  = path.split(".");
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
  const statusLabel = { idle: "Ready", submitting: "Submitting…", success: "Submitted ✓", error: "Failed" }[status] || status;

  return (
    <div style={S.card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12, marginBottom: expanded ? 24 : 0 }}>
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: 18, fontWeight: 400 }}>Invoice #{invoice.invoiceNumber || idx + 1}</span>
            {invoice.needsPNC && <span style={S.tag("gold")}>⚑ PNC Required</span>}
            {status !== "idle" && <span style={S.tag(statusColor)}>{statusLabel}</span>}
          </div>
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#9b8f7e" }}>
            {invoice.shipper?.name} → {invoice.consignee?.name}{invoice.invoiceDate ? ` · ${invoice.invoiceDate}` : ""}
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
            <button onClick={() => onSubmit(invoice)} disabled={submitting || !fdaReady} style={S.accentBtn(submitting || !fdaReady)}>
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
            <div style={S.grid3}>
              <Field label="Invoice Number"   value={invoice.invoiceNumber}     onChange={(v) => update("invoiceNumber", v)} />
              <Field label="Invoice Date"     value={invoice.invoiceDate}       onChange={(v) => update("invoiceDate", v)} />
              <Field label="Tracking Number"  value={invoice.trackingNumber}    onChange={(v) => update("trackingNumber", v)} />
              <Field label="Port of Entry"    value={invoice.portOfEntry}       onChange={(v) => update("portOfEntry", v)} />
              <Field label="Est. Arrival"     value={invoice.estimatedArrival}  onChange={(v) => update("estimatedArrival", v)} type="date" />
              <Field label="Origin Country"   value={invoice.originCountry}     onChange={(v) => update("originCountry", v)} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 20 }}>
            {[{ title: "Shipper", prefix: "shipper" }, { title: "Consignee", prefix: "consignee" }].map(({ title, prefix }) => (
              <div key={prefix}>
                <div style={S.sectionTitle}>{title}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label="Name"    value={invoice[prefix]?.name}    onChange={(v) => update(`${prefix}.name`, v)} />
                  <Field label="Address" value={invoice[prefix]?.address} onChange={(v) => update(`${prefix}.address`, v)} />
                  <div style={S.grid3}>
                    <Field label="City"    value={invoice[prefix]?.city}    onChange={(v) => update(`${prefix}.city`, v)} />
                    <Field label="ZIP"     value={invoice[prefix]?.zip}     onChange={(v) => update(`${prefix}.zip`, v)} />
                    <Field label="Country" value={invoice[prefix]?.country} onChange={(v) => update(`${prefix}.country`, v)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          <div>
            <div style={S.sectionTitle}>Line Items</div>
            {(invoice.items || []).map((item, iIdx) => (
              <div key={iIdx} style={{ background: "#faf9f6", borderRadius: 10, padding: "16px 18px", marginBottom: 12 }}>
                <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12, fontWeight: 700, color: "#9b8f7e", marginBottom: 12 }}>ITEM {iIdx + 1}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  <Field label="Description" value={item.description} onChange={(v) => updateItem(iIdx, "description", v)} />
                  <div style={S.grid3}>
                    <Field label="HS Code"           value={item.hsCode}          onChange={(v) => updateItem(iIdx, "hsCode", v)} />
                    <Field label="Quantity"           value={item.quantity}        onChange={(v) => updateItem(iIdx, "quantity", v)} type="number" />
                    <Field label="Unit"               value={item.quantityUnit}    onChange={(v) => updateItem(iIdx, "quantityUnit", v)} />
                    <Field label="Country of Origin"  value={item.countryOfOrigin} onChange={(v) => updateItem(iIdx, "countryOfOrigin", v)} />
                    <Field label="Unit Value"         value={item.unitValue}       onChange={(v) => updateItem(iIdx, "unitValue", v)} type="number" />
                    <Field label="Total Value"        value={item.totalValue}      onChange={(v) => updateItem(iIdx, "totalValue", v)} type="number" />
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
  const [invoices,   setInvoices]   = useState([]);
  const [dragging,   setDragging]   = useState(false);
  const [parsing,    setParsing]    = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState("");
  const [fdaUser,    setFdaUser]    = useState("");
  const [fdaPass,    setFdaPass]    = useState("");
  const [showCreds,  setShowCreds]  = useState(false);
  const fileRef = useRef();
  const fdaReady = fdaUser && fdaPass;

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

  const onDrop = useCallback((e) => { e.preventDefault(); setDragging(false); processFiles(e.dataTransfer.files); }, [processFiles]);
  const updateInvoice = (idx, data) => setInvoices((prev) => prev.map((inv, i) => i === idx ? data : inv));
  const removeInvoice = (idx) => setInvoices((prev) => prev.filter((_, i) => i !== idx));
  const patchInvoice  = (invoice, patch) => setInvoices((prev) => prev.map((inv) => inv._fileName === invoice._fileName ? { ...inv, ...patch } : inv));

  const submitOne = useCallback(async (invoice) => {
    if (!fdaReady) { setShowCreds(true); return; }
    patchInvoice(invoice, { pncStatus: "submitting", logs: [] });
    setSubmitting(true);
    try {
      const res  = await fetch(`${BACKEND}/submit-pnc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoice, fdaUsername: fdaUser, fdaPassword: fdaPass }) });
      const data = await res.json();
      patchInvoice(invoice, { pncStatus: data.success ? "success" : "error", confirmationNumber: data.confirmationNumber, logs: data.logs || [] });
    } catch (e) { patchInvoice(invoice, { pncStatus: "error", logs: [e.message] }); }
    finally { setSubmitting(false); }
  }, [fdaUser, fdaPass, fdaReady]);

  const submitAll = useCallback(async () => {
    if (!fdaReady) { setShowCreds(true); return; }
    const toSubmit = invoices.filter((inv) => inv.needsPNC && inv.pncStatus !== "success");
    setSubmitting(true);
    toSubmit.forEach((inv) => patchInvoice(inv, { pncStatus: "submitting", logs: [] }));
    try {
      const res  = await fetch(`${BACKEND}/submit-all-pnc`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ invoices: toSubmit, fdaUsername: fdaUser, fdaPassword: fdaPass }) });
      const data = await res.json();
      for (const r of data.results || []) {
        setInvoices((prev) => prev.map((inv) => inv.invoiceNumber === r.invoiceNumber ? { ...inv, pncStatus: r.success ? "success" : "error", confirmationNumber: r.confirmationNumber, logs: r.logs } : inv));
      }
    } catch (e) { toSubmit.forEach((inv) => patchInvoice(inv, { pncStatus: "error", logs: [e.message] })); }
    finally { setSubmitting(false); }
  }, [invoices, fdaUser, fdaPass, fdaReady]);

  const pncPending = invoices.filter((inv) => inv.needsPNC && inv.pncStatus !== "success");
  const pncDone    = invoices.filter((inv) => inv.pncStatus === "success");

  return (
    <div style={S.app}>
      <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@400;600;700&display=swap" rel="stylesheet" />
      <div style={S.header}>
        <div style={S.logo}><span style={S.logoAccent}>FDA </span>Prior Notice Automation</div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          {invoices.length > 0 && (
            <>
              <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#9b8f7e" }}>{pncDone.length}/{invoices.filter((i) => i.needsPNC).length} submitted</span>
              {pncPending.length > 0 && <button onClick={submitAll} disabled={submitting || !fdaReady} style={S.accentBtn(submitting || !fdaReady)}>Submit All ({pncPending.length})</button>}
            </>
          )}
          <button onClick={() => setShowCreds(!showCreds)} style={{ ...S.secondaryBtn, background: "#2a2420", color: fdaReady ? "#c8a96e" : "#9b8f7e", border: "1px solid #3a3430" }}>
            {fdaReady ? "✓ FDA Credentials" : "Set FDA Credentials"}
          </button>
        </div>
      </div>

      <div style={S.body}>
        {showCreds && (
          <div style={S.card}>
            <div style={S.sectionTitle}>FDA PNC Credentials — session only, never stored</div>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={S.label}>Username</label>
                <input type="text" value={fdaUser} onChange={(e) => setFdaUser(e.target.value)} style={S.input} placeholder="FDA PNC username" />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={S.label}>Password</label>
                <input type="password" value={fdaPass} onChange={(e) => setFdaPass(e.target.value)} style={S.input} placeholder="FDA PNC password" />
              </div>
              <button onClick={() => setShowCreds(false)} style={S.primaryBtn(false)}>Save</button>
            </div>
          </div>
        )}

        <div style={S.card}>
          <div style={S.sectionTitle}>Upload Commercial Invoices</div>
          <div style={S.dropzone(dragging)} onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} onClick={() => fileRef.current?.click()}>
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
          <InvoiceCard key={idx} invoice={inv} idx={idx} onUpdate={updateInvoice} onSubmit={submitOne} onRemove={removeInvoice} submitting={submitting} fdaReady={fdaReady} />
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
