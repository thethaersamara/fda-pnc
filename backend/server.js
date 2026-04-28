require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const { chromium } = require("playwright");

const app      = express();
const PORT     = process.env.PORT || 3001;
const HEADLESS = process.env.HEADLESS !== "false";

app.use(cors());
app.use(express.json({ limit: "10mb" }));

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

async function submitPNC(invoice, fdaUser, fdaPass, logCb) {
  const log = (msg) => { console.log(`[PNC] ${msg}`); logCb(msg); };

  const browser = await chromium.launch({ headless: HEADLESS });
  const page    = await (await browser.newContext()).newPage();

  try {
    log("Navigating to FDA PNC login...");
    await page.goto("https://pnc.access.fda.gov/pnc/login", { waitUntil: "networkidle" });
    await safeFill(page, '#username, input[name="username"]', fdaUser);
    await safeFill(page, '#password, input[name="password"]', fdaPass);
    await page.click('button[type="submit"], input[type="submit"]');
    await page.waitForNavigation({ waitUntil: "networkidle" });
    log("Logged in.");

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
    return { success: true, confirmationNumber };

  } catch (err) {
    log(`❌ ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    await browser.close();
  }
}

app.post("/submit-pnc", async (req, res) => {
  const { invoice, fdaUsername, fdaPassword } = req.body;
  if (!invoice || !fdaUsername || !fdaPassword)
    return res.status(400).json({ error: "invoice, fdaUsername, fdaPassword required" });
  const logs = [];
  const result = await submitPNC(invoice, fdaUsername, fdaPassword, (m) => logs.push(m));
  res.json({ ...result, logs });
});

app.post("/submit-all-pnc", async (req, res) => {
  const { invoices, fdaUsername, fdaPassword } = req.body;
  if (!invoices?.length || !fdaUsername || !fdaPassword)
    return res.status(400).json({ error: "invoices[], fdaUsername, fdaPassword required" });
  const results = [];
  for (const invoice of invoices) {
    const logs = [];
    const r = await submitPNC(invoice, fdaUsername, fdaPassword, (m) => logs.push(m));
    results.push({ invoiceNumber: invoice.invoiceNumber, ...r, logs });
  }
  res.json({ results });
});

app.get("/health", (_, res) => res.json({ ok: true }));
app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
