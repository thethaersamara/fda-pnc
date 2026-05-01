require("dotenv").config();
const express      = require("express");
const cors         = require("cors");
const { chromium } = require("playwright");

const app      = express();
const PORT     = process.env.PORT || 3001;
const HEADLESS = process.env.HEADLESS !== "false";

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cors({ origin: "*", methods: ["GET", "POST", "OPTIONS"], allowedHeaders: ["Content-Type", "Authorization"] }));
app.options("*", cors());

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

app.get("/health", (_, res) => res.json({ ok: true }));

app.post("/start-login", async (req, res) => {
  const { sessionId, fdaUsername, fdaPassword } = req.body;
  if (!sessionId || !fdaUsername || !fdaPassword)
    return res.status(400).json({ error: "sessionId, fdaUsername, fdaPassword required" });

  const browser = await chromium.launch({ headless: HEADLESS });
  const page    = await (await browser.newContext()).newPage();

  try {
    await page.goto(https://www.access.fda.gov", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    await page.check('input[type="checkbox"]').catch(() => {});
    await page.waitForTimeout(1000);

    await page.click('button.btn, button[type="button"], button');
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    await safeFill(page, 'input[name="accountId"], input[name="username"], input[type="text"]', fdaUsername);
    await page.waitForTimeout(500);
    await page.click('button[type="submit"], input[type="submit"], button');
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    await safeFill(page, 'input[name="password"], input[type="password"]', fdaPassword);
    await page.waitForTimeout(500);
    await page.click('button[type="submit"], input[type="submit"], button');
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    await page.click('button:has-text("Send Code"), button[type="submit"], button').catch(() => {});
    await page.waitForTimeout(3000);

    sessions[sessionId] = { browser, page, status: "awaiting_otp" };
    res.json({ success: true, status: "awaiting_otp" });

  } catch (err) {
    await browser.close();
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/submit-otp", async (req, res) => {
  const { sessionId, otp } = req.body;
  if (!sessionId || !otp)
    return res.status(400).json({ error: "sessionId and otp required" });

  const session = sessions[sessionId];
  if (!session)
    return res.status(404).json({ error: "Session not found or expired" });

  try {
    await safeFill(session.page, 'input[name="otp"], input[name="code"], input[name="verificationCode"], input[type="text"]', otp);
    await session.page.click('button[type="submit"], input[type="submit"], button');
    await session.page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    session.status = "logged_in";
    res.json({ success: true, status: "logged_in" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/submit-pnc", async (req, res) => {
  const { sessionId, invoice } = req.body;
  if (!sessionId || !invoice)
    return res.status(400).json({ error: "sessionId and invoice required" });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found or expired" });
  if (session.status !== "logged_in") return res.status(400).json({ error: "Not logged in yet" });

  const { page, browser } = session;
  const logs = [];
  const log  = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };

  try {
    log("Opening new Prior Notice...");
    await page.click('button:has-text("Create New Prior Notice"), a:has-text("Create New Prior Notice")');
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.click('button:has-text("Consumption")').catch(() => {});
    await page.waitForTimeout(1000);

    log("Filling form...");
    const item = invoice.items?.[0] || {};
    await safeFill(page, '#articleDescription, input[name="articleDescription"]', item.description || "");
    await safeFill(page, '#quantity, input[name="quantity"]', String(item.quantity || 1));
    await safeFill(page, '#harmonizedCode, input[name="hsCode"]', item.hsCode || "");
    await safeFill(page, '#shipperName, input[name="shipperName"]', invoice.shipper?.name || "");
    await safeFill(page, '#shipperAddress, input[name="shipperAddress"]', invoice.shipper?.address || "");
    await safeFill(page, '#shipperCity, input[name="shipperCity"]', invoice.shipper?.city || "");
    await safeFill(page, '#consigneeName, input[name="consigneeName"]', invoice.consignee?.name || "");
    await safeFill(page, '#consigneeAddress, input[name="consigneeAddress"]', invoice.consignee?.address || "");
    await safeFill(page, '#consigneeCity, input[name="consigneeCity"]', invoice.consignee?.city || "");
    await safeFill(page, '#carrier, input[name="carrier"]', "FedEx");
    await safeFill(page, '#billOfLading, input[name="trackingNumber"]', invoice.trackingNumber || invoice.invoiceNumber || "");

    log("Submitting...");
    await page.click('button:has-text("Submit to FDA"), button:has-text("Submit")');
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });

    const body  = await page.textContent("body");
    const match = body.match(/Prior Notice (?:Number|#|Confirmation)[:\s]+([A-Z0-9\-]+)/i);
    const confirmationNumber = match?.[1] || "Submitted — check PNC portal";
    log(`✅ PNC# ${confirmationNumber}`);

    delete sessions[sessionId];
    await browser.close();
    res.json({ success: true, confirmationNumber, logs });

  } catch (err) {
    log(`❌ ${err.message}`);
    res.status(500).json({ success: false, error: err.message, logs });
  }
});

app.post("/submit-all-pnc", async (req, res) => {
  const { sessionId, invoices } = req.body;
  if (!sessionId || !invoices?.length)
    return res.status(400).json({ error: "sessionId and invoices[] required" });

  const session = sessions[sessionId];
  if (!session) return res.status(404).json({ error: "Session not found or expired" });
  if (session.status !== "logged_in") return res.status(400).json({ error: "Not logged in yet" });

  const results = [];
  for (const invoice of invoices.filter((i) => i.needsPNC)) {
    const logs = [];
    const log  = (msg) => { console.log(`[PNC] ${msg}`); logs.push(msg); };
    const { page } = session;
    try {
      log("Opening new Prior Notice...");
      await page.click('button:has-text("Create New Prior Notice"), a:has-text("Create New Prior Notice")');
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });
      await page.click('button:has-text("Consumption")').catch(() => {});
      await page.waitForTimeout(1000);

      const item = invoice.items?.[0] || {};
      await safeFill(page, '#articleDescription, input[name="articleDescription"]', item.description || "");
      await safeFill(page, '#quantity, input[name="quantity"]', String(item.quantity || 1));
      await safeFill(page, '#harmonizedCode, input[name="hsCode"]', item.hsCode || "");
      await safeFill(page, '#shipperName, input[name="shipperName"]', invoice.shipper?.name || "");
      await safeFill(page, '#consigneeName, input[name="consigneeName"]', invoice.consignee?.name || "");
      await safeFill(page, '#carrier, input[name="carrier"]', "FedEx");
      await safeFill(page, '#billOfLading, input[name="trackingNumber"]', invoice.trackingNumber || "");

      await page.click('button:has-text("Submit to FDA"), button:has-text("Submit")');
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 });

      const body  = await page.textContent("body");
      const match = body.match(/Prior Notice (?:Number|#|Confirmation)[:\s]+([A-Z0-9\-]+)/i);
      const confirmationNumber = match?.[1] || "Submitted";
      log(`✅ PNC# ${confirmationNumber}`);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: true, confirmationNumber, logs });
    } catch (err) {
      log(`❌ ${err.message}`);
      results.push({ invoiceNumber: invoice.invoiceNumber, success: false, error: err.message, logs });
    }
  }

  delete sessions[sessionId];
  await session.browser.close();
  res.json({ results });
});

app.listen(PORT, () => console.log(`🚀 http://localhost:${PORT}`));
