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
          <button onClick={() => setActiveTab("upload")} style={{ ...S.secondaryBtn, background: activeTab === "upload" ? "#3a3430" : "#2a2420", color: activeTab === "upload" ? "#c8a96e" : "#9b8f7e", border: "1px solid #3a3430" }}>
            Upload Invoice
          </button>
          <button onClick={() => setActiveTab("duplicate")} style={{ ...S.secondaryBtn, background: activeTab === "duplicate" ? "#3a3430" : "#2a2420", color: activeTab === "duplicate" ? "#c8a96e" : "#9b8f7e", border: "1px solid #3a3430" }}>
            PNC Duplicate
          </button>
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
            {loginError && <div style={{ marginBottom: 16, fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#991b1b" }}>⚠ {loginError}</div>}
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={S.label}>Username</label>
                <input type="text" value={fdaUser} onChange={(e) => setFdaUser(e.target.value)} style={S.input} placeholder="FDA PNC username" />
              </div>
              <div style={{ flex: 1, minWidth: 180 }}>
                <label style={S.label}>Password</label>
                <input type="password" value={fdaPass} onChange={(e) => setFdaPass(e.target.value)} style={S.input} placeholder="FDA PNC password" />
              </div>
              <button onClick={startLogin} disabled={!fdaUser || !fdaPass || loginStatus === "logging_in"} style={S.primaryBtn(!fdaUser || !fdaPass || loginStatus === "logging_in")}>
                {loginStatus === "logging_in" ? "Connecting…" : "Login"}
              </button>
            </div>
            <div style={{ marginTop: 12, fontFamily: "'DM Sans', sans-serif", fontSize: 12, color: "#9b8f7e" }}>
              Your credentials are sent directly to FDA and never stored.
            </div>
          </div>
        )}

        {activeTab === "upload" && (
          <>
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
              <InvoiceCard key={idx} invoice={inv} idx={idx} onUpdate={updateInvoice} onSubmit={submitOne} onRemove={removeInvoice} submitting={submitting} loggedIn={loggedIn} />
            ))}

            {!parsing && invoices.length === 0 && (
              <div style={{ textAlign: "center", padding: "60px 20px", color: "#c2b9ad", fontFamily: "'DM Sans', sans-serif" }}>
                Upload a commercial invoice to get started
              </div>
            )}
          </>
        )}

        {activeTab === "duplicate" && (
          <>
            <div style={S.card}>
              <div style={S.sectionTitle}>PNC Duplicate</div>
              <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#9b8f7e", marginBottom: 20 }}>
                Copy an existing PNC with new tracking number and importer details.
              </div>
              <button onClick={() => setDupRows(prev => [...prev, { sourcePncId: "", trackingNumber: "", importerName: "", importerAddress: "", importerCity: "", importerState: "", importerZip: "", status: "idle", confirmationNumber: "", logs: [] }])} style={S.secondaryBtn}>
                + Add Row
              </button>
            </div>

            {dupRows.map((row, idx) => (
              <div key={idx} style={S.card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <div>
                    <span style={{ fontSize: 16 }}>Shipment #{idx + 1}</span>
                    {row.status === "success" && <span style={{ ...S.tag("green"), marginLeft: 10 }}>✓ Submitted</span>}
                    {row.status === "error" && <span style={{ ...S.tag("red"), marginLeft: 10 }}>Failed</span>}
                    {row.status === "submitting" && <span style={{ ...S.tag("gold"), marginLeft: 10 }}>Submitting…</span>}
                    {row.confirmationNumber && (
                      <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: "#166534", marginTop: 4 }}>
                        PNC# <strong>{row.confirmationNumber}</strong>
                      </div>
                    )}
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button onClick={() => submitDuplicate(row, idx)} disabled={dupSubmitting || !loggedIn || row.status === "success"} style={S.accentBtn(dupSubmitting || !loggedIn || row.status === "success")}>
                      {row.status === "submitting" ? "Submitting…" : "Submit PNC"}
                    </button>
                    <button onClick={() => setDupRows(prev => prev.filter((_, i) => i !== idx))} style={{ ...S.secondaryBtn, color: "#991b1b", borderColor: "#fca5a5" }}>✕</button>
                  </div>
                </div>

                <div style={S.grid3}>
                  <Field label="Source PNC ID" value={row.sourcePncId} onChange={(v) => setDupRows(prev => prev.map((r, i) => i === idx ? { ...r, sourcePncId: v } : r))} />
                  <Field label="New Tracking Number" value={row.trackingNumber} onChange={(v) => setDupRows(prev => prev.map((r, i) => i === idx ? { ...r, trackingNumber: v } : r))} />
                  <div />
                </div>

                <div style={{ marginTop: 16 }}>
                  <div style={S.sectionTitle}>Importer Details</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                    <Field label="Importer Name" value={row.importerName} onChange={(v) => setDupRows(prev => prev.map((r, i) => i === idx ? { ...r, importerName: v } : r))} />
                    <Field label="Street Address" value={row.importerAddress} onChange={(v) => setDupRows(prev => prev.map((r, i) => i === idx ? { ...r, importerAddress: v } : r))} />
                    <div style={S.grid3}>
                      <Field label="City" value={row.importerCity} onChange={(v) => setDupRows(prev => prev.map((r, i) => i === idx ? { ...r, importerCity: v } : r))} />
                      <Field label="State" value={row.importerState} onChange={(v) => setDupRows(prev => prev.map((r, i) => i === idx ? { ...r, importerState: v } : r))} />
                      <Field label="ZIP" value={row.importerZip} onChange={(v) => setDupRows(prev => prev.map((r, i) => i === idx ? { ...r, importerZip: v } : r))} />
                    </div>
                  </div>
                </div>

                {row.logs?.length > 0 && (
                  <div style={S.logBox}>{row.logs.map((l, i) => <div key={i}>{l}</div>)}</div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
