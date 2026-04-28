require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const { chromium } = require("playwright");

const app      = express();
const PORT     = process.env.PORT || 3001;
const HEADLESS = process.env.HEADLESS !== "false";

app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
}));

// Handle preflight requests
app.options("*", cors());


// Store active sessions waiting for OTP
const sessions = {};

async function safeFill(page, selector, value) {
  if (!value) return;
  try { await page.fill(selector, String(value)); } catch { }
}

async function safeSelect(page, selector, value) {
  if (!value) return;
  try {
    await page.selectOption(selector, { value }).catch(() =>
      page.selectOption(selector, { label: String(value) })
    );
  } catch { }
}

// ─── ROUTE 1: Start login, wait for OTP ──────────────────────────────────────
app.post("/start-login", async (req, res) => {
  const { sessionId, fdaUsername, fdaPassword } = req.body;
  if (!sessionId || !fdaUsername || !fdaPassword)
    return res.status(400).json({ error: "sessionId, fdaUsername, fdaPassword required" });

  const browser = await chromium.launch({ headless: HEADLESS });
  const page    = await (await browser.newContext()).newPage();

  try {
    await page.goto("https://pnc.access.fda.gov/pnc/login", { waitUntil: "networkidle" });
    await safeFill(page, '#username, input[name="username"]', fdaUsername);
    await safeFill(page, '#password, input[name="password"]', fdaPassword);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle" });

    // Save browser + page in memory for this session
    sessions[sessionId] = { browser, page, status: "awaiting_otp" };
    res.json({ success: true, status: "awaiting_otp" });

  } catch (err) {
    await browser.close();
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ROUTE 2: Submit OTP ──────────────────────────────────────────────────────
app.post("/submit-otp", async (req, res) => {
  const { sessionId, otp } = req.body;
  if (!sessionId || !otp)
    return res.status(400).json({ error: "sessionId and otp required" });

  const session = sessions[sessionId];
  if (!session)
    return res.status(404).json({ error: "Session not found or expired" });

  const { page } = session;

  try {
    // Fill OTP field
    await safeFill(page, 'input[name="otp"], input[name="code"], input[type="text"], #otp', otp);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle" });

    session.status = "logged_in";
    res.json({ success: true, status: "logged_in" });

  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── ROUTE 3: Submit PNC (after login) ───────────────────────────────────────
app.post("/submit-pnc", async (req, res) => {
  const { sessionId, invoice } = req.body;
  if (!sessionId || !invoice)
    return res.status(400).json({ error: "sessionId and invoice required" });

  const session = sessions[sessionId];
  if (!session)
    return res.status(404).json({ error: "Session not found or expired" });

  if (session.status !== "logged_in")
    return res.status(400).json({ error: "Not logged in yet" });

  const { page, browser } = session;
  const logs = [];
  const log  = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };

  try {
    log("Opening new Prior Notice...");
    await page.click([
      'a[href*="create"]', 'a[href*="newPriorNotice"]',
      'button:has-text("New")', 'a:has-text("Create Prior Notice")',
    ].join(", "));
    await page.waitForNavigation({ waitUntil: "networkidle" });

    log("Filling article information...");
    const item = invoice.items?.[0] || {};
    await safeFill(page,  '#articleDescription, input[name="articleDescription"]', item.description || "");
    await safeFill(page,  '#quantity, input[name="quantity"]', String(item.quantity || 1));
    await safeSelect(page,'#quantityUOM, select[name="quantityUOM"]', item.quantityUnit || "EACH");
    await safeFill(page,  '#harmonizedCode, input[name="hsCode"]', item.hsCode || "");
    await safeSelect(page,'#countryOfOrigin, select[name="countryOfOrigin"]', item.countryOfOrigin || invoice.originCountry || "");
    await safeFill(page,  '#manufacturerName, input[name="manufacturerName"]', invoice.shipper?.name || "");

    log("Filling shipper information...");
    await safeFill(page,  '#shipperName, input[name="shipperName"]', invoice.shipper?.name || "");
    await safeFill(page,  '#shipperAddress, input[name="shipperAddress"]', invoice.shipper?.address || "");
    await safeFill(page,  '#shipperCity, input[name="shipperCity"]', invoice.shipper?.city || "");
    await safeFill(page,  '#shipperZip, input[name="shipperZip"]', invoice.shipper?.zip || "");
    await safeSelect(page,'#shipperCountry, select[name="shipperCountry"]', invoice.shipper?.country || "");

    log("Filling consignee information...");
    await safeFill(page,  '#consigneeName, input[name="consigneeName"]', invoice.consignee?.name || "");
    await safeFill(page,  '#consigneeAddress, input[name="consigneeAddress"]', invoice.consignee?.address || "");
    await safeFill(page,  '#consigneeCity, input[name="consigneeCity"]', invoice.consignee?.city || "");
    await safeFill(page,  '#consigneeZip, input[name="consigneeZip"]', invoice.consignee?.zip || "");
    await safeSelect(page,'#consigneeCountry, select[name="consigneeCountry"]', invoice.consignee?.country || "US");

    log("Filling transport information...");
    await safeFill(page, '#carrier, input[name="carrier"]', "FedEx");
    await safeFill(page, '#billOfLading, input[name="trackingNumber"]', invoice.trackingNumber || invoice.invoiceNumber || "");
    const arrivalDate = invoice.estimatedArrival || new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];
    await safeFill(page, 'input[type="date"][name*="arrival"], #arrivalDate', arrivalDate);
    await safeFill(page, '#portOfEntry, input[name="portOfEntry"]', invoice.portOfEntry || "");

    log("Submitting...");
    await page.click('button[type="submit"]:has-text("Submit"), input[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle" });

    const body  = await page.textContent("body");
    const match = body.match(/Prior Notice (?:Number|#)[:\s]+([A-Z0-9\-]+)/i)
      || body.match(/Confirmation[:\s#]+([A-Z0-9\-]+)/i);
    const confirmationNumber = match?.[1] || "Submitted — check PNC portal";
    log(`✅ PNC# ${confirmationNumber}`);

    // Clean up session
    delete sessions[sessionId];
    await browser.close();

    res.json({ success: true, confirmationNumber, logs });

  } catch (err) {
    log(`❌ ${err.message}`);
    res.status(500).json({ success: false, error: err.message, logs });
  }
});

// ─── ROUTE 4: Submit all PNCs in one session ──────────────────────────────────
app.post("/submit-all-pnc", async (req, res) => {
  const { sessionId, invoices } = req.body;
  if (!sessionId || !invoices?.length)
    return res.status(400).json({ error: "sessionId and invoices[] required" });

  const session = sessions[sessionId];
  if (!session)
    return res.status(404).json({ error: "Session not found or expired" });

  if (session.status !== "logged_in")
    return res.status(400).json({ error: "Not logged in yet" });

  const results = [];

  for (const invoice of invoices.filter((i) => i.needsPNC)) {
    const logs = [];
    const log  = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };
    const { page } = session;

    try {
      log("Opening new Prior Notice...");
      await page.click([
        'a[href*="create"]', 'a[href*="newPriorNotice"]',
        'button:has-text("New")', 'a:has-text("Create Prior Notice")',
      ].join(", "));
      await page.waitForNavigation({ waitUntil: "networkidle" });

      const item = invoice.items?.[0] || {};
      await safeFill(page,  '#articleDescription, input[name="articleDescription"]', item.description || "");
      await safeFill(page,  '#quantity, input[name="quantity"]', String(item.quantity || 1));
      await safeSelect(page,'#quantityUOM, select[name="quantityUOM"]', item.quantityUnit || "EACH");
      await safeFill(page,  '#harmonizedCode, input[name="hsCode"]', item.hsCode || "");
      await safeSelect(page,'#countryOfOrigin, select[name="countryOfOrigin"]', item.countryOfOrigin || "");
      await safeFill(page,  '#shipperName, input[name="shipperName"]', invoice.shipper?.name || "");
      await safeFill(page,  '#shipperAddress, input[name="shipperAddress"]', invoice.shipper?.address || "");
      await safeFill(page,  '#shipperCity, input[name="shipperCity"]', invoice.shipper?.city || "");
      await safeSelect(page,'#shipperCountry, select[name="shipperCountry"]', invoice.shipper?.country || "");
      await safeFill(page,  '#consigneeName, input[name="consigneeName"]', invoice.consignee?.name || "");
      await safeFill(page,  '#consigneeAddress, input[name="consigneeAddress"]', invoice.consignee?.address || "");
      await safeFill(page,  '#consigneeCity, input[name="consigneeCity"]', invoice.consignee?.city || "");
      await safeSelect(page,'#consigneeCountry, select[name="consigneeCountry"]', invoice.consignee?.country || "US");
      await safeFill(page,  '#carrier, input[name="carrier"]', "FedEx");
      await safeFill(page,  '#billOfLading, input[name="trackingNumber"]', invoice.trackingNumber || "");
      const arrivalDate = invoice.estimatedArrival || new Date(Date.now() + 3 * 86400000).toISOString().split("T")[0];
      await safeFill(page,  'input[type="date"][name*="arrival"], #arrivalDate', arrivalDate);

      await page.click('button[type="submit"]:has-text("Submit"), input[type="submit"]');
      await page.waitForNavigation({ waitUntil: "networkidle" });

      const body  = await page.textContent("body");
      const match = body.match(/Prior Notice (?:Number|#)[:\s]+([A-Z0-9\-]+)/i);
      const confirmationNumber = match?.[1] || "Submitted";
      log(`✅ PNC# ${confirmationNumber}`);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: true, confirmationNumber, logs });

    } catch (err) {
      log(`❌ ${err.message}`);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: false, error: err.message, logs });
    }
  }

  // Clean up
  delete sessions[sessionId];
  await session.browser.close();

  res.json({ results });
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
